import type { CliEvidence } from './collector.js';
import type { ToolProfile } from './profile.js';
import type { CliIr, EvidenceReference } from './schema.js';

const dispositionLabels = { allow: '允许', deny: '禁止', defer: '暂缓' } as const;
const riskLabels = { low: '低', medium: '中', high: '高' } as const;

export function renderProfileReview(evidence: CliEvidence, ir: CliIr, profile: ToolProfile): string {
  const decisions = new Map(profile.capabilityDecisions.map(decision => [decision.capabilityId, decision]));
  const lines = [
    `# ${escapeMarkdown(ir.cliName)} MCP 生成审阅报告`,
    '',
    '## 输入证据',
    '',
    `- CLI：\`${escapeCode(ir.cliName)} ${escapeCode(ir.version)}\``,
    `- 证据哈希：\`${evidence.evidenceHash}\``,
    `- 工具草案：\`${escapeCode(profile.tool.name)}\``,
    `- 描述：${escapeMarkdown(profile.tool.description)}`,
    '',
    '## 冻结帮助文本',
    '',
    '```text',
    ...sourceLines(evidence, 'help'),
    '```',
    '',
    '## IR 抽取结果',
    '',
    `摘要：${escapeMarkdown(ir.summary)}`,
    '',
    '### Usage',
    '',
    ...ir.usageForms.map(item => `- \`${escapeCode(item.text)}\`（${evidenceLabel(item.evidence)}）`),
    '',
    '### 位置参数',
    '',
    '| ID | 名称 | 基数 | 推断类型 | 置信度 | 不确定性 |',
    '|---|---|---|---|---|---|',
    ...ir.positionals.map(item => row(
      `\`${escapeCode(item.id)}\``,
      `\`${escapeCode(item.name)}\``,
      cardinalityLabel(item.cardinality),
      `\`${item.inferredType}\``,
      confidenceLabel(item.confidence),
      item.uncertainty ?? '无'
    )),
    '',
    '### 选项',
    '',
    '| 选项 | 取值 | 值名 | 推断类型 | 可重复 | 置信度 | 不确定性 | 约束 |',
    '|---|---|---|---|---|---|---|---|',
    ...ir.options.map(option => row(
      option.names.map(name => `\`${escapeCode(name)}\``).join(' / '),
      option.takesValue ? '是' : '否',
      option.valueName ? `\`${escapeCode(option.valueName)}\`` : '无',
      `\`${option.inferredType}\``,
      repeatableLabel(option.repeatable),
      confidenceLabel(option.confidence),
      option.uncertainty ?? '无',
      option.constraints.length > 0
        ? option.constraints.map(constraint => `${constraint.kind}: ${constraint.expression}`).join('；')
        : '无'
    )),
    '',
    '## 能力处置',
    '',
    '| 能力 | 类型 | 决定 | 风险 | 原因 | 证据 |',
    '|---|---|---|---|---|---|'
  ];
  for (const positional of ir.positionals) {
    const decision = decisions.get(positional.id)!;
    lines.push(row(
      `\`${escapeCode(positional.name)}\``,
      '位置参数',
      dispositionLabels[decision.disposition],
      riskLabels[decision.risk],
      decision.reason,
      evidenceLabel(positional.evidence)
    ));
  }
  for (const option of ir.options) {
    const decision = decisions.get(option.id)!;
    lines.push(row(
      option.names.map(name => `\`${escapeCode(name)}\``).join(' / '),
      '选项',
      dispositionLabels[decision.disposition],
      riskLabels[decision.risk],
      decision.reason,
      evidenceLabel(option.evidence)
    ));
  }
  lines.push(
    '',
    '## MCP 输入字段',
    '',
    '| 字段 | 结构 | 必填 | 说明 |',
    '|---|---|---|---|'
  );
  for (const field of profile.inputFields) {
    lines.push(row(
      `\`${escapeCode(field.name)}\``,
      `\`${field.shape.type}\``,
      field.required ? '是' : '否',
      field.description
    ));
  }
  lines.push(
    '',
    '## 执行边界',
    '',
    `- 超时：${profile.limits.timeoutMs} ms`,
    `- 输入上限：${profile.limits.inputBytes} bytes`,
    `- 输出上限：${profile.limits.outputBytes} bytes`,
    '- Shell：禁用',
    '- 未明确允许的能力：默认禁止',
    ''
  );
  return `${lines.join('\n')}\n`;
}

function cardinalityLabel(value: CliIr['positionals'][number]['cardinality']): string {
  return {
    one: '恰好一个',
    optional: '零或一个',
    'zero-or-more': '零个或多个',
    'one-or-more': '一个或多个'
  }[value];
}

function confidenceLabel(value: 'high' | 'medium' | 'low'): string {
  return { high: '高', medium: '中', low: '低' }[value];
}

function repeatableLabel(value: CliIr['options'][number]['repeatable']): string {
  return { yes: '是', no: '否', unknown: '未知' }[value];
}

function sourceLines(evidence: CliEvidence, id: 'version' | 'help'): string[] {
  const source = evidence.sources.find(candidate => candidate.id === id);
  if (!source) return [];
  return source.stdout.split('\n').map((line, index) => `L${index + 1}: ${line}`);
}

function evidenceLabel(references: readonly EvidenceReference[]): string {
  return references.map(reference => reference.startLine === reference.endLine
    ? `${reference.sourceId === 'help' ? '帮助文本' : '版本文本'}第 ${reference.startLine} 行`
    : `${reference.sourceId === 'help' ? '帮助文本' : '版本文本'}第 ${reference.startLine}-${reference.endLine} 行`
  ).join('；');
}

function row(...cells: string[]): string {
  return `| ${cells.map(cell => escapeTable(cell)).join(' | ')} |`;
}

function escapeTable(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function escapeMarkdown(value: string): string {
  return value.replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeCode(value: string): string {
  return value.replaceAll('`', '\\`');
}
