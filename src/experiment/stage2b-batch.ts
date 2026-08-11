import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { STAGE2B_LIMITS, type AgentLimits } from '../agent/agent-loop.js';
import { DEEPSEEK_MODEL } from '../agent/deepseek-client.js';
import type { ExperimentCondition } from './schema.js';
import { createStage2bPlan } from './stage2b-plan.js';

export type Stage2bBatchRunStatus = 'pending' | 'completed' | 'failed';

export interface Stage2bBatchRun {
  runKey: string;
  taskId: 'T2' | 'T7';
  condition: ExperimentCondition;
  repetition: number;
  status: Stage2bBatchRunStatus;
}

export interface Stage2bBatchManifest {
  version: 1;
  batchId: string;
  createdAt: string;
  provider: 'deepseek';
  model: typeof DEEPSEEK_MODEL;
  thinking: 'none';
  repetitions: number;
  totalRuns: number;
  limits: AgentLimits;
  runs: Stage2bBatchRun[];
}

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

async function writeStage2bBatchManifest(
  repositoryRoot: string,
  manifest: Stage2bBatchManifest
): Promise<string> {
  validateBatchId(manifest.batchId);
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
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
  const temporary = join(batchRoot, `.manifest-${randomBytes(8).toString('hex')}.tmp`);
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
    return destination;
  } finally {
    if (created) await unlink(temporary).catch(() => undefined);
  }
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

function createBatchId(date: Date): string {
  const timestamp = date.toISOString().replace(/[-:.]/g, '').replace('Z', 'Z');
  return `stage2b-batch-${timestamp}-${randomBytes(4).toString('hex')}`;
}

function validateBatchId(batchId: string): void {
  if (!/^stage2b-batch-[A-Za-z0-9._-]+$/.test(batchId)) {
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
