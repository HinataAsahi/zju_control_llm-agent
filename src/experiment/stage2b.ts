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
import { writeStage2bBoundaryReport } from './stage2b-boundary-report.js';
import { writeStage2bDiagnosticReport } from './stage2b-diagnostic-report.js';
import { evaluateStage2bRecovery } from './stage2b-evaluation.js';
import {
  createStage2bPlan,
  STAGE2B_PLAN_MAX_REPETITIONS,
  validateStage2bPlanRepetitions
} from './stage2b-plan.js';
import {
  getStage2bTaskProfile,
  STAGE2B_TASK_IDS,
  type Stage2bSuiteId,
  type Stage2bTreatment
} from './stage2b-suite.js';
import {
  createStage2bSkillIdentity,
  experimentConditionForTreatment,
  loadStage2bSkillAsset,
  type Stage2bSkillIdentity
} from './stage2b-treatment.js';
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
  condition: Stage2bTreatment;
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
  kind: 'baseline';
  pilotBatchId: string;
  calibratedBatchId: string;
  repeatBatchId?: string;
} | {
  mode: 'report';
  kind: 'diagnostic';
  batchId: string;
  repeatBatchId?: string;
} | {
  mode: 'report';
  kind: 'boundary';
  batchId: string;
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
const supportedConditions: readonly Stage2bTreatment[] = [
  'explicit', 'description', 'skill', 'skill-v1', 'skill-v2'
];
const stage2bHelp = [
  'Stage 2B supports:',
  'smoke [--task T1|T2|T6|T7|T9|T10|T11|T12|T13|T14|T15|T16|T17] [--condition explicit|description|skill|skill-v1|skill-v2];',
  `plan [--suite baseline-v1|diagnostic-v1|boundary-v1] [--repetitions 1..${STAGE2B_PLAN_MAX_REPETITIONS}];`,
  `prepare [--suite baseline-v1|diagnostic-v1|boundary-v1] [--repetitions 1..${STAGE2B_PLAN_MAX_REPETITIONS}];`,
  'run-next --batch <batch-id>;',
  'report --boundary-batch <batch-id> [--repeat-batch <batch-id>];',
  'report --batch <batch-id> [--repeat-batch <batch-id>]; or',
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
  let condition: Stage2bTreatment = 'explicit';
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
  condition?: Stage2bTreatment;
  runId?: string;
  temperature?: number | null;
  limits?: AgentLimits;
  apiKey?: string;
  expectedSkillIdentity?: Stage2bSkillIdentity | null;
  dependencies?: Partial<Stage2bDependencies>;
}): Promise<Stage2bRecord> {
  const repositoryRoot = resolve(options.repositoryRoot);
  const taskId = options.taskId ?? 'T1';
  const condition = options.condition ?? 'explicit';
  const dependencies = { ...defaultDependencies, ...options.dependencies };
  const experimentRoot = resolve(repositoryRoot, 'experiments/stage-2a');
  const taskProfile = getStage2bTaskProfile(taskId);
  const taskRoot = resolve(repositoryRoot, `experiments/${taskProfile.taskRoot}`);
  const runRoot = resolve(repositoryRoot, '.experiment-runs/stage-2b');
  const serverEntrypoint = resolve(repositoryRoot, 'dist/src/mcp/server.js');
  const temperature = options.temperature === undefined
    ? DEEPSEEK_TEMPERATURE
    : options.temperature;
  const limits = { ...(options.limits ?? STAGE2B_LIMITS) };
  const startedAt = dependencies.now();
  const runId = options.runId ?? createStage2bRunId(taskId, condition, startedAt);
  if (!isStage2bRunId(runId)) throw new Error('Invalid Stage 2B run ID.');
  const hasExpectedSkillIdentity = Object.hasOwn(options, 'expectedSkillIdentity');
  let selectedSkillIdentity: Stage2bSkillIdentity | null = null;
  let setup: {
    task: ExperimentTask;
    workspace: PreparedWorkspace;
    outputSchema: Record<string, unknown>;
    client: ModelTurnClient;
    instructions: string;
  };
  try {
    const apiKey = requireDeepSeekApiKey({ DEEPSEEK_API_KEY: options.apiKey });
    const tasks = await loadTasks(taskRoot);
    const task = tasks.find(candidate => candidate.id === taskId);
    if (!task) throw new Error(`Stage 2B requires task ${taskId}.`);
    const versionedSkill = await loadStage2bSkillAsset(repositoryRoot, condition);
    selectedSkillIdentity = versionedSkill?.identity ?? null;
    if (
      hasExpectedSkillIdentity
      && !sameSkillIdentity(selectedSkillIdentity, options.expectedSkillIdentity ?? null)
    ) {
      throw new Error('Stage 2B skill asset does not match the prepared batch.');
    }
    const workspaceCondition = experimentConditionForTreatment(condition);
    const workspace = await prepareWorkspace({
      task,
      condition: workspaceCondition,
      experimentRoot,
      taskRoot,
      ...(versionedSkill ? { skillAsset: versionedSkill.workspaceAsset } : condition === 'skill' ? {
        skillAsset: {
          root: experimentRoot,
          relativePath: 'reference-skill/SKILL.md'
        }
      } : {}),
      runRoot,
      runId
    });
    if (versionedSkill) {
      const installedContents = await readFile(
        join(workspace.path, '.agents', 'skills', 'jq-query', 'SKILL.md'),
        'utf8'
      );
      const installedIdentity = createStage2bSkillIdentity(
        versionedSkill.identity.version,
        installedContents
      );
      if (!sameSkillIdentity(installedIdentity, versionedSkill.identity)) {
        throw new Error('Stage 2B skill asset changed while preparing the workspace.');
      }
      selectedSkillIdentity = installedIdentity;
    }
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
      code: 'SETUP_FAILED',
      recordVersion: hasExpectedSkillIdentity || selectedSkillIdentity !== null ? 2 : 1,
      skill: hasExpectedSkillIdentity ? options.expectedSkillIdentity ?? null : selectedSkillIdentity
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
      code: 'TOOL_CONNECTION_FAILED',
      recordVersion: hasExpectedSkillIdentity || selectedSkillIdentity !== null ? 2 : 1,
      skill: hasExpectedSkillIdentity ? options.expectedSkillIdentity ?? null : selectedSkillIdentity
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
  const taskSuccess = finalAnswer
    ? answerMatchesExpected(finalAnswer, setup.task.expected)
    : null;
  const toolEvents = result.history.filter(isToolEvent);

  return {
    version: hasExpectedSkillIdentity || selectedSkillIdentity !== null ? 2 : 1,
    runId,
    startedAt: startedAt.toISOString(),
    provider: 'deepseek',
    model: DEEPSEEK_MODEL,
    thinking: 'none',
    sampling: { temperature },
    taskId,
    condition,
    ...(hasExpectedSkillIdentity || selectedSkillIdentity !== null
      ? { skill: selectedSkillIdentity }
      : {}),
    status: result.status,
    taskSuccess,
    recoverySuccess: evaluateStage2bRecovery({
      taskId,
      status: result.status,
      taskSuccess,
      toolEvents
    }),
    limits,
    turns: result.turns,
    toolCalls: result.toolCalls,
    toolEvents,
    ...(finalAnswer ? { finalAnswer } : {}),
    usage: { ...result.usage },
    durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    ...(result.error ? { error: { ...result.error } } : {})
  };
}

function infrastructureRecord(options: {
  runId: string;
  taskId: Stage2bTaskId;
  condition: Stage2bTreatment;
  temperature: number | null;
  limits: AgentLimits;
  startedAt: Date;
  finishedAt: Date;
  category: 'configuration' | 'mcp';
  code: string;
  recordVersion?: 1 | 2;
  skill?: Stage2bSkillIdentity | null;
}): Stage2bRecord {
  return {
    version: options.recordVersion ?? 1,
    runId: options.runId,
    startedAt: options.startedAt.toISOString(),
    provider: 'deepseek',
    model: DEEPSEEK_MODEL,
    thinking: 'none',
    sampling: { temperature: options.temperature },
    taskId: options.taskId,
    condition: options.condition,
    ...(options.recordVersion === 2 ? { skill: options.skill ?? null } : {}),
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

function sameSkillIdentity(
  left: Stage2bSkillIdentity | null,
  right: Stage2bSkillIdentity | null
): boolean {
  return left === null || right === null
    ? left === right
    : left.version === right.version && left.sha256 === right.sha256;
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
    if (command.kind === 'boundary') {
      const result = await writeStage2bBoundaryReport({
        repositoryRoot,
        batchId: command.batchId,
        ...(command.repeatBatchId ? { repeatBatchId: command.repeatBatchId } : {})
      });
      const output = `${JSON.stringify({
        status: 'reported',
        suite: result.report.suite,
        repetitions: result.report.repetitions,
        jsonPath: result.jsonPath,
        markdownPath: result.markdownPath
      }, null, 2)}\n`;
      (options.writeOutput ?? (text => { process.stdout.write(text); }))(output);
      return 0;
    }
    if (command.kind === 'diagnostic') {
      const result = await writeStage2bDiagnosticReport({
        repositoryRoot,
        batchId: command.batchId,
        ...(command.repeatBatchId ? { repeatBatchId: command.repeatBatchId } : {})
      });
      const output = `${JSON.stringify({
        status: 'reported',
        kind: 'diagnostic',
        batchId: command.batchId,
        ...(command.repeatBatchId ? { repeatBatchId: command.repeatBatchId } : {}),
        jsonPath: result.jsonPath,
        markdownPath: result.markdownPath
      }, null, 2)}\n`;
      (options.writeOutput ?? (text => { process.stdout.write(text); }))(output);
      return 0;
    }
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
      ...(claimed.manifest.version === 3 ? {
        expectedSkillIdentity: selected.condition === 'skill-v1'
          ? claimed.manifest.skills.v1
          : selected.condition === 'skill-v2'
            ? claimed.manifest.skills.v2
            : null
      } : {}),
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
  const boundaryBatchId = argv[1];
  if (
    argv[0] === '--boundary-batch'
    && boundaryBatchId
    && isStage2bBatchId(boundaryBatchId)
  ) {
    if (argv.length === 2) {
      return { mode: 'report', kind: 'boundary', batchId: boundaryBatchId };
    }
    const repeatBatchId = argv[3];
    if (
      argv.length === 4
      && argv[2] === '--repeat-batch'
      && repeatBatchId
      && isStage2bBatchId(repeatBatchId)
      && repeatBatchId !== boundaryBatchId
    ) {
      return { mode: 'report', kind: 'boundary', batchId: boundaryBatchId, repeatBatchId };
    }
    throw new Error(stage2bHelp);
  }
  const diagnosticBatchId = argv[1];
  if (
    argv[0] === '--batch'
    && diagnosticBatchId
    && isStage2bBatchId(diagnosticBatchId)
  ) {
    if (argv.length === 2) {
      return { mode: 'report', kind: 'diagnostic', batchId: diagnosticBatchId };
    }
    const repeatBatchId = argv[3];
    if (
      argv.length === 4
      && argv[2] === '--repeat-batch'
      && repeatBatchId
      && isStage2bBatchId(repeatBatchId)
      && repeatBatchId !== diagnosticBatchId
    ) {
      return {
        mode: 'report',
        kind: 'diagnostic',
        batchId: diagnosticBatchId,
        repeatBatchId
      };
    }
    throw new Error(stage2bHelp);
  }
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
    kind: 'baseline',
    pilotBatchId,
    calibratedBatchId,
    ...(repeatBatchId ? { repeatBatchId } : {})
  };
}

function isSupportedTaskId(value: string | undefined): value is Stage2bTaskId {
  return supportedTaskIds.some(taskId => taskId === value);
}

function isSupportedCondition(value: string | undefined): value is Stage2bTreatment {
  return supportedConditions.some(condition => condition === value);
}

function isStage2bSuiteId(value: string | undefined): value is Stage2bSuiteId {
  return value === 'baseline-v1' || value === 'diagnostic-v1' || value === 'boundary-v1';
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
  condition: Stage2bTreatment
): Promise<string> {
  if (condition !== 'skill' && condition !== 'skill-v1' && condition !== 'skill-v2') {
    return STAGE2B_INSTRUCTIONS;
  }
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
