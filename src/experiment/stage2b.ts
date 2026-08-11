import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  runAgent,
  STAGE2B_LIMITS
} from '../agent/agent-loop.js';
import {
  createDeepSeekModelClient,
  DEEPSEEK_MODEL,
  requireDeepSeekApiKey
} from '../agent/deepseek-client.js';
import {
  McpToolBridge,
  type McpToolBridgeOptions
} from '../agent/mcp-tool-bridge.js';
import type { ModelTurnClient, ToolGateway } from '../agent/model-client.js';
import {
  answerMatchesExpected,
  diagnoseExperimentAnswer,
  parseExperimentAnswerText,
  type ExperimentTask
} from './schema.js';
import {
  writeStage2bRecord,
  type Stage2bRecord,
  type Stage2bToolEvent
} from './stage2b-record.js';
import { loadTasks } from './task-loader.js';
import { prepareWorkspace, type PreparedWorkspace } from './workspace.js';

export interface Stage2bDependencies {
  createModelClient(apiKey: string): ModelTurnClient;
  connectTools(options: McpToolBridgeOptions): Promise<ToolGateway>;
  now(): Date;
}

export interface Stage2bCommand {
  mode: 'smoke';
}

const STAGE2B_INSTRUCTIONS = [
  'Complete the task using the discovered MCP tools when applicable.',
  'After using tools, return only one JSON object with exactly these fields and no other fields:',
  '{"status":"completed","answer":"TASK_RESULT","explanation":"BRIEF_REASON"}',
  'Replace TASK_RESULT with the actual JSON result. If completion is impossible, use status cannot_complete and answer null.',
  'Do not return the schema, Markdown fences, or text outside the JSON object.'
].join('\n');

const defaultDependencies: Stage2bDependencies = {
  createModelClient: apiKey => createDeepSeekModelClient({ apiKey }),
  connectTools: options => McpToolBridge.connect(options),
  now: () => new Date()
};

export function parseStage2bArgs(argv: string[]): Stage2bCommand {
  if (argv.length === 1 && argv[0] === 'smoke') return { mode: 'smoke' };
  throw new Error('Stage 2B currently supports exactly: smoke');
}

export function stage2bExitCode(
  record: Pick<Stage2bRecord, 'status' | 'taskSuccess'>
): 0 | 1 {
  return record.status === 'completed' && record.taskSuccess === true ? 0 : 1;
}

export async function runStage2bSmoke(options: {
  repositoryRoot: string;
  apiKey: string;
  dependencies?: Partial<Stage2bDependencies>;
}): Promise<Stage2bRecord> {
  const repositoryRoot = resolve(options.repositoryRoot);
  const dependencies = { ...defaultDependencies, ...options.dependencies };
  const experimentRoot = resolve(repositoryRoot, 'experiments/stage-2a');
  const runRoot = resolve(repositoryRoot, '.experiment-runs/stage-2b');
  const serverEntrypoint = resolve(repositoryRoot, 'dist/src/mcp/server.js');
  const startedAt = dependencies.now();
  const runId = createRunId(startedAt);
  let setup: {
    task: ExperimentTask;
    workspace: PreparedWorkspace;
    outputSchema: Record<string, unknown>;
    client: ModelTurnClient;
  };
  try {
    const tasks = await loadTasks(experimentRoot);
    const task = tasks.find(candidate => candidate.id === 'T1');
    if (!task) throw new Error('Stage 2B requires task T1.');
    const workspace = await prepareWorkspace({
      task,
      condition: 'explicit',
      experimentRoot,
      runRoot,
      runId
    });
    const outputSchemaValue: unknown = JSON.parse(await readFile(workspace.outputSchemaPath, 'utf8'));
    if (!isRecord(outputSchemaValue)) throw new Error('Final answer schema must be a JSON object.');
    setup = {
      task,
      workspace,
      outputSchema: outputSchemaValue,
      client: dependencies.createModelClient(options.apiKey)
    };
  } catch {
    return infrastructureRecord({
      runId,
      startedAt,
      finishedAt: dependencies.now(),
      category: 'configuration',
      code: 'SETUP_FAILED'
    });
  }

  let tools: ToolGateway;
  try {
    tools = await dependencies.connectTools({
      serverEntrypoint,
      root: setup.workspace.path
    });
  } catch {
    return infrastructureRecord({
      runId,
      startedAt,
      finishedAt: dependencies.now(),
      category: 'mcp',
      code: 'TOOL_CONNECTION_FAILED'
    });
  }
  const result = await runAgent({
    client: setup.client,
    tools,
    instructions: STAGE2B_INSTRUCTIONS,
    input: setup.workspace.prompt,
    outputSchema: setup.outputSchema,
    parseFinalAnswer: parseExperimentAnswerText,
    diagnoseInvalidFinalAnswer: diagnoseExperimentAnswer,
    limits: { ...STAGE2B_LIMITS }
  });
  const finishedAt = dependencies.now();
  const finalAnswer = result.finalAnswer;

  return {
    version: 1,
    runId,
    startedAt: startedAt.toISOString(),
    provider: 'deepseek',
    model: DEEPSEEK_MODEL,
    thinking: 'none',
    taskId: 'T1',
    condition: 'explicit',
    status: result.status,
    taskSuccess: finalAnswer
      ? answerMatchesExpected(finalAnswer, setup.task.expected)
      : null,
    limits: { ...STAGE2B_LIMITS },
    turns: result.turns,
    toolCalls: result.toolCalls,
    toolEvents: result.history.filter(isToolEvent),
    ...(finalAnswer ? { finalAnswer } : {}),
    usage: { ...result.usage },
    durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    ...(result.error ? { error: { ...result.error } } : {})
  };
}

function infrastructureRecord(options: {
  runId: string;
  startedAt: Date;
  finishedAt: Date;
  category: 'configuration' | 'mcp';
  code: string;
}): Stage2bRecord {
  return {
    version: 1,
    runId: options.runId,
    startedAt: options.startedAt.toISOString(),
    provider: 'deepseek',
    model: DEEPSEEK_MODEL,
    thinking: 'none',
    taskId: 'T1',
    condition: 'explicit',
    status: 'infrastructure-error',
    taskSuccess: null,
    limits: { ...STAGE2B_LIMITS },
    turns: 0,
    toolCalls: 0,
    toolEvents: [],
    usage: {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0
    },
    durationMs: Math.max(0, options.finishedAt.getTime() - options.startedAt.getTime()),
    error: { category: options.category, code: options.code }
  };
}

export async function main(argv = process.argv.slice(2)): Promise<0 | 1> {
  parseStage2bArgs(argv);
  const repositoryRoot = process.cwd();
  const apiKey = requireDeepSeekApiKey();
  const record = await runStage2bSmoke({ repositoryRoot, apiKey });
  const recordPath = await writeStage2bRecord(repositoryRoot, record);
  process.stdout.write(`${JSON.stringify({
    runId: record.runId,
    status: record.status,
    taskSuccess: record.taskSuccess,
    turns: record.turns,
    toolCalls: record.toolCalls,
    usage: record.usage,
    recordPath
  }, null, 2)}\n`);
  return stage2bExitCode(record);
}

function createRunId(date: Date): string {
  const timestamp = date.toISOString().replace(/[-:.]/g, '').replace('Z', 'Z');
  return `stage2b-T1-explicit-${timestamp}-${randomBytes(4).toString('hex')}`;
}

function isToolEvent(item: unknown): item is Stage2bToolEvent {
  return isRecord(item)
    && (item.type === 'function_call' || item.type === 'function_call_output');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEntrypoint(entrypoint: string | undefined): boolean {
  if (!entrypoint) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entrypoint)).href;
  } catch {
    return false;
  }
}

if (isEntrypoint(process.argv[1])) {
  main()
    .then(exitCode => { process.exitCode = exitCode; })
    .catch(() => {
      process.stderr.write('Stage 2B smoke failed. Inspect the local record when available.\n');
      process.exitCode = 1;
    });
}
