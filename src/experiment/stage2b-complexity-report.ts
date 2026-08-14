import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { ModelUsage } from '../agent/model-client.js';
import {
  readStage2bBatchManifest,
  type Stage2bBatchManifest,
  type Stage2bBatchRun
} from './stage2b-batch.js';
import {
  analyzeStage2bProcess,
  type Stage2bProcessAnalysis
} from './stage2b-evaluation.js';
import type { Stage2bRecord } from './stage2b-record.js';
import { readStage2bPrivateRecord } from './stage2b-report.js';
import {
  expandStage2bSuite,
  getStage2bTaskProfile,
  type Stage2bComplexitySize
} from './stage2b-suite.js';

export type Stage2bComplexityTaskId = 'T18' | 'T19' | 'T20' | 'T21' | 'T22' | 'T23';
export type Stage2bComplexityOperation = 'count' | 'filter-sort' | 'group-aggregate';
export type Stage2bComplexitySelection =
  | 'direct'
  | 'successful-tool'
  | 'failed-tool'
  | 'unresolved';
export type Stage2bComplexityStrategy =
  | 'direct-answer'
  | 'one-shot-query'
  | 'inspect-first'
  | 'recovered-after-error'
  | 'failed-tool'
  | 'unresolved';

export interface Stage2bComplexityReportInput {
  manifest: Stage2bBatchManifest;
  records: Stage2bRecord[];
}

export interface Stage2bComplexityPublicRun {
  taskId: Stage2bComplexityTaskId;
  operation: Stage2bComplexityOperation;
  size: Stage2bComplexitySize;
  condition: 'description';
  repetition: 1;
  status: Stage2bRecord['status'];
  taskSuccess: boolean | null;
  toolAttempted: boolean;
  successfulToolUse: boolean;
  selection: Stage2bComplexitySelection;
  firstCallOutcome: Stage2bProcessAnalysis['firstCallOutcome'];
  strategy: Stage2bComplexityStrategy;
  tracePath: string[];
  turns: number;
  toolCalls: number;
  usage: ModelUsage;
}

export interface Stage2bComplexityMatrixCell {
  taskId: Stage2bComplexityTaskId;
  operation: Stage2bComplexityOperation;
  size: Stage2bComplexitySize;
  taskSuccess: boolean | null;
  selection: Stage2bComplexitySelection;
  strategy: Stage2bComplexityStrategy;
  turns: number;
  toolCalls: number;
  totalTokens: number;
}

export interface Stage2bComplexityReport {
  version: 1;
  scope: 'complexity-calibration-observations';
  suite: 'complexity-v1';
  createdAt: string;
  provider: 'deepseek';
  model: 'deepseek-v4-flash';
  thinking: 'none';
  sampling: { temperature: number | null };
  repetitions: 1;
  limits: Stage2bRecord['limits'];
  counts: {
    total: number;
    completed: number;
    failed: number;
    taskSuccess: number;
    toolAttempted: number;
    successfulToolUse: number;
    directAnswers: number;
    limitExceeded: number;
  };
  usage: ModelUsage;
  turns: number;
  toolCalls: number;
  calibration: {
    usable: boolean;
    correctDirectAnswers: number;
    correctSuccessfulToolUses: number;
    scaleSwitchOperations: Stage2bComplexityOperation[];
  };
  runs: Stage2bComplexityPublicRun[];
  matrix: Stage2bComplexityMatrixCell[];
}

export function summarizeStage2bComplexityBatch(
  input: Stage2bComplexityReportInput
): Stage2bComplexityReport {
  const manifest = requireComplexityManifest(input.manifest);
  validateComplexityPlan(manifest);
  if (input.records.length !== manifest.runs.length) {
    throw new Error('Stage 2B complexity record count does not match its manifest.');
  }
  const records = new Map(input.records.map(record => [record.runId, record]));
  if (records.size !== input.records.length) {
    throw new Error('Stage 2B complexity records contain duplicate run IDs.');
  }
  const runs = manifest.runs.map(run => complexityRun(manifest, run, records));
  const correctDirectAnswers = runs.filter(run => (
    run.taskSuccess === true && run.selection === 'direct'
  )).length;
  const correctSuccessfulToolUses = runs.filter(run => (
    run.taskSuccess === true && run.selection === 'successful-tool'
  )).length;
  return {
    version: 1,
    scope: 'complexity-calibration-observations',
    suite: 'complexity-v1',
    createdAt: manifest.createdAt,
    provider: manifest.provider,
    model: manifest.model,
    thinking: manifest.thinking,
    sampling: { ...manifest.sampling },
    repetitions: 1,
    limits: { ...manifest.limits },
    counts: {
      total: runs.length,
      completed: runs.filter(run => run.status === 'completed').length,
      failed: runs.filter(run => run.status !== 'completed').length,
      taskSuccess: runs.filter(run => run.taskSuccess === true).length,
      toolAttempted: runs.filter(run => run.toolAttempted).length,
      successfulToolUse: runs.filter(run => run.successfulToolUse).length,
      directAnswers: runs.filter(run => run.selection === 'direct').length,
      limitExceeded: runs.filter(run => run.status === 'limit-exceeded').length
    },
    usage: sumUsage(runs),
    turns: runs.reduce((sum, run) => sum + run.turns, 0),
    toolCalls: runs.reduce((sum, run) => sum + run.toolCalls, 0),
    calibration: {
      usable: correctDirectAnswers > 0 && correctSuccessfulToolUses > 0,
      correctDirectAnswers,
      correctSuccessfulToolUses,
      scaleSwitchOperations: findScaleSwitchOperations(runs)
    },
    runs,
    matrix: complexityMatrix(runs)
  };
}

export function renderStage2bComplexityMarkdown(report: Stage2bComplexityReport): string {
  const lines = [
    '# Stage 2B 复杂度校准报告',
    '',
    '本报告观察同一 Description 条件下，数据规模与操作复杂度对直接作答和 jq_query 工具使用的影响。六项结果均作为模型行为观测，是否调用工具不作为通过或失败标准。',
    '',
    '## 校准结论',
    '',
    `**校准可用：${report.calibration.usable ? '是' : '否'}**`,
    '',
    `- 正确的直接作答：${report.calibration.correctDirectAnswers}`,
    `- 正确的成功工具使用：${report.calibration.correctSuccessfulToolUses}`,
    `- 随规模由直接作答切换到成功工具使用的操作：${report.calibration.scaleSwitchOperations.join('、') || '未观察到'}`,
    '',
    '## 批次配置',
    '',
    '| 模型 | 温度 | 最大回合 | 最大工具调用 |',
    '|---|---:|---:|---:|',
    `| ${report.model} | ${report.sampling.temperature ?? 'provider-default'} | ${report.limits.maxTurns} | ${report.limits.maxToolCalls} |`,
    '',
    '## 总体结果',
    '',
    '| 完成 | 任务成功 | 尝试工具 | 成功使用工具 | 直接作答 | 回合 | 工具调用 | 总 Token |',
    '|---:|---:|---:|---:|---:|---:|---:|---:|',
    `| ${report.counts.completed}/${report.counts.total} | ${report.counts.taskSuccess}/${report.counts.total} | ${report.counts.toolAttempted}/${report.counts.total} | ${report.counts.successfulToolUse}/${report.counts.total} | ${report.counts.directAnswers}/${report.counts.total} | ${report.turns} | ${report.toolCalls} | ${report.usage.totalTokens} |`,
    '',
    '## 复杂度矩阵',
    '',
    '| 操作 | 规模 | 任务 | 任务成功 | 选择 | 策略 | 回合 | 工具调用 | 总 Token |',
    '|---|---|---|---|---|---|---:|---:|---:|',
    ...report.matrix.map(cell => `| ${operationLabel(cell.operation)} | ${sizeLabel(cell.size)} | ${cell.taskId} | ${formatNullable(cell.taskSuccess)} | ${selectionLabel(cell.selection)} | ${strategyLabel(cell.strategy)} | ${cell.turns} | ${cell.toolCalls} | ${cell.totalTokens} |`),
    '',
    '## 逐项观测',
    '',
    '| 任务 | 操作 | 规模 | 状态 | 首次调用 | 安全路径 |',
    '|---|---|---|---|---|---|',
    ...report.runs.map(run => `| ${run.taskId} | ${operationLabel(run.operation)} | ${sizeLabel(run.size)} | ${run.status} | ${run.firstCallOutcome} | ${run.tracePath.join(' -> ') || 'no-call'} |`),
    '',
    '## 解读边界',
    '',
    '- 每个任务只有一次观测，结果用于找到后续实验的候选难度，不用于统计推断。',
    '- 中型数据包含对应小型数据的全部行，但不同操作仍可能形成不同的工具选择边界。',
    '- 工具调用成功不等于任务答案正确；两项指标在报告中独立记录。',
    '- 公开报告不包含原始 filter、工具输出、模型最终答案、记录 ID、调用 ID、绝对路径或凭据。',
    ''
  ];
  return lines.join('\n');
}

export async function writeStage2bComplexityReport(options: {
  repositoryRoot: string;
  batchId: string;
}): Promise<{ report: Stage2bComplexityReport; jsonPath: string; markdownPath: string }> {
  const repositoryRoot = resolve(options.repositoryRoot);
  const input = await loadComplexityBatch(repositoryRoot, options.batchId);
  const report = summarizeStage2bComplexityBatch(input);
  const resultsRoot = await ensurePublicResultsDirectory(repositoryRoot);
  const jsonPath = join(resultsRoot, 'observations.json');
  const markdownPath = join(resultsRoot, 'report.zh.md');
  await writePublicFileAtomic(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await writePublicFileAtomic(markdownPath, renderStage2bComplexityMarkdown(report));
  return { report, jsonPath, markdownPath };
}

function requireComplexityManifest(
  manifest: Stage2bBatchManifest
): Extract<Stage2bBatchManifest, { version: 2 }> {
  if (manifest.version !== 2 || manifest.suite !== 'complexity-v1') {
    throw new Error('Stage 2B complexity reporting requires a version 2 complexity-v1 manifest.');
  }
  if (manifest.repetitions !== 1) {
    throw new Error('Stage 2B complexity calibration requires exactly one repetition.');
  }
  if (manifest.runs.some(run => run.status === 'pending' || run.status === 'running')) {
    throw new Error('Stage 2B complexity batch is not terminal.');
  }
  return manifest;
}

function validateComplexityPlan(manifest: Extract<Stage2bBatchManifest, { version: 2 }>): void {
  const expected = expandStage2bSuite('complexity-v1', 1);
  if (manifest.totalRuns !== expected.length || manifest.runs.length !== expected.length) {
    throw new Error('Stage 2B complexity batch size mismatch.');
  }
  expected.forEach((planned, index) => {
    const actual = manifest.runs[index];
    if (
      !actual
      || actual.taskId !== planned.taskId
      || actual.condition !== planned.condition
      || actual.repetition !== 1
      || actual.runKey !== `${planned.taskId}-${planned.condition}-r1`
    ) throw new Error('Stage 2B complexity batch plan mismatch.');
  });
}

function complexityRun(
  manifest: Extract<Stage2bBatchManifest, { version: 2 }>,
  run: Stage2bBatchRun,
  records: Map<string, Stage2bRecord>
): Stage2bComplexityPublicRun {
  if (!isComplexityTaskId(run.taskId) || run.condition !== 'description' || run.repetition !== 1) {
    throw new Error('Stage 2B complexity manifest contains an invalid run identity.');
  }
  if (run.status === 'pending' || run.status === 'running') {
    throw new Error('Stage 2B complexity batch is not terminal.');
  }
  const record = records.get(run.recordRunId);
  if (!record) throw new Error(`Stage 2B complexity record is missing for ${run.runKey}.`);
  const expectedTerminalStatus = record.status === 'completed' ? 'completed' : 'failed';
  if (run.status !== expectedTerminalStatus) {
    throw new Error(`Stage 2B complexity terminal status mismatch for ${run.runKey}.`);
  }
  if (
    record.version !== 1
    || record.taskId !== run.taskId
    || record.condition !== 'description'
    || record.skill !== undefined
  ) throw new Error(`Stage 2B complexity record identity mismatch for ${run.runKey}.`);
  if (
    record.status !== run.recordStatus
    || record.taskSuccess !== run.taskSuccess
    || record.recoverySuccess !== run.recoverySuccess
  ) throw new Error(`Stage 2B complexity record outcome mismatch for ${run.runKey}.`);
  if (
    record.provider !== manifest.provider
    || record.model !== manifest.model
    || record.thinking !== manifest.thinking
    || record.sampling.temperature !== manifest.sampling.temperature
    || !sameLimits(record.limits, manifest.limits)
  ) throw new Error(`Stage 2B complexity record configuration mismatch for ${run.runKey}.`);

  const profile = getStage2bTaskProfile(run.taskId);
  if (!profile.calibration) throw new Error(`Stage 2B complexity metadata is missing for ${run.taskId}.`);
  const process = analyzeStage2bProcess({
    taskId: run.taskId,
    taskSuccess: record.taskSuccess,
    toolEvents: record.toolEvents
  });
  const toolAttempted = record.toolEvents.some(event => (
    event.type === 'function_call' && event.name === 'jq_query'
  ));
  const successfulToolUse = process.tracePath.some(step => step.endsWith(':ok'));
  const selection: Stage2bComplexitySelection = !toolAttempted
    ? record.status === 'completed' ? 'direct' : 'unresolved'
    : successfulToolUse
      ? 'successful-tool'
      : 'failed-tool';
  return {
    taskId: run.taskId,
    operation: publicOperation(profile.calibration.operation),
    size: profile.calibration.size,
    condition: 'description',
    repetition: 1,
    status: record.status,
    taskSuccess: record.taskSuccess,
    toolAttempted,
    successfulToolUse,
    selection,
    firstCallOutcome: process.firstCallOutcome,
    strategy: complexityStrategy(selection, process.strategy),
    tracePath: [...process.tracePath],
    turns: record.turns,
    toolCalls: record.toolCalls,
    usage: { ...record.usage }
  };
}

function complexityStrategy(
  selection: Stage2bComplexitySelection,
  strategy: Stage2bProcessAnalysis['strategy']
): Stage2bComplexityStrategy {
  if (selection === 'direct') return 'direct-answer';
  if (selection === 'failed-tool') return 'failed-tool';
  if (selection === 'unresolved') return 'unresolved';
  if (
    strategy === 'one-shot-query'
    || strategy === 'inspect-first'
    || strategy === 'recovered-after-error'
  ) return strategy;
  return 'unresolved';
}

function complexityMatrix(runs: Stage2bComplexityPublicRun[]): Stage2bComplexityMatrixCell[] {
  const operationOrder: Stage2bComplexityOperation[] = ['count', 'filter-sort', 'group-aggregate'];
  const sizeOrder: Stage2bComplexitySize[] = ['small', 'medium'];
  return operationOrder.flatMap(operation => sizeOrder.map(size => {
    const run = runs.find(candidate => candidate.operation === operation && candidate.size === size);
    if (!run) throw new Error(`Stage 2B complexity matrix cell is missing: ${operation}/${size}.`);
    return {
      taskId: run.taskId,
      operation,
      size,
      taskSuccess: run.taskSuccess,
      selection: run.selection,
      strategy: run.strategy,
      turns: run.turns,
      toolCalls: run.toolCalls,
      totalTokens: run.usage.totalTokens
    };
  }));
}

function findScaleSwitchOperations(
  runs: Stage2bComplexityPublicRun[]
): Stage2bComplexityOperation[] {
  const operations: Stage2bComplexityOperation[] = ['count', 'filter-sort', 'group-aggregate'];
  return operations.filter(operation => {
    const small = runs.find(run => run.operation === operation && run.size === 'small');
    const medium = runs.find(run => run.operation === operation && run.size === 'medium');
    return small?.taskSuccess === true
      && small.selection === 'direct'
      && medium?.taskSuccess === true
      && medium.selection === 'successful-tool';
  });
}

async function loadComplexityBatch(
  repositoryRoot: string,
  batchId: string
): Promise<Stage2bComplexityReportInput> {
  const { manifest } = await readStage2bBatchManifest(repositoryRoot, batchId);
  requireComplexityManifest(manifest);
  const records: Stage2bRecord[] = [];
  for (const run of manifest.runs) {
    if (run.status === 'pending' || run.status === 'running') {
      throw new Error('Stage 2B complexity batch is not terminal.');
    }
    records.push(await readStage2bPrivateRecord(repositoryRoot, run.recordRunId));
  }
  return { manifest, records };
}

async function ensurePublicResultsDirectory(repositoryRoot: string): Promise<string> {
  let current = resolve(repositoryRoot);
  await validatePublicDirectory(current);
  for (const segment of ['experiments', 'stage-2b', 'results', 'complexity-v1']) {
    current = join(current, segment);
    try {
      await mkdir(current, { mode: 0o755 });
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error;
    }
    await validatePublicDirectory(current);
  }
  await chmod(current, 0o755);
  return current;
}

async function validatePublicDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error('Unsafe Stage 2B complexity results directory.');
  }
}

async function writePublicFileAtomic(destination: string, text: string): Promise<void> {
  const temporary = join(dirname(destination), `.complexity-${randomBytes(8).toString('hex')}.tmp`);
  let created = false;
  try {
    const handle = await open(temporary, 'wx', 0o644);
    created = true;
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, destination);
    created = false;
    await chmod(destination, 0o644);
  } finally {
    if (created) await unlink(temporary).catch(() => undefined);
  }
}

function isComplexityTaskId(taskId: string): taskId is Stage2bComplexityTaskId {
  return ['T18', 'T19', 'T20', 'T21', 'T22', 'T23'].includes(taskId);
}

function publicOperation(operation: 'count' | 'filter' | 'group'): Stage2bComplexityOperation {
  return operation === 'filter' ? 'filter-sort' : operation === 'group' ? 'group-aggregate' : 'count';
}

function sumUsage(runs: Stage2bComplexityPublicRun[]): ModelUsage {
  return runs.reduce<ModelUsage>((sum, run) => ({
    inputTokens: sum.inputTokens + run.usage.inputTokens,
    cachedInputTokens: sum.cachedInputTokens + run.usage.cachedInputTokens,
    outputTokens: sum.outputTokens + run.usage.outputTokens,
    reasoningOutputTokens: sum.reasoningOutputTokens + run.usage.reasoningOutputTokens,
    totalTokens: sum.totalTokens + run.usage.totalTokens
  }), {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0
  });
}

function sameLimits(left: Stage2bRecord['limits'], right: Stage2bRecord['limits']): boolean {
  return left.maxTurns === right.maxTurns
    && left.maxToolCalls === right.maxToolCalls
    && left.requestTimeoutMs === right.requestTimeoutMs
    && left.totalTimeoutMs === right.totalTimeoutMs;
}

function formatNullable(value: boolean | null): string {
  return value === null ? 'N/A' : value ? '是' : '否';
}

function operationLabel(operation: Stage2bComplexityOperation): string {
  return operation === 'count' ? '计数' : operation === 'filter-sort' ? '筛选并排序' : '分组聚合';
}

function sizeLabel(size: Stage2bComplexitySize): string {
  return size === 'small' ? '小（6 行）' : '中（24 行）';
}

function selectionLabel(selection: Stage2bComplexitySelection): string {
  if (selection === 'direct') return '直接作答';
  if (selection === 'successful-tool') return '成功使用工具';
  if (selection === 'failed-tool') return '工具调用未成功';
  return '未形成可判定行为';
}

function strategyLabel(strategy: Stage2bComplexityStrategy): string {
  const labels: Record<Stage2bComplexityStrategy, string> = {
    'direct-answer': '直接作答',
    'one-shot-query': '一次查询',
    'inspect-first': '先检查结构',
    'recovered-after-error': '错误后恢复',
    'failed-tool': '仅失败调用',
    unresolved: '未归类'
  };
  return labels[strategy];
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
