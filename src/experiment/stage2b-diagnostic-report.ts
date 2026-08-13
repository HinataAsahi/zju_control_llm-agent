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
  evaluateStage2bRecovery,
  type Stage2bProcessAnalysis
} from './stage2b-evaluation.js';
import {
  readStage2bReportRecord,
  type MetricSummary,
  type Stage2bReportRecord
} from './stage2b-report.js';
import type { Stage2bRecord } from './stage2b-record.js';
import { expandStage2bSuite } from './stage2b-suite.js';

export type Stage2bDiagnosticTaskId = 'T9' | 'T10' | 'T11';

export interface Stage2bDiagnosticReportInput {
  manifest: Stage2bBatchManifest;
  records: Stage2bReportRecord[];
}

export interface Stage2bDiagnosticPublicRun extends Stage2bProcessAnalysis {
  taskId: Stage2bDiagnosticTaskId;
  condition: 'explicit' | 'description' | 'skill';
  repetition: number;
  status: Stage2bRecord['status'];
  taskSuccess: boolean | null;
  recoverySuccess: boolean | null;
  turns: number;
  toolCalls: number;
  usage: ModelUsage;
}

export interface Stage2bDiagnosticCell {
  taskId: Stage2bDiagnosticTaskId;
  condition: 'explicit' | 'description' | 'skill';
  observations: number;
  completed: number;
  taskSuccess: number;
  toolCompliance: number;
  recoverySuccess: number;
  recoveryApplicable: number;
  firstCallOutcomes: Record<string, number>;
  strategies: Record<string, number>;
  turns: MetricSummary;
  toolCalls: MetricSummary;
  totalTokens: MetricSummary & { sum: number };
}

export interface Stage2bDiagnosticReport {
  version: 4;
  scope: 'diagnostic-observations';
  suite: 'diagnostic-v1';
  batchId: string;
  repeatBatchId?: string;
  createdAt: string;
  provider: 'deepseek';
  model: 'deepseek-v4-flash';
  thinking: 'none';
  sampling: { temperature: number | null };
  repetitions: number;
  limits: Stage2bRecord['limits'];
  counts: {
    total: number;
    completed: number;
    failed: number;
    taskSuccess: number;
    toolCompliance: number;
    recoverySuccess: number;
    recoveryApplicable: number;
    limitExceeded: number;
  };
  usage: ModelUsage;
  turns: number;
  toolCalls: number;
  runs: Stage2bDiagnosticPublicRun[];
  cells: Stage2bDiagnosticCell[];
}

export function summarizeStage2bDiagnosticBatch(
  input: Stage2bDiagnosticReportInput
): Stage2bDiagnosticReport {
  const { manifest } = input;
  validateDiagnosticManifest(manifest);
  if (input.records.length !== manifest.runs.length) {
    throw new Error('Stage 2B diagnostic record count does not match its manifest.');
  }
  const records = new Map(input.records.map(record => [record.runId, record]));
  if (records.size !== input.records.length) {
    throw new Error('Stage 2B diagnostic records contain duplicate run IDs.');
  }

  const runs = manifest.runs.map(run => diagnosticRun(manifest, run, records));
  return buildDiagnosticReport(manifest, runs);
}

export function summarizeStage2bDiagnosticBatches(
  initial: Stage2bDiagnosticReportInput,
  repeat: Stage2bDiagnosticReportInput
): Stage2bDiagnosticReport {
  validateDiagnosticManifest(initial.manifest);
  validateDiagnosticManifest(repeat.manifest);
  const initialReport = summarizeStage2bDiagnosticBatch(initial);
  const repeatReport = summarizeStage2bDiagnosticBatch(repeat);
  if (initialReport.batchId === repeatReport.batchId) {
    throw new Error('Stage 2B diagnostic report batches must be distinct.');
  }
  const recordIds = [...initial.records, ...repeat.records].map(record => record.runId);
  if (new Set(recordIds).size !== recordIds.length) {
    throw new Error('Stage 2B diagnostic report batches contain duplicate record IDs.');
  }
  if (!sameDiagnosticConfiguration(initialReport, repeatReport)) {
    throw new Error('Stage 2B diagnostic report batch configuration mismatch.');
  }

  const repeatRuns = repeatReport.runs.map(run => ({
    ...run,
    repetition: run.repetition + initialReport.repetitions
  }));
  return buildDiagnosticReport(
    initial.manifest,
    [...initialReport.runs, ...repeatRuns],
    repeatReport.batchId,
    initialReport.repetitions + repeatReport.repetitions
  );
}

function buildDiagnosticReport(
  manifest: Extract<Stage2bBatchManifest, { version: 2 }>,
  runs: Stage2bDiagnosticPublicRun[],
  repeatBatchId?: string,
  repetitions = manifest.repetitions
): Stage2bDiagnosticReport {
  return {
    version: 4,
    scope: 'diagnostic-observations',
    suite: 'diagnostic-v1',
    batchId: manifest.batchId,
    ...(repeatBatchId === undefined ? {} : { repeatBatchId }),
    createdAt: manifest.createdAt,
    provider: manifest.provider,
    model: manifest.model,
    thinking: manifest.thinking,
    sampling: { ...manifest.sampling },
    repetitions,
    limits: { ...manifest.limits },
    counts: {
      total: runs.length,
      completed: runs.filter(run => run.status === 'completed').length,
      failed: runs.filter(run => run.status !== 'completed').length,
      taskSuccess: runs.filter(run => run.taskSuccess === true).length,
      toolCompliance: runs.filter(run => run.toolCompliance).length,
      recoverySuccess: runs.filter(run => run.recoverySuccess === true).length,
      recoveryApplicable: runs.filter(run => run.recoverySuccess !== null).length,
      limitExceeded: runs.filter(run => run.status === 'limit-exceeded').length
    },
    usage: sumUsage(runs),
    turns: runs.reduce((sum, run) => sum + run.turns, 0),
    toolCalls: runs.reduce((sum, run) => sum + run.toolCalls, 0),
    runs,
    cells: diagnosticCells(runs)
  };
}

export function renderStage2bDiagnosticMarkdown(report: Stage2bDiagnosticReport): string {
  const batchDescription = report.repeatBatchId === undefined
    ? '本报告汇总一个 diagnostic-v1 批次，用于观察工具边界、一次查询、结构检查与错误后恢复。结果仅作描述性分析。'
    : '本报告合并一个 diagnostic-v1 首轮批次与一个完整重复批次，用于复核工具边界、一次查询、结构检查与错误后恢复。结果仅作描述性分析。';
  const batchLabel = report.repeatBatchId === undefined
    ? report.batchId
    : `${report.batchId}<br>${report.repeatBatchId}`;
  const lines = [
    '# Stage 2B 诊断观测报告',
    '',
    batchDescription,
    '',
    '## 批次配置',
    '',
    '| 批次 | 模型 | 温度 | 最大回合 | 最大工具调用 | 重复数 |',
    '|---|---|---:|---:|---:|---:|',
    `| ${batchLabel} | ${report.model} | ${report.sampling.temperature ?? 'provider-default'} | ${report.limits.maxTurns} | ${report.limits.maxToolCalls} | ${report.repetitions} |`,
    '',
    '## 总体结果',
    '',
    '| 完成 | 任务成功 | 工具合规 | 恢复成功（可判定） | 回合 | 工具调用 | 总 Token |',
    '|---:|---:|---:|---:|---:|---:|---:|',
    `| ${report.counts.completed}/${report.counts.total} | ${report.counts.taskSuccess}/${report.counts.total} | ${report.counts.toolCompliance}/${report.counts.total} | ${formatRatio(report.counts.recoverySuccess, report.counts.recoveryApplicable)} | ${report.turns} | ${report.toolCalls} | ${report.usage.totalTokens} |`,
    '',
    '## 任务与条件单元格',
    '',
    '| 任务 | 条件 | 观测 | 任务成功 | 工具合规 | 恢复成功（可判定） | 首次调用结果 | 策略 | 回合 min-max / mean | 工具调用 min-max / mean | Token min-max / mean |',
    '|---|---|---:|---:|---:|---:|---|---|---:|---:|---:|',
    ...report.cells.map(cell => `| ${cell.taskId} | ${cell.condition} | ${cell.observations} | ${cell.taskSuccess}/${cell.observations} | ${cell.toolCompliance}/${cell.observations} | ${formatRatio(cell.recoverySuccess, cell.recoveryApplicable)} | ${formatCounts(cell.firstCallOutcomes)} | ${formatCounts(cell.strategies)} | ${formatMetric(cell.turns)} | ${formatMetric(cell.toolCalls)} | ${formatMetric(cell.totalTokens)} |`),
    '',
    '## 逐项观测',
    '',
    '| 任务 | 条件 | 重复 | 状态 | 任务成功 | 工具合规 | 首次调用 | 策略 | 恢复成功 | 路径 | 回合 | 工具调用 | 总 Token |',
    '|---|---|---:|---|---|---|---|---|---|---|---:|---:|---:|',
    ...report.runs.map(run => `| ${run.taskId} | ${run.condition} | ${run.repetition} | ${run.status} | ${formatNullable(run.taskSuccess)} | ${run.toolCompliance ? '是' : '否'} | ${run.firstCallOutcome} | ${run.strategy} | ${formatNullable(run.recoverySuccess)} | ${run.tracePath.join(' -> ') || 'no-call'} | ${run.turns} | ${run.toolCalls} | ${run.usage.totalTokens} |`),
    '',
    '## 任务解释重点',
    '',
    '- T9 观察在工具不适用时是否避免工具；avoided-tool 表示遵守边界，unnecessary-tool 表示发生了不必要调用。',
    '- T10 观察一次复合查询能否完成聚合；one-shot-query 只表示首个目标查询成功且最终答案正确。',
    '- T11 区分 inspect-first 的错误预防与 recovered-after-error 的真实错误后恢复。',
    '',
    '## 解读边界',
    '',
    '- 当前是小样本诊断观测，不进行显著性检验，也不证明因果关系或稳定的条件差异。',
    '- Explicit 条件可能因直接指令获得优势，因此不能把差异仅归因于工具描述或 Skill。',
    '- 实验只有一个 jq 工具，结论不能直接外推到多工具选择、规划或开放环境。',
    '- 工具返回 ok 只代表调用成功，任务正确性由独立的规范答案比较决定。',
    '- 公开报告不包含原始 filter、工具输出、模型解释、记录 ID、调用 ID、绝对路径或凭据。',
    ''
  ];
  return lines.join('\n');
}

export async function writeStage2bDiagnosticReport(options: {
  repositoryRoot: string;
  batchId: string;
  repeatBatchId?: string;
}): Promise<{
  report: Stage2bDiagnosticReport;
  jsonPath: string;
  markdownPath: string;
}> {
  const repositoryRoot = resolve(options.repositoryRoot);
  const initial = await loadDiagnosticReportInput(repositoryRoot, options.batchId);
  const repeat = options.repeatBatchId === undefined
    ? undefined
    : await loadDiagnosticReportInput(repositoryRoot, options.repeatBatchId);
  const report = repeat === undefined
    ? summarizeStage2bDiagnosticBatch(initial)
    : summarizeStage2bDiagnosticBatches(initial, repeat);
  const resultsRoot = await ensurePublicResultsDirectory(repositoryRoot);
  const jsonPath = join(resultsRoot, 'observations.json');
  const markdownPath = join(resultsRoot, 'report.zh.md');
  await writePublicFileAtomic(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await writePublicFileAtomic(markdownPath, renderStage2bDiagnosticMarkdown(report));
  return { report, jsonPath, markdownPath };
}

async function loadDiagnosticReportInput(
  repositoryRoot: string,
  batchId: string
): Promise<Stage2bDiagnosticReportInput> {
  const { manifest } = await readStage2bBatchManifest(repositoryRoot, batchId);
  validateDiagnosticManifest(manifest);
  const records: Stage2bReportRecord[] = [];
  for (const run of manifest.runs) {
    if (run.status === 'pending' || run.status === 'running') {
      throw new Error('Stage 2B diagnostic batch is not terminal.');
    }
    records.push(await readStage2bReportRecord(repositoryRoot, run.recordRunId));
  }
  return { manifest, records };
}

function validateDiagnosticManifest(
  manifest: Stage2bBatchManifest
): asserts manifest is Extract<Stage2bBatchManifest, { version: 2 }> {
  if (manifest.version !== 2 || manifest.suite !== 'diagnostic-v1') {
    throw new Error('Stage 2B diagnostic reporting requires a version 2 diagnostic manifest.');
  }
  if (manifest.runs.some(run => run.status === 'pending' || run.status === 'running')) {
    throw new Error('Stage 2B diagnostic batch is not terminal.');
  }
  const expected = expandStage2bSuite('diagnostic-v1', manifest.repetitions);
  if (manifest.totalRuns !== expected.length || manifest.runs.length !== expected.length) {
    throw new Error('Stage 2B diagnostic batch size mismatch.');
  }
  expected.forEach((planned, index) => {
    const run = manifest.runs[index];
    if (
      !run
      || run.taskId !== planned.taskId
      || run.condition !== planned.condition
      || run.repetition !== planned.repetition
      || run.runKey !== `${planned.taskId}-${planned.condition}-r${planned.repetition}`
    ) {
      throw new Error('Stage 2B diagnostic batch plan mismatch.');
    }
  });
}

function diagnosticRun(
  manifest: Extract<Stage2bBatchManifest, { version: 2 }>,
  run: Stage2bBatchRun,
  records: Map<string, Stage2bReportRecord>
): Stage2bDiagnosticPublicRun {
  if (!isDiagnosticTaskId(run.taskId)) {
    throw new Error('Stage 2B diagnostic manifest contains a non-diagnostic task.');
  }
  if (run.status === 'pending' || run.status === 'running') {
    throw new Error('Stage 2B diagnostic batch is not terminal.');
  }
  const record = records.get(run.recordRunId);
  if (!record) throw new Error(`Stage 2B diagnostic record is missing for ${run.runKey}.`);
  const expectedTerminalStatus = record.status === 'completed' ? 'completed' : 'failed';
  if (run.status !== expectedTerminalStatus) {
    throw new Error(`Stage 2B diagnostic terminal status does not match its record for ${run.runKey}.`);
  }
  if (record.taskId !== run.taskId || record.condition !== run.condition) {
    throw new Error(`Stage 2B diagnostic record identity mismatch for ${run.runKey}.`);
  }
  if (
    record.status !== run.recordStatus
    || record.taskSuccess !== run.taskSuccess
    || record.recoverySuccess !== run.recoverySuccess
  ) {
    throw new Error(`Stage 2B diagnostic record outcome mismatch for ${run.runKey}.`);
  }
  if (
    record.provider !== manifest.provider
    || record.model !== manifest.model
    || record.thinking !== manifest.thinking
    || record.sampling.temperature !== manifest.sampling.temperature
    || !sameLimits(record.limits, manifest.limits)
  ) {
    throw new Error(`Stage 2B diagnostic record configuration mismatch for ${run.runKey}.`);
  }
  const process = analyzeStage2bProcess({
    taskId: run.taskId,
    taskSuccess: record.taskSuccess,
    toolEvents: record.toolEvents
  });
  const recoverySuccess = evaluateStage2bRecovery({
    taskId: run.taskId,
    status: record.status,
    taskSuccess: record.taskSuccess,
    toolEvents: record.toolEvents
  });
  if (recoverySuccess !== record.recoverySuccess) {
    throw new Error(`Stage 2B diagnostic derived recovery mismatch for ${run.runKey}.`);
  }
  return {
    taskId: run.taskId,
    condition: run.condition as Stage2bDiagnosticPublicRun['condition'],
    repetition: run.repetition,
    status: record.status,
    taskSuccess: record.taskSuccess,
    recoverySuccess,
    turns: record.turns,
    toolCalls: record.toolCalls,
    usage: { ...record.usage },
    ...process
  };
}

function diagnosticCells(runs: Stage2bDiagnosticPublicRun[]): Stage2bDiagnosticCell[] {
  const keys: string[] = [];
  const grouped = new Map<string, Stage2bDiagnosticPublicRun[]>();
  for (const run of runs) {
    const key = `${run.taskId}/${run.condition}`;
    if (!grouped.has(key)) keys.push(key);
    grouped.set(key, [...(grouped.get(key) ?? []), run]);
  }
  return keys.map(key => {
    const cellRuns = grouped.get(key)!;
    const first = cellRuns[0]!;
    return {
      taskId: first.taskId,
      condition: first.condition,
      observations: cellRuns.length,
      completed: cellRuns.filter(run => run.status === 'completed').length,
      taskSuccess: cellRuns.filter(run => run.taskSuccess === true).length,
      toolCompliance: cellRuns.filter(run => run.toolCompliance).length,
      recoverySuccess: cellRuns.filter(run => run.recoverySuccess === true).length,
      recoveryApplicable: cellRuns.filter(run => run.recoverySuccess !== null).length,
      firstCallOutcomes: countLabels(cellRuns.map(run => run.firstCallOutcome)),
      strategies: countLabels(cellRuns.map(run => run.strategy)),
      turns: summarizeMetric(cellRuns.map(run => run.turns)),
      toolCalls: summarizeMetric(cellRuns.map(run => run.toolCalls)),
      totalTokens: {
        ...summarizeMetric(cellRuns.map(run => run.usage.totalTokens)),
        sum: cellRuns.reduce((sum, run) => sum + run.usage.totalTokens, 0)
      }
    };
  });
}

function countLabels(labels: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const label of labels) counts[label] = (counts[label] ?? 0) + 1;
  return counts;
}

function sumUsage(runs: Stage2bDiagnosticPublicRun[]): ModelUsage {
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

function summarizeMetric(values: number[]): MetricSummary {
  const sum = values.reduce((total, value) => total + value, 0);
  return {
    min: Math.min(...values),
    max: Math.max(...values),
    mean: Number((sum / values.length).toFixed(2))
  };
}

function sameLimits(left: Stage2bRecord['limits'], right: Stage2bRecord['limits']): boolean {
  return left.maxTurns === right.maxTurns
    && left.maxToolCalls === right.maxToolCalls
    && left.requestTimeoutMs === right.requestTimeoutMs
    && left.totalTimeoutMs === right.totalTimeoutMs;
}

function sameDiagnosticConfiguration(
  left: Stage2bDiagnosticReport,
  right: Stage2bDiagnosticReport
): boolean {
  return left.provider === right.provider
    && left.model === right.model
    && left.thinking === right.thinking
    && left.sampling.temperature === right.sampling.temperature
    && sameLimits(left.limits, right.limits);
}

function isDiagnosticTaskId(taskId: string): taskId is Stage2bDiagnosticTaskId {
  return taskId === 'T9' || taskId === 'T10' || taskId === 'T11';
}

function formatNullable(value: boolean | null): string {
  return value === null ? 'N/A' : value ? '是' : '否';
}

function formatRatio(numerator: number, denominator: number): string {
  return denominator === 0 ? 'N/A' : `${numerator}/${denominator}`;
}

function formatMetric(metric: MetricSummary): string {
  return `${metric.min}-${metric.max} / ${metric.mean}`;
}

function formatCounts(counts: Record<string, number>): string {
  return Object.entries(counts).map(([label, count]) => `${label} (x${count})`).join('<br>');
}

async function ensurePublicResultsDirectory(repositoryRoot: string): Promise<string> {
  let current = resolve(repositoryRoot);
  await validatePublicDirectory(current);
  for (const segment of ['experiments', 'stage-2b', 'results', 'diagnostic-v1']) {
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
    throw new Error('Unsafe Stage 2B diagnostic results directory.');
  }
}

async function writePublicFileAtomic(destination: string, text: string): Promise<void> {
  const temporary = join(dirname(destination), `.diagnostic-${randomBytes(8).toString('hex')}.tmp`);
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

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
