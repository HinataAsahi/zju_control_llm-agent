import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rmdir, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import * as z from 'zod/v4';
import { STAGE2B_LIMITS } from '../agent/agent-loop.js';
import { DEEPSEEK_MODEL, DEEPSEEK_TEMPERATURE } from '../agent/deepseek-client.js';
import {
  createStage2bRunId,
  isStage2bRunId,
  type Stage2bRecord
} from './stage2b-record.js';
import {
  createStage2bPlan,
  STAGE2B_PLAN_MAX_REPETITIONS
} from './stage2b-plan.js';
import {
  expandStage2bSuite,
  STAGE2B_TASK_IDS,
  type Stage2bSuiteId
} from './stage2b-suite.js';
import { loadStage2bSkillAsset } from './stage2b-treatment.js';

export type Stage2bBatchRunStatus = 'pending' | 'running' | 'completed' | 'failed';

const batchIdSchema = z.string().regex(/^stage2b-batch-[A-Za-z0-9._-]+$/);
const createdAtSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
const samplingSchema = z.strictObject({
  temperature: z.number().min(0).max(2).nullable()
});
const repetitionsSchema = z.number().int().min(1).max(STAGE2B_PLAN_MAX_REPETITIONS);
const conditionSchema = z.enum(['explicit', 'description', 'skill', 'skill-v1', 'skill-v2']);
const taskIdSchema = z.enum(STAGE2B_TASK_IDS);

const runIdentityShape = {
  runKey: z.string().regex(/^T(?:1|2|6|7|9|10|11|12|13|14|15|16|17)-(?:explicit|description|skill|skill-v1|skill-v2)-r[1-9]\d*$/),
  taskId: taskIdSchema,
  condition: conditionSchema,
  repetition: repetitionsSchema
};

const pendingBatchRunSchema = z.strictObject({
  ...runIdentityShape,
  status: z.literal('pending')
});

const runningBatchRunSchema = z.strictObject({
  ...runIdentityShape,
  status: z.literal('running'),
  recordRunId: z.string().refine(isStage2bRunId)
});

const terminalBatchRunSchema = z.strictObject({
  ...runIdentityShape,
  status: z.enum(['completed', 'failed']),
  recordRunId: z.string().refine(isStage2bRunId),
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

const stage2bLimitsSchema = z.strictObject({
  maxTurns: z.number().int().min(1).max(STAGE2B_LIMITS.maxTurns),
  maxToolCalls: z.number().int().min(1).max(STAGE2B_LIMITS.maxToolCalls),
  requestTimeoutMs: z.literal(STAGE2B_LIMITS.requestTimeoutMs),
  totalTimeoutMs: z.literal(STAGE2B_LIMITS.totalTimeoutMs)
}).refine(
  limits => limits.maxTurns === limits.maxToolCalls + 1,
  { message: 'Stage 2B limits must reserve one final-answer turn.' }
);

const stage2bBatchRunSchema = z.discriminatedUnion('status', [
  pendingBatchRunSchema,
  runningBatchRunSchema,
  terminalBatchRunSchema
]);

const sharedManifestShape = {
  batchId: batchIdSchema,
  createdAt: createdAtSchema,
  provider: z.literal('deepseek'),
  model: z.literal(DEEPSEEK_MODEL),
  thinking: z.literal('none'),
  repetitions: repetitionsSchema,
  totalRuns: z.number().int().min(1),
  limits: stage2bLimitsSchema,
  runs: z.array(stage2bBatchRunSchema)
};

const stage2bBatchManifestV1Schema = z.strictObject({
  version: z.literal(1),
  ...sharedManifestShape,
  sampling: samplingSchema.default({ temperature: null })
});

const stage2bBatchManifestV2Schema = z.strictObject({
  version: z.literal(2),
  suite: z.enum(['baseline-v1', 'diagnostic-v1']),
  ...sharedManifestShape,
  sampling: samplingSchema
});

const skillIdentitySchema = z.strictObject({
  version: z.enum(['v1', 'v2']),
  sha256: z.string().regex(/^[a-f0-9]{64}$/)
});

const stage2bBatchManifestV3Schema = z.strictObject({
  version: z.literal(3),
  suite: z.literal('boundary-v1'),
  skills: z.strictObject({
    v1: skillIdentitySchema.extend({ version: z.literal('v1') }),
    v2: skillIdentitySchema.extend({ version: z.literal('v2') })
  }),
  ...sharedManifestShape,
  sampling: samplingSchema
});

const stage2bBatchManifestSchema = z.discriminatedUnion('version', [
  stage2bBatchManifestV1Schema,
  stage2bBatchManifestV2Schema,
  stage2bBatchManifestV3Schema
]).superRefine((manifest, context) => {
  const expected = expandStage2bSuite(
    stage2bManifestSuite(manifest),
    manifest.repetitions
  );
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
  | z.infer<typeof runningBatchRunSchema>
  | z.infer<typeof terminalBatchRunSchema>;
export type Stage2bBatchManifest = z.infer<typeof stage2bBatchManifestSchema>;

export function stage2bManifestSuite(manifest: Stage2bBatchManifest): Stage2bSuiteId {
  return manifest.version === 1 ? 'baseline-v1' : manifest.suite;
}

export async function prepareStage2bBatch(options: {
  repositoryRoot: string;
  suite: Stage2bSuiteId;
  repetitions: number;
  createdAt: Date;
}): Promise<{ manifest: Stage2bBatchManifest; manifestPath: string }> {
  const plan = createStage2bPlan(options.repetitions, options.suite);
  const batchId = createBatchId(options.createdAt);
  const shared = {
    batchId,
    createdAt: options.createdAt.toISOString(),
    provider: 'deepseek',
    model: DEEPSEEK_MODEL,
    thinking: 'none',
    sampling: { temperature: DEEPSEEK_TEMPERATURE },
    repetitions: plan.repetitions,
    totalRuns: plan.totalRuns,
    limits: { ...STAGE2B_LIMITS },
    runs: plan.runs.map(run => ({
      runKey: `${run.taskId}-${run.condition}-r${run.repetition}`,
      ...run,
      status: 'pending'
    }))
  };
  let rawManifest: unknown;
  if (options.suite === 'boundary-v1') {
    const [v1, v2] = await Promise.all([
      loadStage2bSkillAsset(options.repositoryRoot, 'skill-v1'),
      loadStage2bSkillAsset(options.repositoryRoot, 'skill-v2')
    ]);
    if (!v1 || !v2) throw new Error('Stage 2B boundary skill assets are unavailable.');
    rawManifest = {
      version: 3,
      suite: 'boundary-v1',
      skills: { v1: v1.identity, v2: v2.identity },
      ...shared
    };
  } else {
    rawManifest = {
      version: 2,
      suite: options.suite,
      ...shared
    };
  }
  const manifest = stage2bBatchManifestSchema.parse(rawManifest);
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

export async function claimNextStage2bBatchRun(options: {
  repositoryRoot: string;
  batchId: string;
  claimedAt: Date;
}): Promise<{
  manifest: Stage2bBatchManifest;
  manifestPath: string;
  run?: Extract<Stage2bBatchRun, { status: 'running' }>;
}> {
  return withStage2bBatchLock(options.repositoryRoot, options.batchId, async () => {
    const loaded = await readStage2bBatchManifest(options.repositoryRoot, options.batchId);
    if (loaded.manifest.runs.some(run => run.status === 'running')) {
      throw new Error('Stage 2B batch already has a running item.');
    }
    const selected = nextPendingStage2bBatchRun(loaded.manifest);
    if (!selected) return loaded;

    const running: Extract<Stage2bBatchRun, { status: 'running' }> = {
      ...selected,
      status: 'running',
      recordRunId: createStage2bRunId(selected.taskId, selected.condition, options.claimedAt)
    };
    const runs = loaded.manifest.runs.map(run => run.runKey === selected.runKey ? running : run);
    const manifest = stage2bBatchManifestSchema.parse({ ...loaded.manifest, runs });
    await replaceStage2bBatchManifest(loaded.manifestPath, manifest);
    return { manifest, manifestPath: loaded.manifestPath, run: running };
  });
}

async function withStage2bBatchLock<T>(
  repositoryRoot: string,
  batchId: string,
  operation: () => Promise<T>
): Promise<T> {
  const manifestPath = await existingManifestPath(repositoryRoot, batchId);
  const lockPath = join(dirname(manifestPath), '.manifest.lock');
  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch (error) {
    if (isErrno(error, 'EEXIST')) throw new Error('Stage 2B batch is busy.');
    throw error;
  }
  try {
    const metadata = await lstat(lockPath);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error('Unsafe Stage 2B batch lock.');
    }
    await chmod(lockPath, 0o700);
    return await operation();
  } finally {
    await rmdir(lockPath);
  }
}

export async function reconcileStage2bBatch(
  repositoryRoot: string,
  batchId: string
): Promise<{
  manifest: Stage2bBatchManifest;
  manifestPath: string;
  recoveredRunKeys: string[];
  unresolvedRunKeys: string[];
}> {
  const loaded = await readStage2bBatchManifest(repositoryRoot, batchId);
  const recoveredRunKeys: string[] = [];
  const unresolvedRunKeys: string[] = [];
  const runs: Stage2bBatchRun[] = [];
  for (const run of loaded.manifest.runs) {
    if (run.status !== 'running') {
      runs.push(run);
      continue;
    }
    const record = await readOptionalRecordSummary(repositoryRoot, run.recordRunId);
    if (!record) {
      unresolvedRunKeys.push(run.runKey);
      runs.push(run);
      continue;
    }
    if (record.taskId !== run.taskId || record.condition !== run.condition) {
      throw new Error('Stage 2B persisted record does not match its running batch item.');
    }
    validateRecordSkillIdentity(loaded.manifest, run, record);
    recoveredRunKeys.push(run.runKey);
    runs.push(terminalBatchRun(run, record));
  }
  const manifest = recoveredRunKeys.length === 0
    ? loaded.manifest
    : stage2bBatchManifestSchema.parse({ ...loaded.manifest, runs });
  if (recoveredRunKeys.length > 0) {
    await replaceStage2bBatchManifest(loaded.manifestPath, manifest);
  }
  return {
    manifest,
    manifestPath: loaded.manifestPath,
    recoveredRunKeys,
    unresolvedRunKeys
  };
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
  if (!selected || selected.status !== 'running') {
    throw new Error('Stage 2B batch run is not running.');
  }
  if (
    selected.recordRunId !== options.record.runId
    || selected.taskId !== options.record.taskId
    || selected.condition !== options.record.condition
  ) {
    throw new Error('Stage 2B record does not match the selected batch run.');
  }
  validateRecordSkillIdentity(loaded.manifest, selected, options.record);

  const terminal = terminalBatchRun(selected, options.record);
  const runs = [...loaded.manifest.runs];
  runs[index] = terminal;
  const manifest = stage2bBatchManifestSchema.parse({ ...loaded.manifest, runs });
  await replaceStage2bBatchManifest(loaded.manifestPath, manifest);
  return { manifest, manifestPath: loaded.manifestPath };
}

function terminalBatchRun(
  selected: Extract<Stage2bBatchRun, { status: 'running' }>,
  record: Pick<
    Stage2bRecord,
    'runId' | 'status' | 'taskSuccess' | 'recoverySuccess'
  >
): Extract<Stage2bBatchRun, { status: 'completed' | 'failed' }> {
  return {
    runKey: selected.runKey,
    taskId: selected.taskId,
    condition: selected.condition,
    repetition: selected.repetition,
    status: record.status === 'completed' ? 'completed' : 'failed',
    recordRunId: record.runId,
    recordStatus: record.status,
    taskSuccess: record.taskSuccess,
    recoverySuccess: record.recoverySuccess
  };
}

async function readOptionalRecordSummary(
  repositoryRoot: string,
  runId: string
): Promise<Pick<
  Stage2bRecord,
  'version' | 'runId' | 'taskId' | 'condition' | 'skill' | 'status' | 'taskSuccess' | 'recoverySuccess'
> | undefined> {
  if (!isStage2bRunId(runId)) throw new Error('Unsafe Stage 2B record run ID.');
  const stageRoot = resolve(repositoryRoot, '.experiment-runs/stage-2b');
  const recordRoot = join(stageRoot, runId);
  const recordPath = join(recordRoot, 'record.json');
  try {
    await validatePrivateDirectory(stageRoot, 'stage');
    await validatePrivateDirectory(recordRoot, 'record');
    await validateRegularFile(recordPath, 'record');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  }
  const text = await readRegularText(recordPath);
  validateManifestText(text);
  const summary = z.object({
    version: z.union([z.literal(1), z.literal(2)]),
    runId: z.string().refine(isStage2bRunId),
    taskId: taskIdSchema,
    condition: conditionSchema,
    skill: skillIdentitySchema.nullable().optional(),
    status: z.enum([
      'completed',
      'infrastructure-error',
      'protocol-error',
      'model-output-error',
      'limit-exceeded'
    ]),
    taskSuccess: z.boolean().nullable(),
    recoverySuccess: z.boolean().nullable()
  }).parse(JSON.parse(text));
  if (summary.runId !== runId) throw new Error('Stage 2B record ID does not match its path.');
  return {
    version: summary.version,
    runId: summary.runId,
    taskId: summary.taskId,
    condition: summary.condition,
    ...(summary.skill === undefined ? {} : { skill: summary.skill }),
    status: summary.status,
    taskSuccess: summary.taskSuccess,
    recoverySuccess: summary.recoverySuccess
  };
}

function validateRecordSkillIdentity(
  manifest: Stage2bBatchManifest,
  run: Pick<Stage2bBatchRun, 'condition'>,
  record: Pick<Stage2bRecord, 'version' | 'skill'>
): void {
  if (manifest.version !== 3) return;
  const expected = run.condition === 'skill-v1'
    ? manifest.skills.v1
    : run.condition === 'skill-v2'
      ? manifest.skills.v2
      : null;
  const actual = record.skill ?? null;
  if (
    record.version !== 2
    || (expected === null
      ? actual !== null
      : actual === null
        || actual.version !== expected.version
        || actual.sha256 !== expected.sha256)
  ) {
    throw new Error('Stage 2B record skill identity does not match its batch manifest.');
  }
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

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
