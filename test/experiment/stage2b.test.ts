import assert from 'node:assert/strict';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { McpToolBridge } from '../../src/agent/mcp-tool-bridge.js';
import type {
  ModelTurnClient,
  ModelTurnRequest,
  ModelTurnResult
} from '../../src/agent/model-client.js';
import {
  parseStage2bArgs,
  runStage2bSmoke
} from '../../src/experiment/stage2b.js';

class T1FakeModel implements ModelTurnClient {
  readonly requests: ModelTurnRequest[] = [];

  constructor(private readonly finalText = '{"status":"completed","answer":3,"explanation":"Three values are greater than five."}') {}

  async createTurn(request: ModelTurnRequest): Promise<ModelTurnResult> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      return {
        historyItems: [{
          type: 'function_call',
          callId: 'call-1',
          name: 'jq_query',
          arguments: JSON.stringify({
            filter: '[.values[] | select(. > 5)] | length',
            source: { type: 'inline', data: { values: [3, 8, 8, 2, 11] } }
          })
        }],
        functionCalls: [{
          callId: 'call-1',
          name: 'jq_query',
          arguments: JSON.stringify({
            filter: '[.values[] | select(. > 5)] | length',
            source: { type: 'inline', data: { values: [3, 8, 8, 2, 11] } }
          })
        }],
        usage: usage(20, 4)
      };
    }
    return {
      historyItems: [{ type: 'message', role: 'assistant', content: this.finalText }],
      functionCalls: [],
      finalText: this.finalText,
      usage: usage(30, 6)
    };
  }
}

test('runs fake model to real MCP for the explicit T1 smoke', async t => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'stage2b-smoke-'));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  await cp(resolve('experiments'), join(repositoryRoot, 'experiments'), { recursive: true });
  const model = new T1FakeModel();
  const times = [
    new Date('2026-08-10T00:00:00.000Z'),
    new Date('2026-08-10T00:00:00.100Z')
  ];

  const record = await runStage2bSmoke({
    repositoryRoot,
    apiKey: 'offline-test-key',
    dependencies: {
      createModelClient: () => model,
      connectTools: options => McpToolBridge.connect({
        ...options,
        serverEntrypoint: resolve('dist/src/mcp/server.js')
      }),
      now: () => times.shift() ?? new Date('2026-08-10T00:00:00.100Z')
    }
  });

  assert.equal(record.taskId, 'T1');
  assert.equal(record.condition, 'explicit');
  assert.equal(record.status, 'completed');
  assert.equal(record.taskSuccess, true);
  assert.equal(record.finalAnswer?.answer, 3);
  assert.equal(record.turns, 2);
  assert.equal(record.toolCalls, 1);
  assert.deepEqual(record.limits, {
    maxTurns: 4,
    maxToolCalls: 4,
    requestTimeoutMs: 60_000,
    totalTimeoutMs: 120_000
  });
  assert.deepEqual(record.usage, {
    inputTokens: 50,
    cachedInputTokens: 10,
    outputTokens: 10,
    reasoningOutputTokens: 0,
    totalTokens: 60
  });
  assert.match(model.requests[0]?.history[0]?.type === 'message'
    ? model.requests[0].history[0].content
    : '', /jq_query/);
  assert.deepEqual(model.requests[0]?.tools.map(tool => tool.name), ['jq_query']);
  assert.match(record.toolEvents[1]?.type === 'function_call_output'
    ? record.toolEvents[1].output
    : '', /"values":\[3\]/);
});

test('accepts only the explicit smoke command', () => {
  assert.deepEqual(parseStage2bArgs(['smoke']), { mode: 'smoke' });
  assert.throws(() => parseStage2bArgs([]), /smoke/);
  assert.throws(() => parseStage2bArgs(['smoke', '--extra']), /smoke/);
  assert.throws(() => parseStage2bArgs(['formal']), /smoke/);
});

test('accepts one bare JSON object with provider prose and an extra top-level field', async t => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'stage2b-smoke-'));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  await cp(resolve('experiments'), join(repositoryRoot, 'experiments'), { recursive: true });
  const model = new T1FakeModel([
    'The result is:',
    '{"status":"completed","answer":3,"explanation":"Counted with jq.","tool":"jq_query"}',
    'This follows from the tool output.'
  ].join('\n'));

  const record = await runStage2bSmoke({
    repositoryRoot,
    apiKey: 'offline-test-key',
    dependencies: {
      createModelClient: () => model,
      connectTools: options => McpToolBridge.connect({
        ...options,
        serverEntrypoint: resolve('dist/src/mcp/server.js')
      })
    }
  });

  assert.equal(record.status, 'completed');
  assert.equal(record.taskSuccess, true);
  assert.equal(record.finalAnswer?.answer, 3);
});

test('records safe structural diagnostics for an invalid final answer', async t => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'stage2b-smoke-'));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  await cp(resolve('experiments'), join(repositoryRoot, 'experiments'), { recursive: true });
  const invalidPayload = '{"status":"completed","answer":"private-value","explanation":42,"extra":"private-extra"}';
  const invalidText = `\`\`\`json\n${invalidPayload}\n\`\`\``;
  const model = new T1FakeModel(invalidText);

  const record = await runStage2bSmoke({
    repositoryRoot,
    apiKey: 'offline-test-key',
    dependencies: {
      createModelClient: () => model,
      connectTools: options => McpToolBridge.connect({
        ...options,
        serverEntrypoint: resolve('dist/src/mcp/server.js')
      })
    }
  });

  assert.equal(record.status, 'model-output-error');
  assert.deepEqual(record.error?.diagnostics, {
    textLength: invalidText.length,
    trimmedLength: invalidText.length,
    hasMarkdownFence: true,
    markdownFenceUnwrapped: true,
    jsonParseSucceeded: true,
    topLevelType: 'object',
    fields: {
      status: { present: true, type: 'string' },
      answer: { present: true, type: 'string' },
      explanation: { present: true, type: 'number' }
    },
    unknownFieldCount: 1,
    validationIssues: [
      { code: 'invalid_type', path: 'explanation' },
      { code: 'unrecognized_keys', path: '<root>' }
    ]
  });
  assert.doesNotMatch(JSON.stringify(record.error?.diagnostics), /private-value|private-extra/);
});

function usage(inputTokens: number, outputTokens: number) {
  return {
    inputTokens,
    cachedInputTokens: 5,
    outputTokens,
    reasoningOutputTokens: 0,
    totalTokens: inputTokens + outputTokens
  };
}
