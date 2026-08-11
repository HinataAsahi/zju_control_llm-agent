import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import * as z from 'zod/v4';
import type { ModelUsage } from '../agent/model-client.js';
import type {
  Stage2bBatchManifest,
  Stage2bBatchRun
} from './stage2b-batch.js';
import { readStage2bBatchManifest } from './stage2b-batch.js';
import type { Stage2bRecord } from './stage2b-record.js';

export type Stage2bReportRole = 'pilot' | 'calibrated' | 'repeat';

export type Stage2bReportRecord = Pick<
  Stage2bRecord,
  | 'runId'
  | 'provider'
  | 'model'
  | 'thinking'
  | 'sampling'
  | 'taskId'
  | 'condition'
  | 'status'
  | 'taskSuccess'
  | 'recoverySuccess'
  | 'limits'
  | 'turns'
  | 'toolCalls'
  | 'usage'
>;

export interface Stage2bReportInput {
  role: Stage2bReportRole;
  manifest: Stage2bBatchManifest;
  records: Stage2bReportRecord[];
}

export interface Stage2bPublicRun {
  taskId: 'T2' | 'T7';
  condition: 'explicit' | 'description' | 'skill';
  repetition: number;
  status: Stage2bRecord['status'];
  taskSuccess: boolean | null;
  recoverySuccess: boolean | null;
  turns: number;
  toolCalls: number;
  usage: ModelUsage;
}

export interface Stage2bPublicBatch {
  role: Stage2bReportRole;
  batchId: string;
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
    recoverySuccess: number;
    recoveryApplicable: number;
    limitExceeded: number;
  };
  usage: ModelUsage;
  turns: number;
  toolCalls: number;
  runs: Stage2bPublicRun[];
}

export interface Stage2bPublicReport {
  version: 2;
  scope: 'descriptive-observations';
  batches: Stage2bPublicBatch[];
  repeatedComparison?: Stage2bRepeatedComparison;
}

export interface Stage2bRepeatedComparison {
  sourceRoles: ['calibrated', 'repeat'];
  totalRuns: number;
  observationsPerCell: number;
  cells: Stage2bRepeatedCell[];
}

export interface Stage2bRepeatedCell {
  taskId: 'T2' | 'T7';
  condition: 'explicit' | 'description' | 'skill';
  observations: number;
  completed: number;
  taskSuccess: number;
  recoverySuccess: number;
  recoveryApplicable: number;
  turns: MetricSummary;
  toolCalls: MetricSummary;
  totalTokens: MetricSummary & { sum: number };
}

export interface MetricSummary {
  min: number;
  max: number;
  mean: number;
}

const limitsSchema = z.strictObject({
  maxTurns: z.number().int().nonnegative(),
  maxToolCalls: z.number().int().nonnegative(),
  requestTimeoutMs: z.number().int().nonnegative(),
  totalTimeoutMs: z.number().int().nonnegative()
});

const usageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reasoningOutputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative()
});

const reportRecordSchema: z.ZodType<Stage2bReportRecord> = z.object({
  runId: z.string(),
  provider: z.literal('deepseek'),
  model: z.literal('deepseek-v4-flash'),
  thinking: z.literal('none'),
  sampling: z.strictObject({
    temperature: z.number().min(0).max(2).nullable()
  }).default({ temperature: null }),
  taskId: z.enum(['T1', 'T2', 'T6', 'T7']),
  condition: z.enum(['explicit', 'description', 'skill']),
  status: z.enum([
    'completed',
    'infrastructure-error',
    'protocol-error',
    'model-output-error',
    'limit-exceeded'
  ]),
  taskSuccess: z.boolean().nullable(),
  recoverySuccess: z.boolean().nullable(),
  limits: limitsSchema,
  turns: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  usage: usageSchema
});

export function summarizeStage2bBatches(inputs: Stage2bReportInput[]): Stage2bPublicReport {
  if (inputs.length === 0) throw new Error('At least one Stage 2B batch is required.');
  if (new Set(inputs.map(input => input.role)).size !== inputs.length) {
    throw new Error('Stage 2B report roles must be unique.');
  }
  const batches = inputs.map(summarizeBatch);
  const repeatedComparison = buildRepeatedComparison(batches);
  return {
    version: 2,
    scope: 'descriptive-observations',
    batches,
    ...(repeatedComparison ? { repeatedComparison } : {})
  };
}

export function renderStage2bComparisonMarkdown(report: Stage2bPublicReport): string {
  const hasRepeatedComparison = report.repeatedComparison !== undefined;
  const lines = [
    '# Stage 2B 描述性观测报告',
    '',
    hasRepeatedComparison
      ? '本报告区分预算校准前的 pilot、校准基线 calibrated 与固定配置 repeat 批次，只进行描述性汇总，不进行显著性检验或因果推断。'
      : '本报告区分预算校准前的 pilot 与校准后的 calibrated 批次，只进行描述性汇总，不进行显著性检验或因果推断。',
    '',
    '## 批次配置',
    '',
    '| 角色 | 批次 | 温度 | 最大回合 | 最大工具调用 | 重复数 |',
    '|---|---|---:|---:|---:|---:|',
    ...report.batches.map(batch => [
      batch.role,
      batch.batchId,
      batch.sampling.temperature ?? 'provider-default',
      batch.limits.maxTurns,
      batch.limits.maxToolCalls,
      batch.repetitions
    ].join(' | ')).map(row => `| ${row} |`),
    '',
    '## 总体结果',
    '',
    '| 角色 | 完成 | 任务成功 | 恢复成功（可判定） | 限制中止 | 回合 | 工具调用 | 总 token |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
    ...report.batches.map(batch => `| ${batch.role} | ${batch.counts.completed}/${batch.counts.total} | ${batch.counts.taskSuccess}/${batch.counts.total} | ${formatRatio(batch.counts.recoverySuccess, batch.counts.recoveryApplicable)} | ${batch.counts.limitExceeded} | ${batch.turns} | ${batch.toolCalls} | ${batch.usage.totalTokens} |`)
  ];
  if (report.repeatedComparison) {
    lines.push(
      '',
      `## 固定配置重复观测（n=${report.repeatedComparison.observationsPerCell}）`,
      '',
      '| 任务 | 条件 | 完成 | 任务成功 | 恢复成功（可判定） | 回合 min-max / mean | 工具调用 min-max / mean | Token min-max / mean |',
      '|---|---|---:|---:|---:|---:|---:|---:|',
      ...report.repeatedComparison.cells.map(cell => `| ${cell.taskId} | ${cell.condition} | ${cell.completed}/${cell.observations} | ${cell.taskSuccess}/${cell.observations} | ${formatRatio(cell.recoverySuccess, cell.recoveryApplicable)} | ${formatMetric(cell.turns)} | ${formatMetric(cell.toolCalls)} | ${formatMetric(cell.totalTokens)} |`)
    );
  }
  lines.push(
    '',
    '## 逐项观测',
    '',
    '| 角色 | 任务 | 条件 | 状态 | 任务成功 | 恢复成功 | 回合 | 工具调用 | 总 token |',
    '|---|---|---|---|---|---|---:|---:|---:|'
  );
  for (const batch of report.batches) {
    for (const run of batch.runs) {
      lines.push(`| ${batch.role} | ${run.taskId} | ${run.condition} | ${run.status} | ${formatNullable(run.taskSuccess)} | ${formatNullable(run.recoverySuccess)} | ${run.turns} | ${run.toolCalls} | ${run.usage.totalTokens} |`);
    }
  }
  lines.push(
    '',
    '## 解读边界',
    '',
    '- pilot 与 calibrated 同时改变了温度和调用预算，结果差异不能直接归因于其中任一变量。',
    ...(hasRepeatedComparison
      ? ['- calibrated 与 repeat 使用相同配置，合并后每个任务与条件有三次观测；样本仍小，只报告范围和均值。']
      : ['- 每个任务与条件只有一次 calibrated 观测，因此不报告范围或均值。']),
    '- 当前样本不能证明 Explicit、Description 或 Skill 之间存在稳定差异。',
    '- 恢复成功率只统计 `recoverySuccess` 非空的可判定记录；因限制中止而未完成的恢复任务显示为 N/A。',
    '- 公开汇总不包含原始模型响应、工具参数、工具输出、最终答案解释、记录 ID、绝对路径或凭据。',
    ''
  );
  return lines.join('\n');
}

export async function writeStage2bComparisonReport(options: {
  repositoryRoot: string;
  pilotBatchId: string;
  calibratedBatchId: string;
  repeatBatchId?: string;
}): Promise<{
  report: Stage2bPublicReport;
  jsonPath: string;
  markdownPath: string;
}> {
  const repositoryRoot = resolve(options.repositoryRoot);
  const inputs = await Promise.all([
    loadBatch(repositoryRoot, 'pilot', options.pilotBatchId),
    loadBatch(repositoryRoot, 'calibrated', options.calibratedBatchId),
    ...(options.repeatBatchId
      ? [loadBatch(repositoryRoot, 'repeat', options.repeatBatchId)]
      : [])
  ]);
  const report = summarizeStage2bBatches(inputs);
  const resultsRoot = resolve(repositoryRoot, 'experiments/stage-2b/results');
  await ensurePublicDirectory(resultsRoot);
  const jsonPath = join(resultsRoot, 'observations.json');
  const markdownPath = join(resultsRoot, 'report.zh.md');
  await writePublicFileAtomic(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await writePublicFileAtomic(markdownPath, renderStage2bComparisonMarkdown(report));
  return { report, jsonPath, markdownPath };
}

function summarizeBatch(input: Stage2bReportInput): Stage2bPublicBatch {
  const { manifest } = input;
  if (!/^stage2b-batch-[A-Za-z0-9._-]+$/.test(manifest.batchId)) {
    throw new Error('Unsafe Stage 2B batch ID.');
  }
  if (manifest.runs.some(run => run.status === 'pending' || run.status === 'running')) {
    throw new Error(`Stage 2B ${input.role} batch is not terminal.`);
  }
  if (input.records.length !== manifest.runs.length) {
    throw new Error(`Stage 2B ${input.role} record count does not match its manifest.`);
  }
  const records = new Map(input.records.map(record => [record.runId, record]));
  if (records.size !== input.records.length) {
    throw new Error(`Stage 2B ${input.role} records contain duplicate run IDs.`);
  }

  const runs = manifest.runs.map(run => publicRun(manifest, run, records));
  return {
    role: input.role,
    batchId: manifest.batchId,
    createdAt: manifest.createdAt,
    provider: manifest.provider,
    model: manifest.model,
    thinking: manifest.thinking,
    sampling: { ...manifest.sampling },
    repetitions: manifest.repetitions,
    limits: { ...manifest.limits },
    counts: {
      total: runs.length,
      completed: runs.filter(run => run.status === 'completed').length,
      failed: runs.filter(run => run.status !== 'completed').length,
      taskSuccess: runs.filter(run => run.taskSuccess === true).length,
      recoverySuccess: runs.filter(run => run.recoverySuccess === true).length,
      recoveryApplicable: runs.filter(run => run.recoverySuccess !== null).length,
      limitExceeded: runs.filter(run => run.status === 'limit-exceeded').length
    },
    usage: sumUsage(runs),
    turns: runs.reduce((sum, run) => sum + run.turns, 0),
    toolCalls: runs.reduce((sum, run) => sum + run.toolCalls, 0),
    runs
  };
}

function buildRepeatedComparison(
  batches: Stage2bPublicBatch[]
): Stage2bRepeatedComparison | undefined {
  const repeat = batches.find(batch => batch.role === 'repeat');
  if (!repeat) return undefined;
  const calibrated = batches.find(batch => batch.role === 'calibrated');
  if (!calibrated) throw new Error('Stage 2B repeat reporting requires a calibrated batch.');
  if (!sameBatchConfiguration(calibrated, repeat)) {
    throw new Error('Stage 2B repeat configuration does not match the calibrated batch.');
  }

  const allRuns = [...calibrated.runs, ...repeat.runs];
  const cells = (['T2', 'T7'] as const).flatMap(taskId =>
    (['explicit', 'description', 'skill'] as const).map(condition => {
      const runs = allRuns.filter(run => run.taskId === taskId && run.condition === condition);
      if (runs.length === 0) throw new Error(`Stage 2B repeated cell is empty: ${taskId}/${condition}.`);
      return {
        taskId,
        condition,
        observations: runs.length,
        completed: runs.filter(run => run.status === 'completed').length,
        taskSuccess: runs.filter(run => run.taskSuccess === true).length,
        recoverySuccess: runs.filter(run => run.recoverySuccess === true).length,
        recoveryApplicable: runs.filter(run => run.recoverySuccess !== null).length,
        turns: summarizeMetric(runs.map(run => run.turns)),
        toolCalls: summarizeMetric(runs.map(run => run.toolCalls)),
        totalTokens: {
          ...summarizeMetric(runs.map(run => run.usage.totalTokens)),
          sum: runs.reduce((sum, run) => sum + run.usage.totalTokens, 0)
        }
      };
    })
  );
  const observationsPerCell = cells[0]?.observations ?? 0;
  if (cells.some(cell => cell.observations !== observationsPerCell)) {
    throw new Error('Stage 2B repeated cells do not have equal observation counts.');
  }
  return {
    sourceRoles: ['calibrated', 'repeat'],
    totalRuns: allRuns.length,
    observationsPerCell,
    cells
  };
}

function publicRun(
  manifest: Stage2bBatchManifest,
  run: Stage2bBatchRun,
  records: Map<string, Stage2bReportRecord>
): Stage2bPublicRun {
  if (run.status === 'pending' || run.status === 'running') {
    throw new Error('Stage 2B report cannot include a non-terminal run.');
  }
  const record = records.get(run.recordRunId);
  if (!record) throw new Error(`Stage 2B record is missing for ${run.runKey}.`);
  if (record.taskId !== run.taskId || record.condition !== run.condition) {
    throw new Error(`Stage 2B record identity does not match its manifest for ${run.runKey}.`);
  }
  if (
    record.status !== run.recordStatus
    || record.taskSuccess !== run.taskSuccess
    || record.recoverySuccess !== run.recoverySuccess
  ) {
    throw new Error(`Stage 2B record outcome does not match its manifest for ${run.runKey}.`);
  }
  if (
    record.provider !== manifest.provider
    || record.model !== manifest.model
    || record.thinking !== manifest.thinking
  ) {
    throw new Error(`Stage 2B record model configuration does not match its manifest for ${run.runKey}.`);
  }
  if (record.sampling.temperature !== manifest.sampling.temperature) {
    throw new Error(`Stage 2B record sampling does not match its manifest for ${run.runKey}.`);
  }
  if (!sameLimits(record.limits, manifest.limits)) {
    throw new Error(`Stage 2B record limits do not match its manifest for ${run.runKey}.`);
  }
  return {
    taskId: run.taskId,
    condition: run.condition,
    repetition: run.repetition,
    status: record.status,
    taskSuccess: record.taskSuccess,
    recoverySuccess: record.recoverySuccess,
    turns: record.turns,
    toolCalls: record.toolCalls,
    usage: { ...record.usage }
  };
}

function sumUsage(runs: Stage2bPublicRun[]): ModelUsage {
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

function sameBatchConfiguration(left: Stage2bPublicBatch, right: Stage2bPublicBatch): boolean {
  return left.provider === right.provider
    && left.model === right.model
    && left.thinking === right.thinking
    && left.sampling.temperature === right.sampling.temperature
    && sameLimits(left.limits, right.limits);
}

function summarizeMetric(values: number[]): MetricSummary {
  const sum = values.reduce((total, value) => total + value, 0);
  return {
    min: Math.min(...values),
    max: Math.max(...values),
    mean: Number((sum / values.length).toFixed(2))
  };
}

function formatNullable(value: boolean | null): string {
  return value === null ? 'N/A' : value ? '是' : '否';
}

function formatMetric(metric: MetricSummary): string {
  return `${metric.min}-${metric.max} / ${metric.mean}`;
}

function formatRatio(numerator: number, denominator: number): string {
  return denominator === 0 ? 'N/A' : `${numerator}/${denominator}`;
}

async function loadBatch(
  repositoryRoot: string,
  role: Stage2bReportRole,
  batchId: string
): Promise<Stage2bReportInput> {
  const { manifest } = await readStage2bBatchManifest(repositoryRoot, batchId);
  const records: Stage2bReportRecord[] = [];
  for (const run of manifest.runs) {
    if (run.status === 'pending' || run.status === 'running') {
      throw new Error(`Stage 2B ${role} batch is not terminal.`);
    }
    records.push(await readReportRecord(repositoryRoot, run.recordRunId));
  }
  return { role, manifest, records };
}

async function readReportRecord(
  repositoryRoot: string,
  runId: string
): Promise<Stage2bReportRecord> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId) || runId === '.' || runId === '..') {
    throw new Error('Unsafe Stage 2B record run ID.');
  }
  const recordRoot = resolve(repositoryRoot, '.experiment-runs/stage-2b', runId);
  const rootMetadata = await lstat(recordRoot);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error('Unsafe Stage 2B record directory.');
  }
  const text = await readRegularText(join(recordRoot, 'record.json'));
  const parsed: unknown = JSON.parse(text);
  const record = reportRecordSchema.parse(parsed);
  if (record.runId !== runId) throw new Error('Stage 2B record ID does not match its path.');
  return record;
}

async function readRegularText(path: string): Promise<string> {
  const pathMetadata = await lstat(path, { bigint: true });
  if (pathMetadata.isSymbolicLink() || !pathMetadata.isFile()) {
    throw new Error('Unsafe Stage 2B record file.');
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
      throw new Error('Stage 2B record changed while being opened.');
    }
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

async function ensurePublicDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o755 });
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error('Unsafe Stage 2B public results directory.');
  }
  await chmod(path, 0o755);
}

async function writePublicFileAtomic(destination: string, text: string): Promise<void> {
  const temporary = join(dirname(destination), `.report-${randomBytes(8).toString('hex')}.tmp`);
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
