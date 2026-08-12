import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  runAgent,
  STAGE2B_LIMITS,
  type AgentLimits
} from '../agent/agent-loop.js';
import {
  createDeepSeekModelClient,
  DEEPSEEK_MODEL,
  DEEPSEEK_TEMPERATURE,
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
  createStage2bRunId,
  isStage2bRunId,
  type Stage2bRecord,
  type Stage2bTaskId,
  type Stage2bToolEvent
} from './stage2b-record.js';
import {
  claimNextStage2bBatchRun,
  isStage2bBatchId,
  prepareStage2bBatch,
  reconcileStage2bBatch,
  recordStage2bBatchRun
} from './stage2b-batch.js';
import {
  createStage2bPlan,
  STAGE2B_PLAN_MAX_REPETITIONS,
  validateStage2bPlanRepetitions
} from './stage2b-plan.js';
import {
  STAGE2B_TASK_IDS,
  type Stage2bSuiteId
} from './stage2b-suite.js';
import { writeStage2bComparisonReport } from './stage2b-report.js';
import { loadTasks } from './task-loader.js';
import { prepareWorkspace, type PreparedWorkspace } from './workspace.js';

export interface Stage2bDependencies {
  createModelClient(apiKey: string, temperature: number | null): ModelTurnClient;
  connectTools(options: McpToolBridgeOptions): Promise<ToolGateway>;
  now(): Date;
}

export type Stage2bCommand = {
  mode: 'smoke';
  taskId: Stage2bTaskId;
  condition: ExperimentCondition;
} | {
  mode: 'plan';
  suite: Stage2bSuiteId;
  repetitions: number;
} | {
  mode: 'prepare';
  suite: Stage2bSuiteId;
  repetitions: number;
} | {
  mode: 'run-next';
  batchId: string;
} | {
  mode: 'report';
  pilotBatchId: string;
  calibratedBatchId: string;
  repeatBatchId?: string;
};

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
  createModelClient: (apiKey, temperature) => createDeepSeekModelClient({ apiKey, temperature }),
  connectTools: options => McpToolBridge.connect(options),
  now: () => new Date()
};

const supportedTaskIds: readonly Stage2bTaskId[] = STAGE2B_TASK_IDS;
const supportedConditions: readonly ExperimentCondition[] = ['explicit', 'description', 'skill'];
const stage2bHelp = [
  'Stage 2B supports:',
  'smoke [--task T1|T2|T6|T7|T9|T10|T11] [--condition explicit|description|skill];',
  `plan [--suite baseline-v1|diagnostic-v1] [--repetitions 1..${STAGE2B_PLAN_MAX_REPETITIONS}];`,
  `prepare [--suite baseline-v1|diagnostic-v1] [--repetitions 1..${STAGE2B_PLAN_MAX_REPETITIONS}];`,
  'run-next --batch <batch-id>;',
  'report --pilot-batch <batch-id> --calibrated-batch <batch-id> [--repeat-batch <batch-id>]'
].join(' ');

export function parseStage2bArgs(argv: string[]): Stage2bCommand {
  if (argv[0] === 'plan' || argv[0] === 'prepare') {
    return parseRepetitionArgs(argv[0], argv.slice(1));
  }
  if (argv[0] === 'run-next') return parseRunNextArgs(argv.slice(1));
  if (argv[0] === 'report') return parseReportArgs(argv.slice(1));
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

export function stage2bExitCode(
  record: Pick<Stage2bRecord, 'status' | 'taskSuccess'>
): 0 | 1 {
  return record.status === 'completed' && record.taskSuccess === true ? 0 : 1;
}

export function stage2bFailureMessage(argv: string[]): string {
  return argv[0] === 'report'
    ? 'Stage 2B report failed. Verify the local batch records and configuration.\n'
    : 'Stage 2B smoke failed. Inspect the local record when available.\n';
}

export async function runStage2bSmoke(options: {
  repositoryRoot: string;
  taskId?: Stage2bTaskId;
  condition?: ExperimentCondition;
  runId?: string;
  temperature?: number | null;
  limits?: AgentLimits;
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
  const temperature = options.temperature === undefined
    ? DEEPSEEK_TEMPERATURE
    : options.temperature;
  const limits = { ...(options.limits ?? STAGE2B_LIMITS) };
  const startedAt = dependencies.now();
  const runId = options.runId ?? createStage2bRunId(taskId, condition, startedAt);
  if (!isStage2bRunId(runId)) throw new Error('Invalid Stage 2B run ID.');
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
      client: dependencies.createModelClient(apiKey, temperature),
      instructions
    };
  } catch {
    return infrastructureRecord({
      runId,
      taskId,
      condition,
      temperature,
      limits,
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
      temperature,
      limits,
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
    limits
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
    sampling: { temperature },
    taskId,
    condition,
    status: result.status,
    taskSuccess: finalAnswer
      ? answerMatchesExpected(finalAnswer, setup.task.expected)
      : null,
    recoverySuccess: evaluateRecovery(taskId, result.status, result.history),
    limits,
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
  temperature: number | null;
  limits: AgentLimits;
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
    sampling: { temperature: options.temperature },
    taskId: options.taskId,
    condition: options.condition,
    status: 'infrastructure-error',
    taskSuccess: null,
    recoverySuccess: null,
    limits: { ...options.limits },
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
    const output = `${JSON.stringify(createStage2bPlan(command.repetitions, command.suite), null, 2)}\n`;
    (options.writeOutput ?? (text => { process.stdout.write(text); }))(output);
    return 0;
  }
  const repositoryRoot = options.repositoryRoot ?? process.cwd();
  if (command.mode === 'report') {
    const result = await writeStage2bComparisonReport({
      repositoryRoot,
      pilotBatchId: command.pilotBatchId,
      calibratedBatchId: command.calibratedBatchId,
      ...(command.repeatBatchId ? { repeatBatchId: command.repeatBatchId } : {})
    });
    const output = `${JSON.stringify({
      status: 'reported',
      pilotBatchId: command.pilotBatchId,
      calibratedBatchId: command.calibratedBatchId,
      ...(command.repeatBatchId ? { repeatBatchId: command.repeatBatchId } : {}),
      jsonPath: result.jsonPath,
      markdownPath: result.markdownPath
    }, null, 2)}\n`;
    (options.writeOutput ?? (text => { process.stdout.write(text); }))(output);
    return 0;
  }
  if (command.mode === 'prepare') {
    const dependencies = { ...defaultDependencies, ...options.dependencies };
    const prepared = await prepareStage2bBatch({
      repositoryRoot,
      suite: command.suite,
      repetitions: command.repetitions,
      createdAt: dependencies.now()
    });
    const output = `${JSON.stringify({
      batchId: prepared.manifest.batchId,
      suite: command.suite,
      totalRuns: prepared.manifest.totalRuns,
      pendingRuns: prepared.manifest.runs.length,
      manifestPath: prepared.manifestPath
    }, null, 2)}\n`;
    (options.writeOutput ?? (text => { process.stdout.write(text); }))(output);
    return 0;
  }
  if (command.mode === 'run-next') {
    const reconciled = await reconcileStage2bBatch(repositoryRoot, command.batchId);
    const remainingAfterReconcile = reconciled.manifest.runs
      .filter(run => run.status === 'pending').length;
    if (reconciled.recoveredRunKeys.length > 0) {
      const output = `${JSON.stringify({
        batchId: command.batchId,
        status: 'reconciled',
        recoveredRunKeys: reconciled.recoveredRunKeys,
        remainingPending: remainingAfterReconcile,
        manifestPath: reconciled.manifestPath
      }, null, 2)}\n`;
      (options.writeOutput ?? (text => { process.stdout.write(text); }))(output);
      return 0;
    }
    if (reconciled.unresolvedRunKeys.length > 0) {
      const output = `${JSON.stringify({
        batchId: command.batchId,
        status: 'blocked-by-running',
        unresolvedRunKeys: reconciled.unresolvedRunKeys,
        remainingPending: remainingAfterReconcile,
        manifestPath: reconciled.manifestPath
      }, null, 2)}\n`;
      (options.writeOutput ?? (text => { process.stdout.write(text); }))(output);
      return 1;
    }
    const dependencies = { ...defaultDependencies, ...options.dependencies };
    const claimed = await claimNextStage2bBatchRun({
      repositoryRoot,
      batchId: command.batchId,
      claimedAt: dependencies.now()
    });
    const selected = claimed.run;
    if (!selected) {
      const output = `${JSON.stringify({
        batchId: command.batchId,
        status: 'no-pending-runs',
        remainingPending: 0,
        manifestPath: claimed.manifestPath
      }, null, 2)}\n`;
      (options.writeOutput ?? (text => { process.stdout.write(text); }))(output);
      return 0;
    }
    const apiKey = (options.env ?? process.env).DEEPSEEK_API_KEY;
    const record = await runStage2bSmoke({
      repositoryRoot,
      taskId: selected.taskId,
      condition: selected.condition,
      runId: selected.recordRunId,
      temperature: claimed.manifest.sampling.temperature,
      limits: claimed.manifest.limits,
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(options.dependencies ? { dependencies: options.dependencies } : {})
    });
    const recordPath = await writeStage2bRecord(repositoryRoot, record);
    const updated = await recordStage2bBatchRun({
      repositoryRoot,
      batchId: command.batchId,
      runKey: selected.runKey,
      record
    });
    const terminal = updated.manifest.runs.find(run => run.runKey === selected.runKey);
    if (!terminal || terminal.status === 'pending' || terminal.status === 'running') {
      throw new Error('Stage 2B batch update did not produce a terminal run.');
    }
    const output = `${JSON.stringify({
      batchId: command.batchId,
      runKey: terminal.runKey,
      status: terminal.status,
      recordRunId: terminal.recordRunId,
      recordStatus: terminal.recordStatus,
      taskSuccess: terminal.taskSuccess,
      recoverySuccess: terminal.recoverySuccess,
      remainingPending: updated.manifest.runs.filter(run => run.status === 'pending').length,
      manifestPath: updated.manifestPath,
      recordPath
    }, null, 2)}\n`;
    (options.writeOutput ?? (text => { process.stdout.write(text); }))(output);
    return record.status === 'completed' ? 0 : 1;
  }
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

function parseReportArgs(argv: string[]): Extract<Stage2bCommand, { mode: 'report' }> {
  let pilotBatchId: string | undefined;
  let calibratedBatchId: string | undefined;
  let repeatBatchId: string | undefined;
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--pilot-batch' && pilotBatchId === undefined && isStage2bBatchId(value ?? '')) {
      pilotBatchId = value;
      continue;
    }
    if (
      flag === '--calibrated-batch'
      && calibratedBatchId === undefined
      && isStage2bBatchId(value ?? '')
    ) {
      calibratedBatchId = value;
      continue;
    }
    if (flag === '--repeat-batch' && repeatBatchId === undefined && isStage2bBatchId(value ?? '')) {
      repeatBatchId = value;
      continue;
    }
    throw new Error(stage2bHelp);
  }
  if (
    !pilotBatchId
    || !calibratedBatchId
    || new Set([pilotBatchId, calibratedBatchId, repeatBatchId].filter(Boolean)).size
      !== (repeatBatchId ? 3 : 2)
  ) {
    throw new Error(stage2bHelp);
  }
  return {
    mode: 'report',
    pilotBatchId,
    calibratedBatchId,
    ...(repeatBatchId ? { repeatBatchId } : {})
  };
}

function isSupportedTaskId(value: string | undefined): value is Stage2bTaskId {
  return supportedTaskIds.some(taskId => taskId === value);
}

function isSupportedCondition(value: string | undefined): value is ExperimentCondition {
  return supportedConditions.some(condition => condition === value);
}

function isStage2bSuiteId(value: string | undefined): value is Stage2bSuiteId {
  return value === 'baseline-v1' || value === 'diagnostic-v1';
}

function parseRepetitionArgs(
  mode: 'plan' | 'prepare',
  argv: string[]
): Extract<Stage2bCommand, { mode: 'plan' }> | Extract<Stage2bCommand, { mode: 'prepare' }> {
  let repetitions = 1;
  let suite: Stage2bSuiteId = 'baseline-v1';
  let hasRepetitions = false;
  let hasSuite = false;
  if (argv.length % 2 !== 0) throw new Error(`Invalid ${mode} arguments. ${stage2bHelp}`);

  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--repetitions') {
      if (hasRepetitions || !value || !/^[1-9]\d*$/.test(value)) {
        throw new Error(`Invalid repetitions. ${stage2bHelp}`);
      }
      repetitions = Number(value);
      validateStage2bPlanRepetitions(repetitions);
      hasRepetitions = true;
      continue;
    }
    if (flag === '--suite') {
      if (hasSuite || !isStage2bSuiteId(value)) {
        throw new Error(`Invalid suite. ${stage2bHelp}`);
      }
      suite = value;
      hasSuite = true;
      continue;
    }
    throw new Error(`Invalid ${mode} arguments. ${stage2bHelp}`);
  }
  return mode === 'plan'
    ? { mode, suite, repetitions }
    : { mode, suite, repetitions };
}

function parseRunNextArgs(argv: string[]): Stage2bCommand {
  const batchId = argv[1];
  if (argv.length !== 2 || argv[0] !== '--batch' || !batchId || !isStage2bBatchId(batchId)) {
    throw new Error(`Invalid run-next batch. ${stage2bHelp}`);
  }
  return { mode: 'run-next', batchId };
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
      process.stderr.write(stage2bFailureMessage(process.argv.slice(2)));
      process.exitCode = 1;
    });
}
