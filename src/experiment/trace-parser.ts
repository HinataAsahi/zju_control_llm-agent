import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { jsonValueSchema } from '../mcp/jq-schema.js';
import type { ExperimentAnswer } from './schema.js';

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface ToolObservation {
  server?: string;
  tool: string;
  arguments: unknown;
  result?: unknown;
  error?: unknown;
  status?: string;
}

export interface TraceSummary {
  terminalStatus: 'completed' | 'failed' | 'incomplete';
  usage: TokenUsage;
  mcpCalls: ToolObservation[];
  commandExecutions: string[];
  finalAnswer?: ExperimentAnswer;
  parseErrors: string[];
  unknownEventTypes: string[];
  needsReview: boolean;
}

const emptyUsage = (): TokenUsage => ({
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0
});

export async function parseTrace(path: string): Promise<TraceSummary> {
  const usage = emptyUsage();
  const mcpCalls: ToolObservation[] = [];
  const commandExecutions: string[] = [];
  const parseErrors: string[] = [];
  const unknownEventTypes: string[] = [];
  const unknownTypes = new Set<string>();
  const mcpItems = new Map<string, number>();
  const commandItems = new Set<string>();
  let terminalStatus: TraceSummary['terminalStatus'] = 'incomplete';
  let finalAnswer: ExperimentAnswer | undefined;
  let lineNumber = 0;

  const input = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    lineNumber += 1;
    if (line.trim().length === 0) continue;

    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      parseErrors.push(`Unable to parse JSONL line ${lineNumber}.`);
      continue;
    }
    if (!isRecord(event) || typeof event.type !== 'string') {
      parseErrors.push(`JSONL line ${lineNumber} does not contain an event type.`);
      continue;
    }

    switch (event.type) {
      case 'thread.started':
      case 'turn.started':
        break;
      case 'turn.completed':
        terminalStatus = 'completed';
        addUsage(event.usage, usage, parseErrors, lineNumber);
        break;
      case 'turn.failed':
      case 'error':
        terminalStatus = 'failed';
        break;
      case 'item.started':
      case 'item.completed':
        processItem(
          event.item,
          lineNumber,
          mcpCalls,
          mcpItems,
          commandExecutions,
          commandItems,
          parseErrors,
          type => addUnknown(type, unknownTypes, unknownEventTypes),
          answer => { finalAnswer = answer; }
        );
        break;
      default:
        addUnknown(event.type, unknownTypes, unknownEventTypes);
    }
  }

  const needsReview = terminalStatus !== 'completed'
    || parseErrors.length > 0
    || unknownEventTypes.length > 0;
  return {
    terminalStatus,
    usage,
    mcpCalls,
    commandExecutions,
    ...(finalAnswer ? { finalAnswer } : {}),
    parseErrors,
    unknownEventTypes,
    needsReview
  };
}

function processItem(
  value: unknown,
  lineNumber: number,
  mcpCalls: ToolObservation[],
  mcpItems: Map<string, number>,
  commandExecutions: string[],
  commandItems: Set<string>,
  parseErrors: string[],
  unknown: (type: string) => void,
  acceptAnswer: (answer: ExperimentAnswer) => void
): void {
  if (!isRecord(value) || typeof value.type !== 'string') {
    parseErrors.push(`Event item on line ${lineNumber} is malformed.`);
    return;
  }

  if (value.type === 'mcp_tool_call') {
    if (typeof value.tool !== 'string' || !('arguments' in value)) {
      parseErrors.push(`MCP item on line ${lineNumber} is malformed.`);
      return;
    }
    const observation: ToolObservation = {
      ...(typeof value.server === 'string' ? { server: value.server } : {}),
      tool: value.tool,
      arguments: value.arguments,
      ...('result' in value && value.result !== null ? { result: value.result } : {}),
      ...('error' in value && value.error !== null ? { error: value.error } : {}),
      ...(typeof value.status === 'string' ? { status: value.status } : {})
    };
    const id = typeof value.id === 'string' ? value.id : undefined;
    const existing = id ? mcpItems.get(id) : undefined;
    if (existing === undefined) {
      mcpCalls.push(observation);
      if (id) mcpItems.set(id, mcpCalls.length - 1);
    } else {
      mcpCalls[existing] = observation;
    }
    return;
  }

  if (value.type === 'command_execution') {
    if (typeof value.command !== 'string') {
      parseErrors.push(`Command item on line ${lineNumber} is malformed.`);
      return;
    }
    const identity = typeof value.id === 'string' ? `id:${value.id}` : `command:${value.command}`;
    if (!commandItems.has(identity)) {
      commandItems.add(identity);
      commandExecutions.push(value.command);
    }
    return;
  }

  if (value.type === 'agent_message') {
    if (typeof value.text !== 'string') {
      parseErrors.push(`Agent message on line ${lineNumber} is malformed.`);
      return;
    }
    const text = value.text.trim();
    if (!text.startsWith('{')) return;
    try {
      const answer = parseAnswer(JSON.parse(text));
      if (answer) acceptAnswer(answer);
      else parseErrors.push(`Structured agent answer on line ${lineNumber} is invalid.`);
    } catch {
      parseErrors.push(`Structured agent answer on line ${lineNumber} is not valid JSON.`);
    }
    return;
  }

  if (['reasoning', 'file_change', 'web_search', 'plan_update'].includes(value.type)) return;

  unknown(`item:${value.type}`);
}

function parseAnswer(value: unknown): ExperimentAnswer | undefined {
  if (!isRecord(value)) return undefined;
  if (Object.keys(value).some(key => !['status', 'answer', 'explanation'].includes(key))) return undefined;
  if (value.status !== 'completed' && value.status !== 'cannot_complete') return undefined;
  if (typeof value.explanation !== 'string') return undefined;
  const answer = jsonValueSchema.safeParse(value.answer);
  if (!answer.success) return undefined;
  return { status: value.status, answer: answer.data, explanation: value.explanation };
}

function addUsage(
  value: unknown,
  total: TokenUsage,
  parseErrors: string[],
  lineNumber: number
): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    parseErrors.push(`Token usage on line ${lineNumber} is malformed.`);
    return;
  }
  const fields = [
    ['inputTokens', 'input_tokens'],
    ['cachedInputTokens', 'cached_input_tokens'],
    ['outputTokens', 'output_tokens'],
    ['reasoningOutputTokens', 'reasoning_output_tokens']
  ] as const;
  const additions = emptyUsage();
  let valid = true;
  for (const [target, source] of fields) {
    const field = value[source];
    if (field === undefined && target === 'reasoningOutputTokens') continue;
    if (!Number.isSafeInteger(field) || (field as number) < 0) {
      valid = false;
      continue;
    }
    additions[target] = field as number;
  }
  if (!valid) {
    parseErrors.push(`Token usage on line ${lineNumber} is malformed.`);
    return;
  }
  for (const [target] of fields) total[target] += additions[target];
}

function addUnknown(type: string, seen: Set<string>, values: string[]): void {
  if (seen.has(type)) return;
  seen.add(type);
  values.push(type);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
