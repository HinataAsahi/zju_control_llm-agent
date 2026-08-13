import type { Stage2bRecord, Stage2bToolEvent } from './stage2b-record.js';
import {
  getStage2bTaskProfile,
  type Stage2bTaskId
} from './stage2b-suite.js';

export type Stage2bPublicJqErrorCode =
  | 'PATH_NOT_ALLOWED'
  | 'FILE_NOT_FOUND'
  | 'INPUT_TOO_LARGE'
  | 'JQ_SYNTAX_ERROR'
  | 'JQ_RUNTIME_ERROR'
  | 'TIMEOUT'
  | 'OUTPUT_LIMIT'
  | 'INTERNAL_ERROR';

export interface Stage2bProcessInput {
  taskId: Stage2bTaskId;
  taskSuccess: boolean | null;
  toolEvents: readonly Stage2bToolEvent[];
}

export interface Stage2bRecoveryInput extends Stage2bProcessInput {
  status: Stage2bRecord['status'];
}

export interface Stage2bProcessAnalysis {
  toolCompliance: boolean;
  firstCallOutcome:
    | 'no-call'
    | 'ok'
    | 'invalid-arguments'
    | 'missing-output'
    | 'malformed-output'
    | 'tool-error'
    | Stage2bPublicJqErrorCode;
  strategy:
    | 'avoided-tool'
    | 'unnecessary-tool'
    | 'one-shot-query'
    | 'inspect-first'
    | 'recovered-after-error'
    | 'unresolved';
  tracePath: string[];
}

type PublicOutcome = Exclude<Stage2bProcessAnalysis['firstCallOutcome'], 'no-call' | 'invalid-arguments'>;

interface ClassifiedCall {
  action: 'inspect-root' | 'task-query' | 'invalid-arguments';
  outcome: PublicOutcome;
  result: 'ok' | 'error' | 'structural';
  callIndex: number;
  outputIndex?: number;
}

const publicJqErrorCodes = new Set<Stage2bPublicJqErrorCode>([
  'PATH_NOT_ALLOWED',
  'FILE_NOT_FOUND',
  'INPUT_TOO_LARGE',
  'JQ_SYNTAX_ERROR',
  'JQ_RUNTIME_ERROR',
  'TIMEOUT',
  'OUTPUT_LIMIT',
  'INTERNAL_ERROR'
]);

export function analyzeStage2bProcess(input: Stage2bProcessInput): Stage2bProcessAnalysis {
  const profile = getStage2bTaskProfile(input.taskId);
  const calls = classifyJqCalls(input.toolEvents);
  const toolCallCount = input.toolEvents.filter(event => event.type === 'function_call').length;
  const first = calls[0];
  const toolCompliance = profile.toolPolicy === 'forbidden'
    ? toolCallCount === 0
    : calls.length > 0;

  let strategy: Stage2bProcessAnalysis['strategy'];
  if (profile.toolPolicy === 'forbidden') {
    strategy = toolCallCount === 0 ? 'avoided-tool' : 'unnecessary-tool';
  } else if (!first) {
    strategy = 'unresolved';
  } else if (first.action === 'inspect-root' && input.taskSuccess === true) {
    strategy = 'inspect-first';
  } else if (hasSuccessfulCallAfterError(calls) && input.taskSuccess === true) {
    strategy = 'recovered-after-error';
  } else if (
    first.action === 'task-query'
    && first.result === 'ok'
    && input.taskSuccess === true
  ) {
    strategy = 'one-shot-query';
  } else {
    strategy = 'unresolved';
  }

  return {
    toolCompliance,
    firstCallOutcome: !first
      ? 'no-call'
      : first.action === 'invalid-arguments'
        ? 'invalid-arguments'
        : first.outcome,
    strategy,
    tracePath: calls.map(call => `${call.action}:${call.outcome}`)
  };
}

export function evaluateStage2bRecovery(input: Stage2bRecoveryInput): boolean | null {
  const profile = getStage2bTaskProfile(input.taskId);
  if (profile.recoveryMode === 'none') return null;
  if (profile.recoveryMode === 'required') return evaluateRequiredRecovery(input);

  const calls = classifyJqCalls(input.toolEvents);
  if (!calls.some(call => call.result === 'error')) return null;
  return hasSuccessfulCallAfterError(calls) && input.taskSuccess === true;
}

function evaluateRequiredRecovery(input: Stage2bRecoveryInput): boolean | null {
  if (input.status !== 'completed') return null;
  const calls = input.toolEvents.filter(event => event.type === 'function_call');
  const first = calls[0];
  if (!first || first.name !== 'jq_query') return false;

  const firstArguments = parseJsonObject(first.arguments);
  const firstOutput = outputForCall(input.toolEvents, first.callId);
  const firstResult = firstOutput === undefined ? undefined : parseJsonObject(firstOutput);
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
    const output = outputForCall(input.toolEvents, call.callId);
    return output === undefined ? false : parseJsonObject(output)?.ok === true;
  });
}

function classifyJqCalls(events: readonly Stage2bToolEvent[]): ClassifiedCall[] {
  const callPositions = groupEventPositions(events, 'function_call');
  const outputPositions = groupEventPositions(events, 'function_call_output');
  return events.flatMap((event, callIndex) => {
    if (!isJqCall(event)) return [];
    const call = event;
    const argumentsValue = parseJsonObject(call.arguments);
    const filter = argumentsValue?.filter;
    const action = typeof filter !== 'string'
      ? 'invalid-arguments' as const
      : filter.trim() === '.'
        ? 'inspect-root' as const
        : 'task-query' as const;
    const matchingCalls = callPositions.get(call.callId) ?? [];
    const matchingOutputs = outputPositions.get(call.callId) ?? [];
    if (
      matchingCalls.length !== 1
      || matchingOutputs.length > 1
      || (matchingOutputs[0] !== undefined && matchingOutputs[0] <= callIndex)
    ) {
      return [{
        action,
        outcome: 'malformed-output' as const,
        result: 'structural' as const,
        callIndex
      }];
    }
    const outputIndex = matchingOutputs[0];
    const output = outputIndex === undefined
      ? undefined
      : extractOutput(events[outputIndex]);
    return [{
      action,
      ...classifyOutput(output),
      callIndex,
      ...(outputIndex === undefined ? {} : { outputIndex })
    }];
  });
}

function classifyOutput(output: string | undefined): Pick<ClassifiedCall, 'outcome' | 'result'> {
  if (output === undefined) return { outcome: 'missing-output', result: 'structural' };
  const parsed = parseJsonObject(output);
  if (!parsed) return { outcome: 'malformed-output', result: 'structural' };
  if (parsed.ok === true) return { outcome: 'ok', result: 'ok' };
  if (parsed.ok !== false) return { outcome: 'malformed-output', result: 'structural' };
  const error = parsed.error;
  const code = isRecord(error) ? error.code : undefined;
  return {
    outcome: typeof code === 'string' && publicJqErrorCodes.has(code as Stage2bPublicJqErrorCode)
      ? code as Stage2bPublicJqErrorCode
      : 'tool-error',
    result: 'error'
  };
}

function hasSuccessfulCallAfterError(calls: readonly ClassifiedCall[]): boolean {
  for (const error of calls) {
    const errorOutputIndex = error.outputIndex;
    if (error.result !== 'error' || errorOutputIndex === undefined) continue;
    if (calls.some(success =>
      success.result === 'ok' && success.callIndex > errorOutputIndex
    )) return true;
  }
  return false;
}

function groupEventPositions(
  events: readonly Stage2bToolEvent[],
  type: Stage2bToolEvent['type']
): Map<string, number[]> {
  const positions = new Map<string, number[]>();
  events.forEach((event, index) => {
    if (event.type !== type) return;
    const current = positions.get(event.callId) ?? [];
    current.push(index);
    positions.set(event.callId, current);
  });
  return positions;
}

function extractOutput(event: Stage2bToolEvent | undefined): string | undefined {
  return event?.type === 'function_call_output' ? event.output : undefined;
}

function outputForCall(events: readonly Stage2bToolEvent[], callId: string): string | undefined {
  return events.find((event): event is Extract<Stage2bToolEvent, { type: 'function_call_output' }> =>
    event.type === 'function_call_output' && event.callId === callId
  )?.output;
}

function isJqCall(
  event: Stage2bToolEvent
): event is Extract<Stage2bToolEvent, { type: 'function_call' }> {
  return event.type === 'function_call' && event.name === 'jq_query';
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
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
