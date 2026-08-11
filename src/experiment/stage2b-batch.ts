import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import * as z from 'zod/v4';
import { STAGE2B_LIMITS } from '../agent/agent-loop.js';
import { DEEPSEEK_MODEL } from '../agent/deepseek-client.js';
import type { Stage2bRecord } from './stage2b-record.js';
import {
  createStage2bPlan,
  STAGE2B_PLAN_MAX_REPETITIONS
} from './stage2b-plan.js';

export type Stage2bBatchRunStatus = 'pending' | 'completed' | 'failed';

const runIdentityShape = {
  runKey: z.string().regex(/^T[27]-(?:explicit|description|skill)-r[1-9]\d*$/),
  taskId: z.enum(['T2', 'T7']),
  condition: z.enum(['explicit', 'description', 'skill']),
  repetition: z.number().int().min(1).max(STAGE2B_PLAN_MAX_REPETITIONS)
};

const pendingBatchRunSchema = z.strictObject({
  ...runIdentityShape,
  status: z.literal('pending')
});

const terminalBatchRunSchema = z.strictObject({
  ...runIdentityShape,
  status: z.enum(['completed', 'failed']),
  recordRunId: z.string().regex(/^stage2b-[A-Za-z0-9._-]+$/),
  recordStatus: z.enum([
    'completed',
    'infrastructure-error',
    'protocol-error',
    'model-output-error',
    'limit-exceeded'
  ]),
  taskSuccess: z.boolean().nullable(),
  recoverySuccess: z.boolean().nullable()
});

const stage2bBatchManifestSchema = z.strictObject({
  version: z.literal(1),
  batchId: z.string().regex(/^stage2b-batch-[A-Za-z0-9._-]+$/),
  createdAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
  provider: z.literal('deepseek'),
  model: z.literal(DEEPSEEK_MODEL),
  thinking: z.literal('none'),
  repetitions: z.number().int().min(1).max(STAGE2B_PLAN_MAX_REPETITIONS),
  totalRuns: z.number().int().min(1),
  limits: z.strictObject({
    maxTurns: z.literal(STAGE2B_LIMITS.maxTurns),
    maxToolCalls: z.literal(STAGE2B_LIMITS.maxToolCalls),
    requestTimeoutMs: z.literal(STAGE2B_LIMITS.requestTimeoutMs),
    totalTimeoutMs: z.literal(STAGE2B_LIMITS.totalTimeoutMs)
  }),
  runs: z.array(z.discriminatedUnion('status', [
    pendingBatchRunSchema,
    terminalBatchRunSchema
  ]))
}).superRefine((manifest, context) => {
  const expected = createStage2bPlan(manifest.repetitions).runs;
  if (manifest.totalRuns !== expected.length || manifest.runs.length !== expected.length) {
    context.addIssue({ code: 'custom', path: ['totalRuns'], message: 'Batch size mismatch.' });
    return;
  }
  for (let index = 0; index < expected.length; index += 1) {
    const planned = expected[index];
    const actual = manifest.runs[index];
    if (
      !planned
      || !actual
      || actual.taskId !== planned.taskId
      || actual.condition !== planned.condition
      || actual.repetition !== planned.repetition
      || actual.runKey !== `${planned.taskId}-${planned.condition}-r${planned.repetition}`
    ) {
      context.addIssue({ code: 'custom', path: ['runs', index], message: 'Batch plan mismatch.' });
    }
  }
});

export type Stage2bBatchRun = z.infer<typeof pendingBatchRunSchema>
  | z.infer<typeof terminalBatchRunSchema>;
export type Stage2bBatchManifest = z.infer<typeof stage2bBatchManifestSchema>;

export async function prepareStage2bBatch(options: {
  repositoryRoot: string;
  repetitions: number;
  createdAt: Date;
}): Promise<{ manifest: Stage2bBatchManifest; manifestPath: string }> {
  const plan = createStage2bPlan(options.repetitions);
  const batchId = createBatchId(options.createdAt);
  const manifest: Stage2bBatchManifest = {
    version: 1,
    batchId,
    createdAt: options.createdAt.toISOString(),
    provider: 'deepseek',
    model: DEEPSEEK_MODEL,
    thinking: 'none',
    repetitions: plan.repetitions,
    totalRuns: plan.totalRuns,
    limits: { ...STAGE2B_LIMITS },
    runs: plan.runs.map(run => ({
      runKey: `${run.taskId}-${run.condition}-r${run.repetition}`,
      ...run,
      status: 'pending'
    }))
  };
  const manifestPath = await writeStage2bBatchManifest(options.repositoryRoot, manifest);
  return { manifest, manifestPath };
}

export async function readStage2bBatchManifest(
  repositoryRoot: string,
  batchId: string
): Promise<{ manifest: Stage2bBatchManifest; manifestPath: string }> {
  validateBatchId(batchId);
  const manifestPath = await existingManifestPath(repositoryRoot, batchId);
  const text = await readRegularText(manifestPath);
  validateManifestText(text);
  const parsed: unknown = JSON.parse(text);
  const manifest = stage2bBatchManifestSchema.parse(parsed);
  if (manifest.batchId !== batchId) throw new Error('Stage 2B batch ID does not match its path.');
  return { manifest, manifestPath };
}

export function nextPendingStage2bBatchRun(
  manifest: Stage2bBatchManifest
): Extract<Stage2bBatchRun, { status: 'pending' }> | undefined {
  return manifest.runs.find(
    (run): run is Extract<Stage2bBatchRun, { status: 'pending' }> => run.status === 'pending'
  );
}

export async function recordStage2bBatchRun(options: {
  repositoryRoot: string;
  batchId: string;
  runKey: string;
  record: Stage2bRecord;
}): Promise<{ manifest: Stage2bBatchManifest; manifestPath: string }> {
  const loaded = await readStage2bBatchManifest(options.repositoryRoot, options.batchId);
  const index = loaded.manifest.runs.findIndex(run => run.runKey === options.runKey);
  const selected = loaded.manifest.runs[index];
  if (!selected || selected.status !== 'pending') {
    throw new Error('Stage 2B batch run is not pending.');
  }
  if (selected.taskId !== options.record.taskId || selected.condition !== options.record.condition) {
    throw new Error('Stage 2B record does not match the selected batch run.');
  }

  const terminal: Stage2bBatchRun = {
    runKey: selected.runKey,
    taskId: selected.taskId,
    condition: selected.condition,
    repetition: selected.repetition,
    status: options.record.status === 'completed' ? 'completed' : 'failed',
    recordRunId: options.record.runId,
    recordStatus: options.record.status,
    taskSuccess: options.record.taskSuccess,
    recoverySuccess: options.record.recoverySuccess
  };
  const runs = [...loaded.manifest.runs];
  runs[index] = terminal;
  const manifest = stage2bBatchManifestSchema.parse({ ...loaded.manifest, runs });
  await replaceStage2bBatchManifest(loaded.manifestPath, manifest);
  return { manifest, manifestPath: loaded.manifestPath };
}

async function writeStage2bBatchManifest(
  repositoryRoot: string,
  manifest: Stage2bBatchManifest
): Promise<string> {
  validateBatchId(manifest.batchId);
  const validated = stage2bBatchManifestSchema.parse(manifest);
  const serialized = `${JSON.stringify(validated, null, 2)}\n`;
  validateManifestText(serialized);

  const localRoot = resolve(repositoryRoot, '.experiment-runs');
  const stageRoot = join(localRoot, 'stage-2b');
  const batchesRoot = join(stageRoot, 'batches');
  await ensurePrivateDirectory(localRoot, 'local artifact');
  await ensurePrivateDirectory(stageRoot, 'stage');
  await ensurePrivateDirectory(batchesRoot, 'batch');

  const batchRoot = join(batchesRoot, manifest.batchId);
  await mkdir(batchRoot, { mode: 0o700 });
  const batchMetadata = await lstat(batchRoot);
  if (batchMetadata.isSymbolicLink() || !batchMetadata.isDirectory()) {
    throw new Error(`Unsafe Stage 2B batch directory: ${batchRoot}`);
  }
  await chmod(batchRoot, 0o700);

  const destination = join(batchRoot, 'manifest.json');
  await writeManifestAtomic(destination, serialized);
  return destination;
}

async function replaceStage2bBatchManifest(
  manifestPath: string,
  manifest: Stage2bBatchManifest
): Promise<void> {
  await validatePrivateDirectory(dirname(manifestPath), 'batch');
  await validateRegularFile(manifestPath, 'manifest');
  const serialized = `${JSON.stringify(stage2bBatchManifestSchema.parse(manifest), null, 2)}\n`;
  validateManifestText(serialized);
  await writeManifestAtomic(manifestPath, serialized);
}

async function writeManifestAtomic(destination: string, serialized: string): Promise<void> {
  const temporary = join(
    dirname(destination),
    `.manifest-${randomBytes(8).toString('hex')}.tmp`
  );
  let created = false;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    created = true;
    try {
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, destination);
    created = false;
    await chmod(destination, 0o600);
  } finally {
    if (created) await unlink(temporary).catch(() => undefined);
  }
}

async function existingManifestPath(repositoryRoot: string, batchId: string): Promise<string> {
  const localRoot = resolve(repositoryRoot, '.experiment-runs');
  const stageRoot = join(localRoot, 'stage-2b');
  const batchesRoot = join(stageRoot, 'batches');
  const batchRoot = join(batchesRoot, batchId);
  await validatePrivateDirectory(localRoot, 'local artifact');
  await validatePrivateDirectory(stageRoot, 'stage');
  await validatePrivateDirectory(batchesRoot, 'batch');
  await validatePrivateDirectory(batchRoot, 'batch');
  const manifestPath = join(batchRoot, 'manifest.json');
  await validateRegularFile(manifestPath, 'manifest');
  return manifestPath;
}

async function ensurePrivateDirectory(path: string, label: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`Unsafe Stage 2B ${label} directory: ${path}`);
  }
  await chmod(path, 0o700);
}

async function validatePrivateDirectory(path: string, label: string): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`Unsafe Stage 2B ${label} directory: ${path}`);
  }
}

async function validateRegularFile(path: string, label: string): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`Unsafe Stage 2B ${label} file: ${path}`);
  }
}

async function readRegularText(path: string): Promise<string> {
  const pathMetadata = await lstat(path, { bigint: true });
  if (pathMetadata.isSymbolicLink() || !pathMetadata.isFile()) {
    throw new Error(`Unsafe Stage 2B manifest file: ${path}`);
  }
  const noFollow = Reflect.get(constants, 'O_NOFOLLOW');
  const flags = constants.O_RDONLY | (typeof noFollow === 'number' ? noFollow : 0);
  const handle = await open(path, flags);
  try {
    const openedMetadata = await handle.stat({ bigint: true });
    if (
      !openedMetadata.isFile()
      || openedMetadata.dev !== pathMetadata.dev
      || openedMetadata.ino !== pathMetadata.ino
    ) {
      throw new Error('Stage 2B manifest changed while being opened.');
    }
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

function createBatchId(date: Date): string {
  const timestamp = date.toISOString().replace(/[-:.]/g, '').replace('Z', 'Z');
  return `stage2b-batch-${timestamp}-${randomBytes(4).toString('hex')}`;
}

export function isStage2bBatchId(batchId: string): boolean {
  return /^stage2b-batch-[A-Za-z0-9._-]+$/.test(batchId);
}

function validateBatchId(batchId: string): void {
  if (!isStage2bBatchId(batchId)) {
    throw new Error(`Unsafe Stage 2B batch ID: ${batchId}`);
  }
}

function validateManifestText(text: string): void {
  if (
    /DEEPSEEK_API_KEY/i.test(text)
    || /Authorization\s*[:=]/i.test(text)
    || /Bearer\s+[A-Za-z0-9._-]+/i.test(text)
    || /\bsk-[A-Za-z0-9_-]{12,}\b/.test(text)
    || /\/(?:home|Users)\/[^\s"']+/.test(text)
  ) {
    throw new Error('Stage 2B batch manifest contains sensitive or local path material.');
  }
}
