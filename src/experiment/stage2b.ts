import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
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
  type ExperimentCondition,
  type ExperimentTask
} from './schema.js';
import {
  writeStage2bRecord,
  type Stage2bRecord,
  type Stage2bTaskId,
  type Stage2bToolEvent
} from './stage2b-record.js';
import { loadTasks } from './task-loader.js';
import { prepareWorkspace, type PreparedWorkspace } from './workspace.js';

export interface Stage2bDependencies {
  createModelClient(apiKey: string): ModelTurnClient;
  connectTools(options: McpToolBridgeOptions): Promise<ToolGateway>;
  now(): Date;
}

export type Stage2bCommand = {
  mode: 'smoke';
  taskId: Stage2bTaskId;
  condition: ExperimentCondition;
} | {
  mode: 'plan';
  repetitions: number;
};

interface Stage2bPlanRun {
  taskId: 'T2' | 'T7';
  condition: ExperimentCondition;
  repetition: number;
}

interface Stage2bPlan {
  version: 1;
  mode: 'plan';
  tasks: Array<'T2' | 'T7'>;
  conditions: ExperimentCondition[];
  repetitions: number;
  totalRuns: number;
  requiresApiKey: false;
  upperBounds: {
    modelRequests: number;
    toolCalls: number;
  };
  runs: Stage2bPlanRun[];
}

export type { Stage2bTaskId } from './stage2b-record.js';

export interface Stage2bMainOptions {
  repositoryRoot?: string;
  env?: NodeJS.ProcessEnv;
  dependencies?: Partial<Stage2bDependencies>;
  writeOutput?(text: string): void;
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

const supportedTaskIds: readonly Stage2bTaskId[] = ['T1', 'T2', 'T6', 'T7'];
const supportedConditions: readonly ExperimentCondition[] = ['explicit', 'description', 'skill'];
const plannedTaskIds = ['T2', 'T7'] as const;
const maximumPlanRepetitions = 100;
const stage2bHelp = [
  'Stage 2B supports:',
  'smoke [--task T1|T2|T6|T7] [--condition explicit|description|skill];',
  'plan [--repetitions 1..100]'
].join(' ');

export function parseStage2bArgs(argv: string[]): Stage2bCommand {
  if (argv[0] === 'plan') return parsePlanArgs(argv.slice(1));
  if (argv[0] !== 'smoke') throw new Error(stage2bHelp);
  let taskId: Stage2bTaskId = 'T1';
  let condition: ExperimentCondition = 'explicit';
  let hasTask = false;
  let hasCondition = false;

  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--task') {
      if (hasTask || !isSupportedTaskId(value)) throw new Error(`Invalid task. ${stage2bHelp}`);
      taskId = value;
      hasTask = true;
      continue;
    }
    if (flag === '--condition') {
      if (hasCondition || !isSupportedCondition(value)) {
        throw new Error(`Invalid condition. ${stage2bHelp}`);
      }
      condition = value;
      hasCondition = true;
      continue;
    }
    throw new Error(stage2bHelp);
  }
  return { mode: 'smoke', taskId, condition };
}

function createStage2bPlan(repetitions = 1): Stage2bPlan {
  validateRepetitions(repetitions);
  const runs = plannedTaskIds.flatMap(taskId =>
    supportedConditions.flatMap(condition =>
      Array.from({ length: repetitions }, (_, index) => ({
        taskId,
        condition,
        repetition: index + 1
      }))
    )
  );
  return {
    version: 1,
    mode: 'plan',
    tasks: [...plannedTaskIds],
    conditions: [...supportedConditions],
    repetitions,
    totalRuns: runs.length,
    requiresApiKey: false,
    upperBounds: {
      modelRequests: runs.length * STAGE2B_LIMITS.maxTurns,
      toolCalls: runs.length * STAGE2B_LIMITS.maxToolCalls
    },
    runs
  };
}

export function stage2bExitCode(
  record: Pick<Stage2bRecord, 'status' | 'taskSuccess'>
): 0 | 1 {
  return record.status === 'completed' && record.taskSuccess === true ? 0 : 1;
}

export async function runStage2bSmoke(options: {
  repositoryRoot: string;
  taskId?: Stage2bTaskId;
  condition?: ExperimentCondition;
  apiKey?: string;
  dependencies?: Partial<Stage2bDependencies>;
}): Promise<Stage2bRecord> {
  const repositoryRoot = resolve(options.repositoryRoot);
  const taskId = options.taskId ?? 'T1';
  const condition = options.condition ?? 'explicit';
  const dependencies = { ...defaultDependencies, ...options.dependencies };
  const experimentRoot = resolve(repositoryRoot, 'experiments/stage-2a');
  const runRoot = resolve(repositoryRoot, '.experiment-runs/stage-2b');
  const serverEntrypoint = resolve(repositoryRoot, 'dist/src/mcp/server.js');
  const startedAt = dependencies.now();
  const runId = createRunId(taskId, condition, startedAt);
  let setup: {
    task: ExperimentTask;
    workspace: PreparedWorkspace;
    outputSchema: Record<string, unknown>;
    client: ModelTurnClient;
    instructions: string;
  };
  try {
    const apiKey = requireDeepSeekApiKey({ DEEPSEEK_API_KEY: options.apiKey });
    const tasks = await loadTasks(experimentRoot);
    const task = tasks.find(candidate => candidate.id === taskId);
    if (!task) throw new Error(`Stage 2B requires task ${taskId}.`);
    const workspace = await prepareWorkspace({
      task,
      condition,
      experimentRoot,
      runRoot,
      runId
    });
    const outputSchemaValue: unknown = JSON.parse(await readFile(workspace.outputSchemaPath, 'utf8'));
    if (!isRecord(outputSchemaValue)) throw new Error('Final answer schema must be a JSON object.');
    const instructions = await instructionsForCondition(workspace, condition);
    setup = {
      task,
      workspace,
      outputSchema: outputSchemaValue,
      client: dependencies.createModelClient(apiKey),
      instructions
    };
  } catch {
    return infrastructureRecord({
      runId,
      taskId,
      condition,
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
      taskId,
      condition,
      startedAt,
      finishedAt: dependencies.now(),
      category: 'mcp',
      code: 'TOOL_CONNECTION_FAILED'
    });
  }
  const result = await runAgent({
    client: setup.client,
    tools,
    instructions: setup.instructions,
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
    taskId,
    condition,
    status: result.status,
    taskSuccess: finalAnswer
      ? answerMatchesExpected(finalAnswer, setup.task.expected)
      : null,
    recoverySuccess: evaluateRecovery(taskId, result.status, result.history),
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
  taskId: Stage2bTaskId;
  condition: ExperimentCondition;
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
    taskId: options.taskId,
    condition: options.condition,
    status: 'infrastructure-error',
    taskSuccess: null,
    recoverySuccess: null,
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

export async function main(
  argv = process.argv.slice(2),
  options: Stage2bMainOptions = {}
): Promise<0 | 1> {
  const command = parseStage2bArgs(argv);
  if (command.mode === 'plan') {
    const output = `${JSON.stringify(createStage2bPlan(command.repetitions), null, 2)}\n`;
    (options.writeOutput ?? (text => { process.stdout.write(text); }))(output);
    return 0;
  }
  const repositoryRoot = options.repositoryRoot ?? process.cwd();
  const apiKey = (options.env ?? process.env).DEEPSEEK_API_KEY;
  const record = await runStage2bSmoke({
    repositoryRoot,
    taskId: command.taskId,
    condition: command.condition,
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(options.dependencies ? { dependencies: options.dependencies } : {})
  });
  const recordPath = await writeStage2bRecord(repositoryRoot, record);
  const output = `${JSON.stringify({
    runId: record.runId,
    taskId: record.taskId,
    condition: record.condition,
    status: record.status,
    taskSuccess: record.taskSuccess,
    recoverySuccess: record.recoverySuccess,
    turns: record.turns,
    toolCalls: record.toolCalls,
    usage: record.usage,
    recordPath
  }, null, 2)}\n`;
  (options.writeOutput ?? (text => { process.stdout.write(text); }))(output);
  return stage2bExitCode(record);
}

function createRunId(
  taskId: Stage2bTaskId,
  condition: ExperimentCondition,
  date: Date
): string {
  const timestamp = date.toISOString().replace(/[-:.]/g, '').replace('Z', 'Z');
  return `stage2b-${taskId}-${condition}-${timestamp}-${randomBytes(4).toString('hex')}`;
}

function isSupportedTaskId(value: string | undefined): value is Stage2bTaskId {
  return supportedTaskIds.some(taskId => taskId === value);
}

function isSupportedCondition(value: string | undefined): value is ExperimentCondition {
  return supportedConditions.some(condition => condition === value);
}

function parsePlanArgs(argv: string[]): Stage2bCommand {
  if (argv.length === 0) return { mode: 'plan', repetitions: 1 };
  if (argv.length !== 2 || argv[0] !== '--repetitions') {
    throw new Error(`Invalid plan arguments. ${stage2bHelp}`);
  }
  const value = argv[1];
  if (!value || !/^[1-9]\d*$/.test(value)) {
    throw new Error(`Invalid repetitions. ${stage2bHelp}`);
  }
  const repetitions = Number(value);
  validateRepetitions(repetitions);
  return { mode: 'plan', repetitions };
}

function validateRepetitions(repetitions: number): void {
  if (
    !Number.isSafeInteger(repetitions)
    || repetitions < 1
    || repetitions > maximumPlanRepetitions
  ) {
    throw new Error(`Repetitions must be an integer from 1 to ${maximumPlanRepetitions}.`);
  }
}

async function instructionsForCondition(
  workspace: PreparedWorkspace,
  condition: ExperimentCondition
): Promise<string> {
  if (condition !== 'skill') return STAGE2B_INSTRUCTIONS;
  const skill = await readFile(
    join(workspace.path, '.agents', 'skills', 'jq-query', 'SKILL.md'),
    'utf8'
  );
  return [
    STAGE2B_INSTRUCTIONS,
    '',
    'Reference skill: jq-query',
    skill.trim()
  ].join('\n');
}

function isToolEvent(item: unknown): item is Stage2bToolEvent {
  return isRecord(item)
    && (item.type === 'function_call' || item.type === 'function_call_output');
}

function evaluateRecovery(
  taskId: Stage2bTaskId,
  status: Stage2bRecord['status'],
  history: readonly unknown[]
): boolean | null {
  if (taskId !== 'T7' || status !== 'completed') return null;
  const events = history.filter(isToolEvent);
  const calls = events.filter(event => event.type === 'function_call');
  const firstCall = calls[0];
  if (!firstCall || firstCall.name !== 'jq_query') return false;

  const firstArguments = parseJsonRecord(firstCall.arguments);
  const firstOutput = events.find(event =>
    event.type === 'function_call_output' && event.callId === firstCall.callId
  );
  const firstResult = firstOutput?.type === 'function_call_output'
    ? parseJsonRecord(firstOutput.output)
    : undefined;
  if (
    firstArguments?.filter !== 'if'
    || firstResult?.ok !== false
    || !isRecord(firstResult.error)
    || firstResult.error.code !== 'JQ_SYNTAX_ERROR'
  ) {
    return false;
  }

  return calls.slice(1).some(call => {
    if (call.name !== 'jq_query') return false;
    const output = events.find(event =>
      event.type === 'function_call_output' && event.callId === call.callId
    );
    return output?.type === 'function_call_output'
      ? parseJsonRecord(output.output)?.ok === true
      : false;
  });
}

function parseJsonRecord(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
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
