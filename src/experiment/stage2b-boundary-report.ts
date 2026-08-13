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
import {
  readStage2bPrivateRecord,
  type MetricSummary
} from './stage2b-report.js';
import { expandStage2bSuite } from './stage2b-suite.js';
import type { Stage2bSkillIdentity } from './stage2b-treatment.js';

export type Stage2bBoundaryTaskId = 'T12' | 'T13' | 'T14' | 'T15' | 'T16' | 'T17';
export type Stage2bBoundaryCondition = 'description' | 'skill-v1' | 'skill-v2';

export interface Stage2bBoundaryReportInput {
  manifest: Stage2bBatchManifest;
  records: Stage2bRecord[];
}

export interface Stage2bBoundaryPublicRun extends Stage2bProcessAnalysis {
  taskId: Stage2bBoundaryTaskId;
  condition: Stage2bBoundaryCondition;
  repetition: number;
  status: Stage2bRecord['status'];
  taskSuccess: boolean | null;
  turns: number;
  toolCalls: number;
  usage: ModelUsage;
}

export interface Stage2bBoundaryCell {
  taskId: Stage2bBoundaryTaskId;
  condition: Stage2bBoundaryCondition;
  observations: number;
  taskSuccess: number;
  toolCompliance: number;
  strategies: Record<string, number>;
  turns: MetricSummary;
  toolCalls: MetricSummary;
  totalTokens: MetricSummary & { sum: number };
}

interface Ratio {
  passed: number;
  total: number;
}

export interface Stage2bBoundaryInitialGate {
  passed: boolean;
  boundaryTaskSuccess: Ratio;
  boundaryNegativeCompliance: Ratio;
  boundaryPositiveCompliance: Ratio;
  skillV1NegativeCompliance: Ratio;
  descriptionNegativeCompliance: Ratio;
  reasons: string[];
}

export interface Stage2bBoundaryConditionSummary {
  condition: Stage2bBoundaryCondition;
  taskSuccess: Ratio;
  negativeCompliance: Ratio;
  positiveCompliance: Ratio;
  turns: number;
  toolCalls: number;
  totalTokens: number;
}

export interface Stage2bBoundaryReport {
  version: 1;
  scope: 'boundary-observations';
  suite: 'boundary-v1';
  batchId: string;
  repeatBatchId?: string;
  createdAt: string;
  provider: 'deepseek';
  model: 'deepseek-v4-flash';
  thinking: 'none';
  sampling: { temperature: number | null };
  repetitions: number;
  limits: Stage2bRecord['limits'];
  skills: { v1: Stage2bSkillIdentity; v2: Stage2bSkillIdentity };
  counts: {
    total: number;
    completed: number;
    failed: number;
    taskSuccess: number;
    toolCompliance: number;
    limitExceeded: number;
  };
  usage: ModelUsage;
  turns: number;
  toolCalls: number;
  initialGate: Stage2bBoundaryInitialGate;
  conditions: Stage2bBoundaryConditionSummary[];
  runs: Stage2bBoundaryPublicRun[];
  cells: Stage2bBoundaryCell[];
}

export function summarizeStage2bBoundaryBatch(
  input: Stage2bBoundaryReportInput
): Stage2bBoundaryReport {
  const manifest = requireBoundaryManifest(input.manifest);
  validateBoundaryPlan(manifest);
  if (input.records.length !== manifest.runs.length) {
    throw new Error('Stage 2B boundary record count does not match its manifest.');
  }
  const records = new Map(input.records.map(record => [record.runId, record]));
  if (records.size !== input.records.length) {
    throw new Error('Stage 2B boundary records contain duplicate run IDs.');
  }
  const runs = manifest.runs.map(run => boundaryRun(manifest, run, records));
  return buildBoundaryReport(manifest, runs, initialGate(runs));
}

export function summarizeStage2bBoundaryBatches(
  initial: Stage2bBoundaryReportInput,
  repeat: Stage2bBoundaryReportInput
): Stage2bBoundaryReport {
  const initialManifest = requireBoundaryManifest(initial.manifest);
  const repeatManifest = requireBoundaryManifest(repeat.manifest);
  if (initialManifest.repetitions !== 1 || repeatManifest.repetitions !== 2) {
    throw new Error('Stage 2B boundary confirmation requires one initial and two repeat repetitions.');
  }
  if (initialManifest.batchId === repeatManifest.batchId) {
    throw new Error('Stage 2B boundary report batches must be distinct.');
  }
  const recordIds = [...initial.records, ...repeat.records].map(record => record.runId);
  if (new Set(recordIds).size !== recordIds.length) {
    throw new Error('Stage 2B boundary report batches contain duplicate record IDs.');
  }
  const initialReport = summarizeStage2bBoundaryBatch(initial);
  if (!initialReport.initialGate.passed) {
    throw new Error('Stage 2B boundary confirmation requires the initial gate to pass.');
  }
  if (repeatManifest.initialBatchId !== initialManifest.batchId) {
    throw new Error('Stage 2B boundary confirmation does not reference the initial batch.');
  }
  const repeatReport = summarizeStage2bBoundaryBatch(repeat);
  if (!sameBoundaryConfiguration(initialReport, repeatReport)) {
    throw new Error('Stage 2B boundary report batch configuration mismatch.');
  }
  const repeatRuns = repeatReport.runs.map(run => ({
    ...run,
    repetition: run.repetition + initialReport.repetitions
  }));
  return buildBoundaryReport(
    initialManifest,
    [...initialReport.runs, ...repeatRuns],
    initialReport.initialGate,
    repeatReport.batchId,
    initialReport.repetitions + repeatReport.repetitions
  );
}

export async function requirePassedStage2bBoundaryInitialBatch(
  repositoryRoot: string,
  batchId: string
): Promise<Stage2bBoundaryReport> {
  const input = await loadBoundaryBatch(resolve(repositoryRoot), batchId);
  const manifest = requireBoundaryManifest(input.manifest);
  if (manifest.repetitions !== 1 || manifest.initialBatchId !== undefined) {
    throw new Error('Stage 2B boundary confirmation requires one initial batch.');
  }
  const report = summarizeStage2bBoundaryBatch(input);
  if (!report.initialGate.passed) {
    throw new Error('Stage 2B boundary confirmation requires the initial gate to pass.');
  }
  return report;
}

function buildBoundaryReport(
  manifest: Extract<Stage2bBatchManifest, { version: 3 }>,
  runs: Stage2bBoundaryPublicRun[],
  gate: Stage2bBoundaryInitialGate,
  repeatBatchId?: string,
  repetitions = manifest.repetitions
): Stage2bBoundaryReport {
  return {
    version: 1,
    scope: 'boundary-observations',
    suite: 'boundary-v1',
    batchId: manifest.batchId,
    ...(repeatBatchId === undefined ? {} : { repeatBatchId }),
    createdAt: manifest.createdAt,
    provider: manifest.provider,
    model: manifest.model,
    thinking: manifest.thinking,
    sampling: { ...manifest.sampling },
    repetitions,
    limits: { ...manifest.limits },
    skills: {
      v1: { ...manifest.skills.v1 },
      v2: { ...manifest.skills.v2 }
    },
    counts: {
      total: runs.length,
      completed: runs.filter(run => run.status === 'completed').length,
      failed: runs.filter(run => run.status !== 'completed').length,
      taskSuccess: runs.filter(run => run.taskSuccess === true).length,
      toolCompliance: runs.filter(run => run.toolCompliance).length,
      limitExceeded: runs.filter(run => run.status === 'limit-exceeded').length
    },
    usage: sumUsage(runs),
    turns: runs.reduce((sum, run) => sum + run.turns, 0),
    toolCalls: runs.reduce((sum, run) => sum + run.toolCalls, 0),
    initialGate: gate,
    conditions: conditionSummaries(runs),
    runs,
    cells: boundaryCells(runs)
  };
}

export function renderStage2bBoundaryMarkdown(report: Stage2bBoundaryReport): string {
  const lines = [
    '# Stage 2B 工具边界实验报告',
    '',
    '本报告比较 Description、当前 Skill v1 与边界型 Skill v2 对 jq_query 工具选择的影响。结果仅作小样本描述性分析。',
    '',
    '## 首轮门控',
    '',
    `**首轮门控：${report.initialGate.passed ? '通过' : '未通过'}**`,
    '',
    '| 指标 | 结果 |',
    '|---|---:|',
    `| Boundary Skill v2 任务正确 | ${ratio(report.initialGate.boundaryTaskSuccess)} |`,
    `| Boundary Skill v2 纯文本负例合规 | ${ratio(report.initialGate.boundaryNegativeCompliance)} |`,
    `| Boundary Skill v2 JSON 正例合规 | ${ratio(report.initialGate.boundaryPositiveCompliance)} |`,
    `| Skill v1 纯文本负例合规 | ${ratio(report.initialGate.skillV1NegativeCompliance)} |`,
    `| Description 纯文本负例合规 | ${ratio(report.initialGate.descriptionNegativeCompliance)} |`,
    '',
    ...(report.initialGate.reasons.length === 0
      ? []
      : ['未通过原因：', '', ...report.initialGate.reasons.map(reason => `- ${reason}`), '']),
    '## 条件汇总',
    '',
    '| 条件 | 任务正确 | 纯文本负例合规 | JSON 正例合规 | 回合 | 工具调用 | 总 Token |',
    '|---|---:|---:|---:|---:|---:|---:|',
    ...report.conditions.map(summary => `| ${conditionLabel(summary.condition)} | ${ratio(summary.taskSuccess)} | ${ratio(summary.negativeCompliance)} | ${ratio(summary.positiveCompliance)} | ${summary.turns} | ${summary.toolCalls} | ${summary.totalTokens} |`),
    '',
    '## 总体结果',
    '',
    '| 完成 | 任务成功 | 工具合规 | 回合 | 工具调用 | 总 Token |',
    '|---:|---:|---:|---:|---:|---:|',
    `| ${report.counts.completed}/${report.counts.total} | ${report.counts.taskSuccess}/${report.counts.total} | ${report.counts.toolCompliance}/${report.counts.total} | ${report.turns} | ${report.toolCalls} | ${report.usage.totalTokens} |`,
    '',
    '## 任务与条件单元格',
    '',
    '| 任务 | 条件 | 观测 | 任务成功 | 工具合规 | 策略 | 回合 min-max / mean | 工具调用 min-max / mean | Token min-max / mean |',
    '|---|---|---:|---:|---:|---|---:|---:|---:|',
    ...report.cells.map(cell => `| ${cell.taskId} | ${conditionLabel(cell.condition)} | ${cell.observations} | ${cell.taskSuccess}/${cell.observations} | ${cell.toolCompliance}/${cell.observations} | ${countsLabel(cell.strategies)} | ${metricLabel(cell.turns)} | ${metricLabel(cell.toolCalls)} | ${metricLabel(cell.totalTokens)} |`),
    '',
    '## 解读边界',
    '',
    '- 首轮门控在运行前固定；只有通过后才追加两轮确认实验。',
    '- 任务正确性与工具合规分别计算，正确答案不等于工具选择合理。',
    '- Token、回合和调用次数是次要成本指标，不参与首轮门控。',
    '- 当前只有三组配对任务和一个模型，结果不能外推到其他工具、模型或开放环境。',
    '- 公开报告不包含原始 jq filter、工具输出、模型回答、记录 ID、调用 ID、本机路径或凭据。',
    ''
  ];
  return lines.join('\n');
}

export async function writeStage2bBoundaryReport(options: {
  repositoryRoot: string;
  batchId: string;
  repeatBatchId?: string;
}): Promise<{
  report: Stage2bBoundaryReport;
  jsonPath: string;
  markdownPath: string;
}> {
  const repositoryRoot = resolve(options.repositoryRoot);
  const initial = await loadBoundaryBatch(repositoryRoot, options.batchId);
  const report = options.repeatBatchId === undefined
    ? summarizeStage2bBoundaryBatch(initial)
    : summarizeStage2bBoundaryBatches(
      initial,
      await loadBoundaryBatch(repositoryRoot, options.repeatBatchId)
    );
  const resultsRoot = resolve(repositoryRoot, 'experiments/stage-2b/results/boundary-v1');
  await ensureDirectoryChain(repositoryRoot, ['experiments', 'stage-2b', 'results', 'boundary-v1']);
  const jsonPath = join(resultsRoot, 'observations.json');
  const markdownPath = join(resultsRoot, 'report.zh.md');
  await writePublicFileAtomic(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await writePublicFileAtomic(markdownPath, renderStage2bBoundaryMarkdown(report));
  return { report, jsonPath, markdownPath };
}

async function loadBoundaryBatch(
  repositoryRoot: string,
  batchId: string
): Promise<Stage2bBoundaryReportInput> {
  const { manifest } = await readStage2bBatchManifest(repositoryRoot, batchId);
  const records: Stage2bRecord[] = [];
  for (const run of manifest.runs) {
    if (run.status === 'pending' || run.status === 'running') {
      throw new Error('Stage 2B boundary batch is not terminal.');
    }
    records.push(await readStage2bPrivateRecord(repositoryRoot, run.recordRunId));
  }
  return { manifest, records };
}

async function ensureDirectoryChain(root: string, components: string[]): Promise<void> {
  let current = resolve(root);
  const rootMetadata = await lstat(current);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error('Unsafe Stage 2B boundary result root.');
  }
  for (const component of components) {
    current = join(current, component);
    try {
      await mkdir(current, { mode: 0o755 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error('Unsafe Stage 2B boundary results directory.');
    }
  }
}

async function writePublicFileAtomic(path: string, contents: string): Promise<void> {
  const temporary = join(
    dirname(path),
    `.boundary-${randomBytes(8).toString('hex')}.tmp`
  );
  let created = false;
  try {
    const handle = await open(temporary, 'wx', 0o644);
    created = true;
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    created = false;
    await chmod(path, 0o644);
  } finally {
    if (created) await unlink(temporary).catch(() => undefined);
  }
}

function boundaryRun(
  manifest: Extract<Stage2bBatchManifest, { version: 3 }>,
  run: Stage2bBatchRun,
  records: Map<string, Stage2bRecord>
): Stage2bBoundaryPublicRun {
  if (run.status === 'pending' || run.status === 'running') {
    throw new Error('Stage 2B boundary report requires a terminal batch.');
  }
  const record = records.get(run.recordRunId);
  if (!record) throw new Error(`Stage 2B boundary record is missing for ${run.runKey}.`);
  if (record.taskId !== run.taskId || record.condition !== run.condition) {
    throw new Error(`Stage 2B boundary record identity mismatch for ${run.runKey}.`);
  }
  if (
    record.status !== run.recordStatus
    || record.taskSuccess !== run.taskSuccess
    || record.recoverySuccess !== run.recoverySuccess
  ) {
    throw new Error(`Stage 2B boundary record outcome mismatch for ${run.runKey}.`);
  }
  if (
    record.provider !== manifest.provider
    || record.model !== manifest.model
    || record.thinking !== manifest.thinking
    || record.sampling.temperature !== manifest.sampling.temperature
    || !sameLimits(record.limits, manifest.limits)
  ) {
    throw new Error(`Stage 2B boundary record configuration mismatch for ${run.runKey}.`);
  }
  validateSkillIdentity(manifest, run, record);
  const process = analyzeStage2bProcess({
    taskId: run.taskId,
    taskSuccess: record.taskSuccess,
    toolEvents: record.toolEvents
  });
  const toolCompliance = isNegative(run.taskId as Stage2bBoundaryTaskId)
    ? process.toolCompliance
    : hasSuccessfulJqCall(record.toolEvents);
  return {
    taskId: run.taskId as Stage2bBoundaryTaskId,
    condition: run.condition as Stage2bBoundaryCondition,
    repetition: run.repetition,
    status: record.status,
    taskSuccess: record.taskSuccess,
    turns: record.turns,
    toolCalls: record.toolCalls,
    usage: { ...record.usage },
    ...process,
    toolCompliance
  };
}

function validateSkillIdentity(
  manifest: Extract<Stage2bBatchManifest, { version: 3 }>,
  run: Stage2bBatchRun,
  record: Stage2bRecord
): void {
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
    throw new Error(`Stage 2B boundary record skill identity mismatch for ${run.runKey}.`);
  }
}

function initialGate(runs: Stage2bBoundaryPublicRun[]): Stage2bBoundaryInitialGate {
  const boundary = runs.filter(run => run.condition === 'skill-v2');
  const boundaryNegative = boundary.filter(run => isNegative(run.taskId));
  const boundaryPositive = boundary.filter(run => !isNegative(run.taskId));
  const skillV1Negative = runs.filter(run => run.condition === 'skill-v1' && isNegative(run.taskId));
  const descriptionNegative = runs.filter(run => run.condition === 'description' && isNegative(run.taskId));
  const gate = {
    boundaryTaskSuccess: countRatio(boundary, run => run.taskSuccess === true),
    boundaryNegativeCompliance: countRatio(boundaryNegative, run => run.toolCompliance),
    boundaryPositiveCompliance: countRatio(boundaryPositive, run => run.toolCompliance),
    skillV1NegativeCompliance: countRatio(skillV1Negative, run => run.toolCompliance),
    descriptionNegativeCompliance: countRatio(descriptionNegative, run => run.toolCompliance)
  };
  const reasons: string[] = [];
  if (gate.boundaryTaskSuccess.passed !== 6) reasons.push('Boundary Skill v2 未达到 6/6 任务正确。');
  if (gate.boundaryNegativeCompliance.passed !== 3) reasons.push('Boundary Skill v2 未达到 3/3 纯文本负例零调用。');
  if (gate.boundaryPositiveCompliance.passed !== 3) reasons.push('Boundary Skill v2 未达到 3/3 JSON 正例成功调用。');
  if (gate.boundaryNegativeCompliance.passed <= gate.skillV1NegativeCompliance.passed) {
    reasons.push('Boundary Skill v2 的负例工具合规未优于 Skill v1。');
  }
  return { passed: reasons.length === 0, ...gate, reasons };
}

function boundaryCells(runs: Stage2bBoundaryPublicRun[]): Stage2bBoundaryCell[] {
  const groups = new Map<string, Stage2bBoundaryPublicRun[]>();
  for (const run of runs) {
    const key = `${run.taskId}/${run.condition}`;
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  return [...groups.values()].map(group => {
    const first = group[0]!;
    const tokens = group.map(run => run.usage.totalTokens);
    return {
      taskId: first.taskId,
      condition: first.condition,
      observations: group.length,
      taskSuccess: group.filter(run => run.taskSuccess === true).length,
      toolCompliance: group.filter(run => run.toolCompliance).length,
      strategies: countValues(group.map(run => run.strategy)),
      turns: metric(group.map(run => run.turns)),
      toolCalls: metric(group.map(run => run.toolCalls)),
      totalTokens: { ...metric(tokens), sum: tokens.reduce((sum, value) => sum + value, 0) }
    };
  });
}

function conditionSummaries(
  runs: Stage2bBoundaryPublicRun[]
): Stage2bBoundaryConditionSummary[] {
  return (['description', 'skill-v1', 'skill-v2'] as const).map(condition => {
    const selected = runs.filter(run => run.condition === condition);
    const negative = selected.filter(run => isNegative(run.taskId));
    const positive = selected.filter(run => !isNegative(run.taskId));
    return {
      condition,
      taskSuccess: countRatio(selected, run => run.taskSuccess === true),
      negativeCompliance: countRatio(negative, run => run.toolCompliance),
      positiveCompliance: countRatio(positive, run => run.toolCompliance),
      turns: selected.reduce((sum, run) => sum + run.turns, 0),
      toolCalls: selected.reduce((sum, run) => sum + run.toolCalls, 0),
      totalTokens: selected.reduce((sum, run) => sum + run.usage.totalTokens, 0)
    };
  });
}

function validateBoundaryPlan(manifest: Extract<Stage2bBatchManifest, { version: 3 }>): void {
  const expected = expandStage2bSuite('boundary-v1', manifest.repetitions);
  if (manifest.runs.length !== expected.length || manifest.totalRuns !== expected.length) {
    throw new Error('Stage 2B boundary manifest size mismatch.');
  }
  expected.forEach((planned, index) => {
    const actual = manifest.runs[index];
    if (
      !actual
      || actual.taskId !== planned.taskId
      || actual.condition !== planned.condition
      || actual.repetition !== planned.repetition
    ) {
      throw new Error('Stage 2B boundary manifest plan mismatch.');
    }
  });
}

function requireBoundaryManifest(
  manifest: Stage2bBatchManifest
): Extract<Stage2bBatchManifest, { version: 3 }> {
  if (manifest.version !== 3 || manifest.suite !== 'boundary-v1') {
    throw new Error('Stage 2B boundary report requires a boundary-v1 manifest.');
  }
  return manifest;
}

function sameLimits(left: Stage2bRecord['limits'], right: Stage2bRecord['limits']): boolean {
  return left.maxTurns === right.maxTurns
    && left.maxToolCalls === right.maxToolCalls
    && left.requestTimeoutMs === right.requestTimeoutMs
    && left.totalTimeoutMs === right.totalTimeoutMs;
}

function sameBoundaryConfiguration(
  left: Stage2bBoundaryReport,
  right: Stage2bBoundaryReport
): boolean {
  return left.provider === right.provider
    && left.model === right.model
    && left.thinking === right.thinking
    && left.sampling.temperature === right.sampling.temperature
    && sameLimits(left.limits, right.limits)
    && left.skills.v1.sha256 === right.skills.v1.sha256
    && left.skills.v2.sha256 === right.skills.v2.sha256;
}

function isNegative(taskId: Stage2bBoundaryTaskId): boolean {
  return taskId === 'T12' || taskId === 'T14' || taskId === 'T16';
}

function countRatio<T>(values: T[], predicate: (value: T) => boolean): Ratio {
  return { passed: values.filter(predicate).length, total: values.length };
}

function metric(values: number[]): MetricSummary {
  const sum = values.reduce((total, value) => total + value, 0);
  return {
    min: Math.min(...values),
    max: Math.max(...values),
    mean: Number((sum / values.length).toFixed(2))
  };
}

function sumUsage(runs: Stage2bBoundaryPublicRun[]): ModelUsage {
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

function hasSuccessfulJqCall(events: Stage2bRecord['toolEvents']): boolean {
  const calls = new Map<string, number[]>();
  const outputs = new Map<string, Array<{ index: number; output: string }>>();
  events.forEach((event, index) => {
    if (event.type === 'function_call' && event.name === 'jq_query') {
      calls.set(event.callId, [...(calls.get(event.callId) ?? []), index]);
    } else if (event.type === 'function_call_output') {
      outputs.set(event.callId, [
        ...(outputs.get(event.callId) ?? []),
        { index, output: event.output }
      ]);
    }
  });
  for (const [callId, positions] of calls) {
    const matching = outputs.get(callId) ?? [];
    if (
      positions.length !== 1
      || matching.length !== 1
      || matching[0]!.index <= positions[0]!
    ) continue;
    try {
      const parsed: unknown = JSON.parse(matching[0]!.output);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) && Reflect.get(parsed, 'ok') === true) {
        return true;
      }
    } catch {
      // A malformed private output is not a successful observed call.
    }
  }
  return false;
}

function countValues(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function ratio(value: Ratio): string {
  return `${value.passed}/${value.total}`;
}

function conditionLabel(condition: Stage2bBoundaryCondition): string {
  return condition === 'description'
    ? 'Description'
    : condition === 'skill-v1'
      ? 'Skill v1'
      : 'Boundary Skill v2';
}

function countsLabel(counts: Record<string, number>): string {
  return Object.entries(counts).map(([key, count]) => `${key} (x${count})`).join('<br>');
}

function metricLabel(value: MetricSummary): string {
  return `${value.min}-${value.max} / ${value.mean}`;
}
