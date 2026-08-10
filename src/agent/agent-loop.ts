import {
  emptyModelUsage,
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

export interface AgentRunResult<T> {
  status: AgentRunStatus;
  turns: number;
  toolCalls: number;
  history: ModelHistoryItem[];
  usage: ModelUsage;
  finalAnswer?: T;
  error?: { category: string; code: string };
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

export async function runAgent<T>(options: RunAgentOptions<T>): Promise<AgentRunResult<T>> {
  const limits = options.limits ?? STAGE2B_LIMITS;
  const history: ModelHistoryItem[] = [{
    type: 'message',
    role: 'user',
    content: options.input
  }];
  const usage = emptyModelUsage();
  const signal = new AbortController().signal;
  let turns = 0;
  let toolCalls = 0;

  try {
    const availableTools = await options.tools.listTools(signal);
    for (; turns < limits.maxTurns; turns += 1) {
      const turn = await options.client.createTurn({
        instructions: options.instructions,
        history,
        tools: availableTools,
        outputSchema: options.outputSchema,
        signal
      });
      addUsage(usage, turn.usage);
      history.push(...turn.historyItems);

      if (turn.functionCalls.length > 0) {
        for (const call of turn.functionCalls) {
          if (toolCalls >= limits.maxToolCalls) {
            return result('limit-exceeded', turns + 1, toolCalls, history, usage, {
              category: 'limit',
              code: 'MAX_TOOL_CALLS'
            });
          }
          const args = JSON.parse(call.arguments) as Record<string, unknown>;
          const output = await options.tools.callTool(call.name, args, signal);
          toolCalls += 1;
          history.push({
            type: 'function_call_output',
            callId: call.callId,
            output
          });
        }
        continue;
      }

      if (turn.finalText === undefined) {
        return result('protocol-error', turns + 1, toolCalls, history, usage, {
          category: 'model',
          code: 'MISSING_FINAL_TEXT'
        });
      }
      try {
        const finalAnswer = options.parseFinalAnswer(turn.finalText);
        return {
          ...result('completed', turns + 1, toolCalls, history, usage),
          finalAnswer
        };
      } catch {
        return result('model-output-error', turns + 1, toolCalls, history, usage, {
          category: 'model',
          code: 'INVALID_FINAL_ANSWER'
        });
      }
    }

    return result('limit-exceeded', turns, toolCalls, history, usage, {
      category: 'limit',
      code: 'MAX_TURNS'
    });
  } finally {
    await options.tools.close();
  }
}

function result<T>(
  status: AgentRunStatus,
  turns: number,
  toolCalls: number,
  history: ModelHistoryItem[],
  usage: ModelUsage,
  error?: { category: string; code: string }
): AgentRunResult<T> {
  return {
    status,
    turns,
    toolCalls,
    history: [...history],
    usage: { ...usage },
    ...(error ? { error } : {})
  };
}

function addUsage(total: ModelUsage, addition: ModelUsage): void {
  total.inputTokens += addition.inputTokens;
  total.cachedInputTokens += addition.cachedInputTokens;
  total.outputTokens += addition.outputTokens;
  total.reasoningOutputTokens += addition.reasoningOutputTokens;
  total.totalTokens += addition.totalTokens;
}
