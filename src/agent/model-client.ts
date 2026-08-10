export interface FunctionTool {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

export type ModelHistoryItem =
  | { type: 'message'; role: 'user' | 'assistant'; content: string }
  | { type: 'function_call'; callId: string; name: string; arguments: string }
  | { type: 'function_call_output'; callId: string; output: string };

export interface ModelUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface ModelFunctionCall {
  callId: string;
  name: string;
  arguments: string;
}

export interface ModelTurnRequest {
  instructions: string;
  history: readonly ModelHistoryItem[];
  tools: readonly FunctionTool[];
  outputSchema: Record<string, unknown>;
  signal: AbortSignal;
}

export interface ModelTurnResult {
  historyItems: ModelHistoryItem[];
  functionCalls: ModelFunctionCall[];
  finalText?: string;
  usage: ModelUsage;
}

export interface ModelTurnClient {
  createTurn(request: ModelTurnRequest): Promise<ModelTurnResult>;
}

export interface ToolGateway {
  listTools(signal: AbortSignal): Promise<FunctionTool[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<string>;
  close(): Promise<void>;
}

export const emptyModelUsage = (): ModelUsage => ({
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0
});
