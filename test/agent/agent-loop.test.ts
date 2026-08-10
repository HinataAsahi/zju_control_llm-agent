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
