import {
  emptyModelUsage,
  type FunctionTool,
  type ModelHistoryItem,
  type ModelTurnClient,
  type ModelUsage,
  type ToolGateway
} from './model-client.js';

export interface AgentLimits {
  maxTurns: number;
  maxToolCalls: number;
  requestTimeoutMs: number;
  totalTimeoutMs: number;
}

export const STAGE2B_LIMITS: Readonly<AgentLimits> = Object.freeze({
  maxTurns: 4,
  maxToolCalls: 4,
  requestTimeoutMs: 60_000,
  totalTimeoutMs: 120_000
});

export type AgentRunStatus =
  | 'completed'
  | 'infrastructure-error'
  | 'protocol-error'
  | 'model-output-error'
  | 'limit-exceeded';

export interface AgentRunError {
  category: 'api' | 'mcp' | 'model' | 'limit' | 'configuration';
  code: string;
  httpStatus?: number;
  requestId?: string;
}

export interface AgentRunResult<T> {
  status: AgentRunStatus;
  turns: number;
  toolCalls: number;
  history: ModelHistoryItem[];
  usage: ModelUsage;
  finalAnswer?: T;
  error?: AgentRunError;
}

export interface RunAgentOptions<T> {
  client: ModelTurnClient;
  tools: ToolGateway;
  instructions: string;
  input: string;
  outputSchema: Record<string, unknown>;
  parseFinalAnswer(text: string): T;
  limits?: AgentLimits;
}

interface RunState {
  turns: number;
  toolCalls: number;
  history: ModelHistoryItem[];
  usage: ModelUsage;
}

export async function runAgent<T>(options: RunAgentOptions<T>): Promise<AgentRunResult<T>> {
  const limits = options.limits ?? STAGE2B_LIMITS;
  const state: RunState = {
    turns: 0,
    toolCalls: 0,
    history: [{ type: 'message', role: 'user', content: options.input }],
    usage: emptyModelUsage()
  };
  const totalController = new AbortController();
  const totalTimer = setTimeout(
    () => totalController.abort(new Error('Agent total timeout.')),
    Math.max(1, limits.totalTimeoutMs)
  );
  totalTimer.unref();
  let runResult: AgentRunResult<T>;

  try {
    if (!validLimits(limits)) {
      runResult = failure('protocol-error', state, 'configuration', 'INVALID_LIMITS');
    } else {
      runResult = await runCore(options, limits, state, totalController.signal);
    }
  } catch {
    runResult = failure('infrastructure-error', state, 'mcp', 'UNEXPECTED_RUNNER_FAILURE');
  } finally {
    clearTimeout(totalTimer);
  }

  try {
    await options.tools.close();
  } catch {
    if (runResult.status === 'completed') {
      return failure('infrastructure-error', state, 'mcp', 'TOOL_CLOSE_FAILED');
    }
  }
  return runResult;
}

async function runCore<T>(
  options: RunAgentOptions<T>,
  limits: AgentLimits,
  state: RunState,
  totalSignal: AbortSignal
): Promise<AgentRunResult<T>> {
  let availableTools: FunctionTool[];
  try {
    availableTools = await options.tools.listTools(totalSignal);
  } catch {
    return failure(
      'infrastructure-error',
      state,
      'mcp',
      totalSignal.aborted ? 'TOTAL_TIMEOUT' : 'TOOL_DISCOVERY_FAILED'
    );
  }
  const toolNames = new Set(availableTools.map(tool => tool.name));

  while (state.turns < limits.maxTurns) {
    state.turns += 1;
    const requestController = new AbortController();
    const requestTimer = setTimeout(
      () => requestController.abort(new Error('Model request timeout.')),
      limits.requestTimeoutMs
    );
    requestTimer.unref();
    let turn;
    try {
      turn = await options.client.createTurn({
        instructions: options.instructions,
        history: state.history,
        tools: availableTools,
        outputSchema: options.outputSchema,
        signal: AbortSignal.any([totalSignal, requestController.signal])
      });
    } catch (error) {
      const code = totalSignal.aborted
        ? 'TOTAL_TIMEOUT'
        : requestController.signal.aborted
          ? 'REQUEST_TIMEOUT'
          : 'MODEL_REQUEST_FAILED';
      return failure(
        'infrastructure-error',
        state,
        'api',
        code,
        code === 'MODEL_REQUEST_FAILED' ? providerMetadata(error) : undefined
      );
    } finally {
      clearTimeout(requestTimer);
    }

    addUsage(state.usage, turn.usage);
    state.history.push(...turn.historyItems);

    if (turn.functionCalls.length > 0) {
      if (turn.finalText !== undefined) {
        return failure('protocol-error', state, 'model', 'MIXED_MODEL_OUTPUT');
      }
      for (const call of turn.functionCalls) {
        if (!toolNames.has(call.name)) {
          state.history.push(toolError(call.callId, 'TOOL_NOT_FOUND'));
          continue;
        }
        const args = parseArguments(call.arguments);
        if (!args) {
          state.history.push(toolError(call.callId, 'INVALID_TOOL_ARGUMENTS'));
          continue;
        }
        if (state.toolCalls >= limits.maxToolCalls) {
          return failure('limit-exceeded', state, 'limit', 'MAX_TOOL_CALLS');
        }
        let output: string;
        try {
          output = await options.tools.callTool(call.name, args, totalSignal);
        } catch {
          return failure(
            'infrastructure-error',
            state,
            'mcp',
            totalSignal.aborted ? 'TOTAL_TIMEOUT' : 'TOOL_CALL_FAILED'
          );
        }
        state.toolCalls += 1;
        state.history.push({
          type: 'function_call_output',
          callId: call.callId,
          output
        });
      }
      continue;
    }

    if (turn.finalText === undefined) {
      return failure('protocol-error', state, 'model', 'MISSING_FINAL_TEXT');
    }
    try {
      return {
        ...snapshot('completed', state),
        finalAnswer: options.parseFinalAnswer(turn.finalText)
      };
    } catch {
      return failure('model-output-error', state, 'model', 'INVALID_FINAL_ANSWER');
    }
  }

  return failure('limit-exceeded', state, 'limit', 'MAX_TURNS');
}

function validLimits(limits: AgentLimits): boolean {
  return Number.isSafeInteger(limits.maxTurns)
    && limits.maxTurns > 0
    && Number.isSafeInteger(limits.maxToolCalls)
    && limits.maxToolCalls > 0
    && Number.isSafeInteger(limits.requestTimeoutMs)
    && limits.requestTimeoutMs > 0
    && Number.isSafeInteger(limits.totalTimeoutMs)
    && limits.totalTimeoutMs > 0;
}

function parseArguments(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function toolError(callId: string, code: string): ModelHistoryItem {
  return {
    type: 'function_call_output',
    callId,
    output: JSON.stringify({ ok: false, error: { code } })
  };
}

function failure<T>(
  status: Exclude<AgentRunStatus, 'completed'>,
  state: RunState,
  category: AgentRunError['category'],
  code: string,
  metadata?: Pick<AgentRunError, 'httpStatus' | 'requestId'>
): AgentRunResult<T> {
  return {
    ...snapshot(status, state),
    error: { category, code, ...metadata }
  };
}

function snapshot<T>(status: AgentRunStatus, state: RunState): AgentRunResult<T> {
  return {
    status,
    turns: state.turns,
    toolCalls: state.toolCalls,
    history: [...state.history],
    usage: { ...state.usage }
  };
}

function addUsage(total: ModelUsage, addition: ModelUsage): void {
  total.inputTokens += addition.inputTokens;
  total.cachedInputTokens += addition.cachedInputTokens;
  total.outputTokens += addition.outputTokens;
  total.reasoningOutputTokens += addition.reasoningOutputTokens;
  total.totalTokens += addition.totalTokens;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function providerMetadata(
  error: unknown
): Pick<AgentRunError, 'httpStatus' | 'requestId'> | undefined {
  if (!isRecord(error)) return undefined;
  const httpStatus = Number.isSafeInteger(error.status)
    && (error.status as number) >= 100
    && (error.status as number) <= 599
    ? error.status as number
    : undefined;
  const rawRequestId = typeof error.request_id === 'string'
    ? error.request_id
    : typeof error.requestID === 'string'
      ? error.requestID
      : undefined;
  const requestId = rawRequestId
    && rawRequestId.length <= 128
    && /^[A-Za-z0-9._:-]+$/.test(rawRequestId)
    ? rawRequestId
    : undefined;
  if (httpStatus === undefined && requestId === undefined) return undefined;
  return {
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(requestId !== undefined ? { requestId } : {})
  };
}
