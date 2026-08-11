import OpenAI from 'openai';
import type {
  ResponseCreateParamsNonStreaming,
  ResponseInputItem
} from 'openai/resources/responses/responses';
import type {
  ModelFunctionCall,
  ModelHistoryItem,
  ModelTurnClient,
  ModelTurnRequest,
  ModelTurnResult,
  ModelUsage
} from './model-client.js';

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
export const DEEPSEEK_MODEL = 'deepseek-v4-flash';

export interface ResponsesApi {
  create(
    body: ResponseCreateParamsNonStreaming,
    options?: { signal?: AbortSignal }
  ): Promise<unknown>;
}

export interface DeepSeekSdkOptions {
  apiKey: string;
  baseURL: string;
  maxRetries: number;
  timeout: number;
}

export function requireDeepSeekApiKey(env: NodeJS.ProcessEnv = process.env): string {
  const key = env.DEEPSEEK_API_KEY?.trim();
  if (!key) throw new Error('DEEPSEEK_API_KEY is required.');
  return key;
}

export function deepSeekSdkOptions(apiKey: string): DeepSeekSdkOptions {
  return {
    apiKey,
    baseURL: DEEPSEEK_BASE_URL,
    maxRetries: 0,
    timeout: 60_000
  };
}

export function createDeepSeekModelClient(options: {
  apiKey: string;
  responses?: ResponsesApi;
}): ModelTurnClient {
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY is required.');
  const responses = options.responses ?? createResponsesApi(apiKey);
  return {
    async createTurn(request): Promise<ModelTurnResult> {
      const body = createRequest(request);
      const response = await responses.create(body, { signal: request.signal });
      return parseResponse(response);
    }
  };
}

function createResponsesApi(apiKey: string): ResponsesApi {
  const client = new OpenAI(deepSeekSdkOptions(apiKey));
  return {
    create: (body, options) => client.responses.create(body, options)
  };
}

function createRequest(request: ModelTurnRequest): ResponseCreateParamsNonStreaming {
  const tools = request.tools.map(tool => ({
    type: 'function' as const,
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    parameters: tool.parameters
  })) as NonNullable<ResponseCreateParamsNonStreaming['tools']>;
  return {
    model: DEEPSEEK_MODEL,
    instructions: request.instructions,
    input: request.history.map(toResponseInput),
    tools,
    text: {
      format: { type: 'json_object' }
    },
    store: false,
    reasoning: { effort: 'none' }
  };
}

function toResponseInput(item: ModelHistoryItem): ResponseInputItem {
  switch (item.type) {
    case 'message':
      return { role: item.role, content: item.content };
    case 'function_call':
      return {
        type: 'function_call',
        call_id: item.callId,
        name: item.name,
        arguments: item.arguments
      };
    case 'function_call_output':
      return {
        type: 'function_call_output',
        call_id: item.callId,
        output: item.output
      };
  }
}

function parseResponse(value: unknown): ModelTurnResult {
  if (!isRecord(value) || !Array.isArray(value.output)) {
    throw new Error('DeepSeek returned an invalid response.');
  }
  const historyItems: ModelHistoryItem[] = [];
  const functionCalls: ModelFunctionCall[] = [];
  const finalParts: string[] = [];

  for (const item of value.output) {
    if (!isRecord(item) || typeof item.type !== 'string') {
      throw new Error('DeepSeek returned unsupported response output.');
    }
    if (item.type === 'function_call') {
      if (
        typeof item.call_id !== 'string'
        || typeof item.name !== 'string'
        || typeof item.arguments !== 'string'
      ) {
        throw new Error('DeepSeek returned an invalid function call.');
      }
      const call = {
        callId: item.call_id,
        name: item.name,
        arguments: item.arguments
      };
      functionCalls.push(call);
      historyItems.push({ type: 'function_call', ...call });
      continue;
    }
    if (item.type === 'message') {
      if (!Array.isArray(item.content)) {
        throw new Error('DeepSeek returned an invalid assistant message.');
      }
      const text = item.content.map(content => {
        if (!isRecord(content) || content.type !== 'output_text' || typeof content.text !== 'string') {
          throw new Error('DeepSeek returned unsupported response output.');
        }
        return content.text;
      }).join('');
      if (text.length === 0) throw new Error('DeepSeek returned an empty assistant message.');
      finalParts.push(text);
      historyItems.push({ type: 'message', role: 'assistant', content: text });
      continue;
    }
    throw new Error('DeepSeek returned unsupported response output.');
  }

  const finalText = finalParts.join('');
  return {
    historyItems,
    functionCalls,
    ...(finalText ? { finalText } : {}),
    usage: parseUsage(value.usage)
  };
}

function parseUsage(value: unknown): ModelUsage {
  if (!isRecord(value)) throw new Error('DeepSeek returned invalid token usage.');
  const inputTokens = nonnegativeInteger(value.input_tokens, 'input tokens');
  const outputTokens = nonnegativeInteger(value.output_tokens, 'output tokens');
  const totalTokens = value.total_tokens === undefined
    ? inputTokens + outputTokens
    : nonnegativeInteger(value.total_tokens, 'total tokens');
  return {
    inputTokens,
    cachedInputTokens: nestedCounter(value.input_tokens_details, 'cached_tokens'),
    outputTokens,
    reasoningOutputTokens: nestedCounter(value.output_tokens_details, 'reasoning_tokens'),
    totalTokens
  };
}

function nestedCounter(value: unknown, key: string): number {
  if (value === undefined || value === null) return 0;
  if (!isRecord(value)) throw new Error('DeepSeek returned invalid token details.');
  const counter = value[key];
  return counter === undefined ? 0 : nonnegativeInteger(counter, key);
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`DeepSeek returned invalid ${label}.`);
  }
  return value as number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
