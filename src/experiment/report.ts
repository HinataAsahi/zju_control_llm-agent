import type { ModelConfiguration, RawCodexRun } from './codex-runner.js';
import { jqQueryInputSchema } from '../mcp/jq-schema.js';
import type { ExperimentCondition, ExperimentTask } from './schema.js';
import type { TokenUsage, TraceSummary, ToolObservation } from './trace-parser.js';

export type RunValidity = 'valid' | 'infrastructure-error' | 'needs-review';

export interface EvaluateRunInput {
  task: ExperimentTask;
  condition: ExperimentCondition;
  raw: RawCodexRun;
  trace: TraceSummary;
}

export interface EvaluatedRun {
  taskId: string;
  condition: ExperimentCondition;
  validity: RunValidity;
  taskSuccess: boolean | null;
  explicitCompliance: boolean | null;
  mcpSelected: boolean | null;
  firstCallValid: boolean | null;
  recoverySuccess: boolean | null;
  negativeAvoidance: boolean | null;
  alternativePath: 'mcp' | 'shell' | 'file-read' | 'direct' | 'mixed' | 'unknown';
  usage: TokenUsage;
  durationMs: number;
  notes: string[];
}

export interface ReportMetadata {
  generatedAt: string;
  codexVersion: string;
  repositoryCommit: string;
  model: ModelConfiguration;
}

export function evaluateRun(input: EvaluateRunInput): EvaluatedRun {
  const validity = classifyValidity(input.raw, input.trace);
  const valid = validity === 'valid';
  const jqCalls = input.trace.mcpCalls.filter(call => call.tool === 'jq_query');
  const firstCall = jqCalls[0];
  const successfulCall = jqCalls.some(callSucceeded);
  const taskNumber = Number(input.task.id.slice(1));
  const selectionApplicable = (input.condition === 'description' || input.condition === 'skill')
    && taskNumber >= 1
    && taskNumber <= 6;
  const explicitApplicable = input.condition === 'explicit';
  const firstCallApplicable = taskNumber >= 1 && taskNumber <= 7 && jqCalls.length > 0;
  const notes = validityNotes(input.raw, input.trace);

  return {
    taskId: input.task.id,
    condition: input.condition,
    validity,
    taskSuccess: valid ? answersEqual(input.trace.finalAnswer, input.task.expected) : null,
    explicitCompliance: valid && explicitApplicable
      ? (input.task.id === 'T8' ? jqCalls.length === 0 : successfulCall)
      : null,
    mcpSelected: valid && selectionApplicable ? jqCalls.length > 0 : null,
    firstCallValid: valid && firstCallApplicable
      ? jqQueryInputSchema.safeParse(firstCall?.arguments).success
      : null,
    recoverySuccess: valid && input.task.id === 'T7'
      ? jqCalls.length >= 2 && callFailed(jqCalls[0]) && jqCalls.slice(1).some(callSucceeded)
      : null,
    negativeAvoidance: valid && input.task.id === 'T8' ? jqCalls.length === 0 : null,
    alternativePath: classifyAlternativePath(input.trace),
    usage: { ...input.trace.usage },
    durationMs: input.raw.durationMs,
    notes
  };
}

export function sanitizeRun(run: EvaluatedRun): EvaluatedRun {
  return {
    ...run,
    usage: { ...run.usage },
    notes: run.notes.map(redactText)
  };
}

export function renderMarkdownReport(runs: EvaluatedRun[], metadata: ReportMetadata): string {
  const safeRuns = runs.map(sanitizeRun);
  const conditions: ExperimentCondition[] = ['explicit', 'description', 'skill'];
  const totalUsage = safeRuns.reduce<TokenUsage>((total, run) => ({
    inputTokens: total.inputTokens + run.usage.inputTokens,
    cachedInputTokens: total.cachedInputTokens + run.usage.cachedInputTokens,
    outputTokens: total.outputTokens + run.usage.outputTokens,
    reasoningOutputTokens: total.reasoningOutputTokens + run.usage.reasoningOutputTokens
  }), { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 });

  const lines = [
    '# Stage 2A Codex 单次观测报告',
    '',
    '本报告汇总每个任务与条件的一次描述性观测，不进行统计推断或因果归因。',
    '',
    '## 运行元数据',
    '',
    `- 生成时间：${redactText(metadata.generatedAt)}`,
    `- Codex：${redactText(metadata.codexVersion)}`,
    `- 仓库提交：${redactText(metadata.repositoryCommit)}`,
    `- 模型配置：${metadata.model.model} / ${metadata.model.reasoningEffort}`,
    '',
    '## 总体计数',
    '',
    `- 任务成功：${ratio(safeRuns, 'taskSuccess')}`,
    `- MCP 选择：${ratio(safeRuns, 'mcpSelected')}`,
    `- 显式条件遵从：${ratio(safeRuns, 'explicitCompliance')}`,
    `- 首次调用有效：${ratio(safeRuns, 'firstCallValid')}`,
    `- 错误恢复成功：${ratio(safeRuns, 'recoverySuccess')}`,
    `- 负向任务避免调用：${ratio(safeRuns, 'negativeAvoidance')}`,
    '',
    '## 条件分布',
    '',
    '| 条件 | 观测数 | 有效 | 基础设施错误 | 待复核 |',
    '|---|---:|---:|---:|---:|',
    ...conditions.map(condition => {
      const selected = safeRuns.filter(run => run.condition === condition);
      return `| ${condition} | ${selected.length} | ${countValidity(selected, 'valid')} | ${countValidity(selected, 'infrastructure-error')} | ${countValidity(selected, 'needs-review')} |`;
    }),
    '',
    '## Token 与耗时',
    '',
    `- 输入 token：${totalUsage.inputTokens}`,
    `- 缓存命中输入 token：${totalUsage.cachedInputTokens}`,
    `- 输出 token：${totalUsage.outputTokens}`,
    `- 推理输出 token：${totalUsage.reasoningOutputTokens}`,
    `- 总耗时：${safeRuns.reduce((sum, run) => sum + run.durationMs, 0)} ms`,
    '',
    '## 替代路径',
    '',
    '| 路径 | 次数 |',
    '|---|---:|',
    ...(['mcp', 'shell', 'file-read', 'direct', 'mixed', 'unknown'] as const)
      .map(path => `| ${path} | ${safeRuns.filter(run => run.alternativePath === path).length} |`),
    '',
    '## 人工复核',
    ''
  ];

  const reviewRuns = safeRuns.filter(run => run.validity !== 'valid' || run.notes.length > 0);
  if (reviewRuns.length === 0) {
    lines.push('- 无。');
  } else {
    for (const run of reviewRuns) {
      const detail = run.notes.length > 0 ? run.notes.join('; ') : run.validity;
      lines.push(`- ${run.taskId} / ${run.condition}：${detail}`);
    }
  }
  lines.push(
    '',
    '## 局限',
    '',
    '- 每个任务与条件只有一次观测，结果只用于理解工具描述与 Skill 对当前决策路径的影响。',
    '- 交互体验任务不进入量化分母；不适用指标保留为 null。',
    '- 原始 JSONL 和 stderr 保留在本地运行目录，发布内容仅包含脱敏后的结构化结果。',
    ''
  );
  return lines.join('\n');
}

function classifyValidity(raw: RawCodexRun, trace: TraceSummary): RunValidity {
  if (raw.timedOut || raw.exitCode !== 0 || raw.signal !== null || trace.terminalStatus === 'failed') {
    return 'infrastructure-error';
  }
  if (
    trace.terminalStatus !== 'completed'
    || trace.parseErrors.length > 0
    || trace.unknownEventTypes.length > 0
    || !trace.finalAnswer
  ) {
    return 'needs-review';
  }
  return 'valid';
}

function validityNotes(raw: RawCodexRun, trace: TraceSummary): string[] {
  const notes: string[] = [];
  if (raw.timedOut) notes.push('Codex process timed out.');
  if (raw.exitCode !== 0) notes.push(`Codex exit code: ${raw.exitCode === null ? 'null' : raw.exitCode}.`);
  if (raw.signal !== null) notes.push(`Codex signal: ${raw.signal}.`);
  if (trace.terminalStatus !== 'completed') notes.push(`Trace terminal status: ${trace.terminalStatus}.`);
  notes.push(...trace.parseErrors);
  if (trace.unknownEventTypes.length > 0) {
    notes.push(`Unknown event types: ${trace.unknownEventTypes.join(', ')}.`);
  }
  if (!trace.finalAnswer) notes.push('No valid final answer was observed.');
  return notes;
}

function answersEqual(
  answer: TraceSummary['finalAnswer'],
  expected: ExperimentTask['expected']
): boolean {
  return answer !== undefined
    && answer.status === expected.status
    && canonicalJson(answer.answer) === canonicalJson(expected.answer);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function callSucceeded(call: ToolObservation | undefined): boolean {
  if (!call || call.error !== undefined || call.status === 'failed') return false;
  if (isRecord(call.result) && call.result.ok === false) return false;
  return (isRecord(call.result) && call.result.ok === true) || call.status === 'completed';
}

function callFailed(call: ToolObservation | undefined): boolean {
  return call !== undefined && !callSucceeded(call);
}

function classifyAlternativePath(trace: TraceSummary): EvaluatedRun['alternativePath'] {
  const hasMcp = trace.mcpCalls.some(call => call.tool === 'jq_query');
  const commands = trace.commandExecutions;
  if (hasMcp && commands.length > 0) return 'mixed';
  if (hasMcp) return 'mcp';
  if (commands.length > 0) {
    const fileReads = commands.every(command => /(?:^|[;&|]\s*)(?:cat|sed|head|tail|less|more)\b/.test(command));
    return fileReads ? 'file-read' : 'shell';
  }
  return trace.finalAnswer ? 'direct' : 'unknown';
}

function ratio(runs: EvaluatedRun[], key: BooleanMetric): string {
  const applicable = runs.map(run => run[key]).filter((value): value is boolean => value !== null);
  return `${applicable.filter(Boolean).length}/${applicable.length}`;
}

type BooleanMetric = {
  [K in keyof EvaluatedRun]: EvaluatedRun[K] extends boolean | null ? K : never
}[keyof EvaluatedRun];

function countValidity(runs: EvaluatedRun[], validity: RunValidity): number {
  return runs.filter(run => run.validity === validity).length;
}

function redactText(text: string): string {
  return text
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED_TOKEN]')
    .replace(/\b(?:api[_-]?key|access[_-]?token)\s*[:=]\s*[^\s,;]+/gi, '[REDACTED_CREDENTIAL]')
    .replace(/\bthread[_-]?id\s*[:=]\s*[0-9A-Za-z-]+/gi, 'thread_id=[REDACTED_ID]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[REDACTED_ID]')
    .replace(/\b[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s,;]*/g, '[REDACTED_PATH]')
    .replace(/\/(?:home|Users)\/[^\s,;]+/g, '[REDACTED_PATH]');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
