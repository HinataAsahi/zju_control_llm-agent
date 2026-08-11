import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDeepSeekModelClient,
  deepSeekSdkOptions,
  requireDeepSeekApiKey,
  type ResponsesApi
} from '../../src/agent/deepseek-client.js';
import type { ModelTurnRequest } from '../../src/agent/model-client.js';

const outputSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: { status: { type: 'string' } },
  required: ['status'],
  additionalProperties: false
};

function request(signal = new AbortController().signal): ModelTurnRequest {
  return {
    instructions: 'Use jq when applicable.',
    history: [
      { type: 'message', role: 'user', content: 'Count users.' },
      {
        type: 'function_call',
        callId: 'call-1',
        name: 'jq_query',
        arguments: '{"filter":"length"}'
      },
      { type: 'function_call_output', callId: 'call-1', output: '{"ok":true}' }
    ],
    tools: [{
      name: 'jq_query',
      description: 'Run jq.',
      parameters: { type: 'object', properties: { filter: { type: 'string' } } }
    }],
    outputSchema,
    signal
  };
}

test('configures the official SDK without retry or provider-side state', async () => {
  let capturedBody: Record<string, unknown> | undefined;
  let capturedSignal: AbortSignal | undefined;
  const signal = new AbortController().signal;
  const responses: ResponsesApi = {
    async create(body, options) {
      capturedBody = body as unknown as Record<string, unknown>;
      capturedSignal = options?.signal;
      return responseWithMessage('{"status":"completed"}');
    }
  };

  const client = createDeepSeekModelClient({ apiKey: 'test-key', responses });
  await client.createTurn(request(signal));

  assert.equal(capturedBody?.model, 'deepseek-v4-flash');
  assert.equal(capturedBody?.store, false);
  assert.deepEqual(capturedBody?.reasoning, { effort: 'none' });
  assert.equal(capturedBody?.instructions, 'Use jq when applicable.');
  assert.equal(capturedSignal, signal);
  assert.deepEqual(capturedBody?.text, {
    format: { type: 'json_object' }
  });
  assert.doesNotMatch(JSON.stringify(capturedBody?.text), /schema/);
  assert.deepEqual(capturedBody?.tools, [{
    type: 'function',
    name: 'jq_query',
    description: 'Run jq.',
    parameters: { type: 'object', properties: { filter: { type: 'string' } } }
  }]);
  assert.deepEqual(capturedBody?.input, [
    { role: 'user', content: 'Count users.' },
    {
      type: 'function_call',
      call_id: 'call-1',
      name: 'jq_query',
      arguments: '{"filter":"length"}'
    },
    { type: 'function_call_output', call_id: 'call-1', output: '{"ok":true}' }
  ]);
  assert.deepEqual(deepSeekSdkOptions('test-key'), {
    apiKey: 'test-key',
    baseURL: 'https://api.deepseek.com',
    maxRetries: 0,
    timeout: 60_000
  });
});

test('maps function calls, final text, and token details', async () => {
  const responses: ResponsesApi = {
    async create() {
      return {
        output: [
          {
            type: 'function_call',
            call_id: 'call-2',
            name: 'jq_query',
            arguments: '{"filter":"length"}'
          },
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: '{"status":"completed"}' }]
          }
        ],
        usage: {
          input_tokens: 100,
          input_tokens_details: { cached_tokens: 60 },
          output_tokens: 20,
          output_tokens_details: { reasoning_tokens: 2 },
          total_tokens: 120
        }
      };
    }
  };

  const turn = await createDeepSeekModelClient({ apiKey: 'test-key', responses })
    .createTurn(request());

  assert.deepEqual(turn.functionCalls, [{
    callId: 'call-2',
    name: 'jq_query',
    arguments: '{"filter":"length"}'
  }]);
  assert.equal(turn.finalText, '{"status":"completed"}');
  assert.deepEqual(turn.historyItems, [
    {
      type: 'function_call',
      callId: 'call-2',
      name: 'jq_query',
      arguments: '{"filter":"length"}'
    },
    {
      type: 'message',
      role: 'assistant',
      content: '{"status":"completed"}'
    }
  ]);
  assert.deepEqual(turn.usage, {
    inputTokens: 100,
    cachedInputTokens: 60,
    outputTokens: 20,
    reasoningOutputTokens: 2,
    totalTokens: 120
  });
});

test('rejects missing keys and unsupported response output', async () => {
  assert.throws(() => requireDeepSeekApiKey({}), /DEEPSEEK_API_KEY/);
  assert.throws(() => requireDeepSeekApiKey({ DEEPSEEK_API_KEY: '   ' }), /DEEPSEEK_API_KEY/);
  assert.equal(requireDeepSeekApiKey({ DEEPSEEK_API_KEY: ' key ' }), 'key');

  const responses: ResponsesApi = {
    async create() {
      return { output: [{ type: 'reasoning' }], usage: zeroUsage() };
    }
  };
  await assert.rejects(
    createDeepSeekModelClient({ apiKey: 'test-key', responses }).createTurn(request()),
    /unsupported response output/i
  );
});

function responseWithMessage(text: string): unknown {
  return {
    output: [{
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text }]
    }],
    usage: zeroUsage()
  };
}

function zeroUsage() {
  return {
    input_tokens: 0,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 0,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 0
  };
}
