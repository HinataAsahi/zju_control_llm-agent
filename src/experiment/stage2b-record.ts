import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type {
  AgentLimits,
  AgentRunError,
  AgentRunStatus
} from '../agent/agent-loop.js';
import type { ModelHistoryItem, ModelUsage } from '../agent/model-client.js';
import type { ExperimentAnswer, ExperimentCondition } from './schema.js';

export type Stage2bToolEvent = Extract<
  ModelHistoryItem,
  { type: 'function_call' | 'function_call_output' }
>;

export type Stage2bTaskId = 'T1' | 'T2' | 'T6' | 'T7';

export function createStage2bRunId(
  taskId: Stage2bTaskId,
  condition: ExperimentCondition,
  date: Date
): string {
  const timestamp = date.toISOString().replace(/[-:.]/g, '').replace('Z', 'Z');
  return `stage2b-${taskId}-${condition}-${timestamp}-${randomBytes(4).toString('hex')}`;
}

export function isStage2bRunId(runId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId) && runId !== '.' && runId !== '..';
}

export interface Stage2bRecord {
  version: 1;
  runId: string;
  startedAt: string;
  provider: 'deepseek';
  model: 'deepseek-v4-flash';
  thinking: 'none';
  taskId: Stage2bTaskId;
  condition: ExperimentCondition;
  status: AgentRunStatus;
  taskSuccess: boolean | null;
  recoverySuccess: boolean | null;
  limits: AgentLimits;
  turns: number;
  toolCalls: number;
  toolEvents: Stage2bToolEvent[];
  finalAnswer?: ExperimentAnswer;
  usage: ModelUsage;
  durationMs: number;
  error?: AgentRunError;
}

export async function writeStage2bRecord(
  repositoryRoot: string,
  record: Stage2bRecord
): Promise<string> {
  validateRunId(record.runId);
  const serialized = `${JSON.stringify(record, null, 2)}\n`;
  validateRecordText(serialized);

  const localRoot = resolve(repositoryRoot, '.experiment-runs');
  const stageRoot = join(localRoot, 'stage-2b');
  const recordRoot = join(stageRoot, record.runId);
  await ensurePrivateDirectory(localRoot);
  await ensurePrivateDirectory(stageRoot);
  await ensurePrivateDirectory(recordRoot);

  const destination = join(recordRoot, 'record.json');
  const temporary = join(recordRoot, `.record-${randomBytes(8).toString('hex')}.tmp`);
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

async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`Unsafe Stage 2B record directory: ${path}`);
  }
  await chmod(path, 0o700);
}

function validateRunId(runId: string): void {
  if (!isStage2bRunId(runId)) {
    throw new Error(`Unsafe run ID: ${runId}`);
  }
}

function validateRecordText(text: string): void {
  if (
    /DEEPSEEK_API_KEY/i.test(text)
    || /Authorization\s*[:=]/i.test(text)
    || /Bearer\s+[A-Za-z0-9._-]+/i.test(text)
    || /\bsk-[A-Za-z0-9_-]{12,}\b/.test(text)
  ) {
    throw new Error('Stage 2B record contains sensitive credential material.');
  }
  if (/\/(?:home|Users)\/[^\s"']+/.test(text)) {
    throw new Error('Stage 2B record contains a user-home absolute path.');
  }
}
