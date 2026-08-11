import assert from 'node:assert/strict';
import test from 'node:test';
import { runAgent } from '../../src/agent/agent-loop.js';
import type {
  FunctionTool,
  ModelTurnClient,
  ModelTurnResult,
  ToolGateway
} from '../../src/agent/model-client.js';
import { parseExperimentAnswer } from '../../src/experiment/schema.js';

const finalSchema = {
  type: 'object',
  properties: {
    status: { enum: ['completed', 'cannot_complete'] },
    answer: {},
    explanation: { type: 'string' }
  },
  required: ['status', 'answer', 'explanation'],
  additionalProperties: false
};

const jqTool: FunctionTool = {
  name: 'jq_query',
  description: 'Run jq against JSON.',
  parameters: { type: 'object' }
};

function usage(inputTokens: number, outputTokens: number) {
  return {
    inputTokens,
    cachedInputTokens: 1,
    outputTokens,
    reasoningOutputTokens: 0,
    totalTokens: inputTokens + outputTokens
  };
}

function fakeClient(turns: ModelTurnResult[]): ModelTurnClient & { requests: number } {
  return {
    requests: 0,
    async createTurn() {
      const turn = turns[this.requests];
      this.requests += 1;
      if (!turn) throw new Error('Unexpected model turn.');
      return turn;
    }
  };
}

function fakeGateway(outputs: string[] = []): ToolGateway & {
  calls: Array<{ name: string; args: Record<string, unknown> }>;
  closes: number;
} {
  return {
    calls: [],
    closes: 0,
    async listTools() {
      return [jqTool];
    },
    async callTool(name, args) {
      this.calls.push({ name, args });
      return outputs[this.calls.length - 1] ?? '{}';
    },
    async close() {
      this.closes += 1;
    }
  };
}

test('returns a validated final answer from the first model turn', async () => {
  const text = '{"status":"completed","answer":3,"explanation":"Counted users."}';
  const client = fakeClient([{
    historyItems: [{ type: 'message', role: 'assistant', content: text }],
    functionCalls: [],
    finalText: text,
    usage: usage(10, 5)
  }]);
  const gateway = fakeGateway();

  const result = await runAgent({
    client,
    tools: gateway,
    instructions: 'Use the available tool when applicable.',
    input: 'Count users.',
    outputSchema: finalSchema,
    parseFinalAnswer: textValue => parseExperimentAnswer(JSON.parse(textValue))
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.turns, 1);
  assert.equal(result.toolCalls, 0);
  assert.equal(result.finalAnswer?.answer, 3);
  assert.deepEqual(result.usage, usage(10, 5));
  assert.equal(result.history[0]?.type, 'message');
  assert.equal(gateway.closes, 1);
});

test('dispatches a function call and replays its output before completion', async () => {
  const finalText = '{"status":"completed","answer":3,"explanation":"Counted users."}';
  const client = fakeClient([
    {
      historyItems: [{
        type: 'function_call',
        callId: 'call-1',
        name: 'jq_query',
        arguments: '{"filter":"length","source":{"type":"file","path":"users.json"}}'
      }],
      functionCalls: [{
        callId: 'call-1',
        name: 'jq_query',
        arguments: '{"filter":"length","source":{"type":"file","path":"users.json"}}'
      }],
      usage: usage(20, 4)
    },
    {
      historyItems: [{ type: 'message', role: 'assistant', content: finalText }],
      functionCalls: [],
      finalText,
      usage: usage(30, 6)
    }
  ]);
  const gateway = fakeGateway(['{"ok":true,"values":[3],"exitCode":0}']);

  const result = await runAgent({
    client,
    tools: gateway,
    instructions: 'Use jq_query.',
    input: 'Count users.',
    outputSchema: finalSchema,
    parseFinalAnswer: textValue => parseExperimentAnswer(JSON.parse(textValue))
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.turns, 2);
  assert.equal(result.toolCalls, 1);
  assert.deepEqual(gateway.calls, [{
    name: 'jq_query',
    args: { filter: 'length', source: { type: 'file', path: 'users.json' } }
  }]);
  assert.deepEqual(result.history.at(-2), {
    type: 'function_call_output',
    callId: 'call-1',
    output: '{"ok":true,"values":[3],"exitCode":0}'
  });
  assert.deepEqual(result.usage, {
    inputTokens: 50,
    cachedInputTokens: 2,
    outputTokens: 10,
    reasoningOutputTokens: 0,
    totalTokens: 60
  });
  assert.equal(gateway.closes, 1);
});

test('prioritizes function calls and discards text from a mixed model turn', async () => {
  const prematureText = '{"status":"completed","answer":99,"explanation":"Premature."}';
  const finalText = '{"status":"completed","answer":3,"explanation":"Counted after the tool result."}';
  const call = {
    callId: 'call-mixed',
    name: 'jq_query',
    arguments: '{"filter":"length"}'
  };
  const client = fakeClient([
    {
      historyItems: [
        { type: 'function_call', ...call },
        { type: 'message', role: 'assistant', content: prematureText }
      ],
      functionCalls: [call],
      finalText: prematureText,
      usage: usage(10, 4)
    },
    {
      historyItems: [{ type: 'message', role: 'assistant', content: finalText }],
      functionCalls: [],
      finalText,
      usage: usage(12, 3)
    }
  ]);
  const gateway = fakeGateway(['{"ok":true,"values":[3],"exitCode":0}']);

  const result = await runAgent({
    client,
    tools: gateway,
    instructions: 'Use jq_query.',
    input: 'Count users.',
    outputSchema: finalSchema,
    parseFinalAnswer: textValue => parseExperimentAnswer(JSON.parse(textValue))
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.finalAnswer?.answer, 3);
  assert.equal(result.turns, 2);
  assert.equal(result.toolCalls, 1);
  assert.equal(result.history.some(item => item.type === 'message'
    && item.role === 'assistant'
    && item.content === prematureText), false);
  assert.equal(gateway.calls.length, 1);
});

test('returns malformed arguments to the model without invoking the tool', async () => {
  const finalText = '{"status":"cannot_complete","answer":null,"explanation":"Invalid request."}';
  const client = fakeClient([
    {
      historyItems: [{
        type: 'function_call', callId: 'bad', name: 'jq_query', arguments: '{bad json'
      }],
      functionCalls: [{ callId: 'bad', name: 'jq_query', arguments: '{bad json' }],
      usage: usage(1, 1)
    },
    {
      historyItems: [{ type: 'message', role: 'assistant', content: finalText }],
      functionCalls: [],
      finalText,
      usage: usage(1, 1)
    }
  ]);
  const gateway = fakeGateway();

  const result = await runAgent({
    client,
    tools: gateway,
    instructions: 'Use tools.',
    input: 'Count.',
    outputSchema: finalSchema,
    parseFinalAnswer: textValue => parseExperimentAnswer(JSON.parse(textValue))
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.toolCalls, 0);
  assert.equal(gateway.calls.length, 0);
  assert.match(JSON.stringify(result.history), /INVALID_TOOL_ARGUMENTS/);
});

test('returns an unknown tool error to the model', async () => {
  const finalText = '{"status":"completed","answer":3,"explanation":"Recovered."}';
  const client = fakeClient([
    {
      historyItems: [{
        type: 'function_call', callId: 'unknown', name: 'filesystem', arguments: '{}'
      }],
      functionCalls: [{ callId: 'unknown', name: 'filesystem', arguments: '{}' }],
      usage: usage(1, 1)
    },
    {
      historyItems: [{ type: 'message', role: 'assistant', content: finalText }],
      functionCalls: [],
      finalText,
      usage: usage(1, 1)
    }
  ]);
  const gateway = fakeGateway();

  const result = await runAgent({
    client,
    tools: gateway,
    instructions: 'Use tools.',
    input: 'Count.',
    outputSchema: finalSchema,
    parseFinalAnswer: textValue => parseExperimentAnswer(JSON.parse(textValue))
  });

  assert.equal(result.status, 'completed');
  assert.match(JSON.stringify(result.history), /TOOL_NOT_FOUND/);
  assert.equal(gateway.calls.length, 0);
});

test('does not execute a fifth tool call', async () => {
  const calls = Array.from({ length: 5 }, (_, index) => ({
    callId: `call-${index}`,
    name: 'jq_query',
    arguments: '{}'
  }));
  const client = fakeClient([{
    historyItems: calls.map(call => ({ type: 'function_call' as const, ...call })),
    functionCalls: calls,
    usage: usage(1, 1)
  }]);
  const gateway = fakeGateway(['{}', '{}', '{}', '{}', '{}']);

  const result = await runAgent({
    client,
    tools: gateway,
    instructions: 'Use tools.',
    input: 'Count.',
    outputSchema: finalSchema,
    parseFinalAnswer: textValue => parseExperimentAnswer(JSON.parse(textValue))
  });

  assert.equal(result.status, 'limit-exceeded');
  assert.equal(result.error?.code, 'MAX_TOOL_CALLS');
  assert.equal(result.toolCalls, 4);
  assert.equal(gateway.calls.length, 4);
  assert.equal(gateway.closes, 1);
});

test('classifies API, MCP, and invalid final output without exposing raw errors', async t => {
  await t.test('API', async () => {
    const gateway = fakeGateway();
    const result = await runAgent({
      client: {
        async createTurn() {
          throw {
            status: 429,
            request_id: 'req_safe123',
            error: { code: 'rate_limit', param: 'model', message: 'secret prompt payload' },
            usage: usage(12, 3)
          };
        }
      },
      tools: gateway,
      instructions: 'secret instruction',
      input: 'secret input',
      outputSchema: finalSchema,
      parseFinalAnswer: textValue => parseExperimentAnswer(JSON.parse(textValue))
    });
    assert.equal(result.status, 'infrastructure-error');
    assert.deepEqual(result.error, {
      category: 'api',
      code: 'MODEL_REQUEST_FAILED',
      httpStatus: 429,
      requestId: 'req_safe123',
      providerCode: 'rate_limit',
      providerParam: 'model'
    });
    assert.deepEqual(result.usage, usage(12, 3));
    assert.doesNotMatch(JSON.stringify(result.error), /secret/);
    assert.equal(gateway.closes, 1);
  });

  await t.test('MCP', async () => {
    const gateway = fakeGateway();
    gateway.listTools = async () => { throw new Error('private path'); };
    const result = await runAgent({
      client: fakeClient([]),
      tools: gateway,
      instructions: 'Use tools.',
      input: 'Count.',
      outputSchema: finalSchema,
      parseFinalAnswer: textValue => parseExperimentAnswer(JSON.parse(textValue))
    });
    assert.equal(result.status, 'infrastructure-error');
    assert.deepEqual(result.error, { category: 'mcp', code: 'TOOL_DISCOVERY_FAILED' });
    assert.equal(gateway.closes, 1);
  });

  await t.test('final output', async () => {
    const gateway = fakeGateway();
    const result = await runAgent({
      client: fakeClient([{
        historyItems: [{ type: 'message', role: 'assistant', content: 'not json' }],
        functionCalls: [],
        finalText: 'not json',
        usage: usage(1, 1)
      }]),
      tools: gateway,
      instructions: 'Use tools.',
      input: 'Count.',
      outputSchema: finalSchema,
      parseFinalAnswer: textValue => parseExperimentAnswer(JSON.parse(textValue))
    });
    assert.equal(result.status, 'model-output-error');
    assert.equal(result.error?.code, 'INVALID_FINAL_ANSWER');
    assert.equal(gateway.closes, 1);
  });
});

test('aborts a model request at its per-request timeout', async () => {
  const gateway = fakeGateway();
  const client: ModelTurnClient = {
    async createTurn(request) {
      return await new Promise<ModelTurnResult>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
      });
    }
  };

  const result = await runAgent({
    client,
    tools: gateway,
    instructions: 'Use tools.',
    input: 'Count.',
    outputSchema: finalSchema,
    parseFinalAnswer: textValue => parseExperimentAnswer(JSON.parse(textValue)),
    limits: { maxTurns: 4, maxToolCalls: 4, requestTimeoutMs: 10, totalTimeoutMs: 100 }
  });

  assert.equal(result.status, 'infrastructure-error');
  assert.deepEqual(result.error, { category: 'api', code: 'REQUEST_TIMEOUT' });
  assert.equal(gateway.closes, 1);
});
