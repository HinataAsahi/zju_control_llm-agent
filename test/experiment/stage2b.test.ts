import assert from 'node:assert/strict';
import { cp, lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
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
  runStage2bSmoke,
  stage2bExitCode
} from '../../src/experiment/stage2b.js';
import { writeStage2bRecord } from '../../src/experiment/stage2b-record.js';

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
  assert.match(model.requests[0]?.instructions ?? '', /JSON/);
  assert.match(model.requests[0]?.instructions ?? '', /"status"/);
  assert.match(model.requests[0]?.instructions ?? '', /no other fields/i);
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

test('returns a failing process code unless the smoke task completes correctly', () => {
  assert.equal(stage2bExitCode({ status: 'completed', taskSuccess: true }), 0);
  assert.equal(stage2bExitCode({ status: 'completed', taskSuccess: false }), 1);
  assert.equal(stage2bExitCode({ status: 'infrastructure-error', taskSuccess: null }), 1);
  assert.equal(stage2bExitCode({ status: 'model-output-error', taskSuccess: null }), 1);
});

test('returns and privately persists a safe MCP connection failure record', async t => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'stage2b-smoke-'));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  await cp(resolve('experiments'), join(repositoryRoot, 'experiments'), { recursive: true });
  const times = [
    new Date('2026-08-10T00:00:00.000Z'),
    new Date('2026-08-10T00:00:00.025Z')
  ];

  const record = await runStage2bSmoke({
    repositoryRoot,
    apiKey: 'offline-test-key',
    dependencies: {
      createModelClient: () => new T1FakeModel(),
      connectTools: async () => { throw new Error('/home/private/server failed'); },
      now: () => times.shift() ?? new Date('2026-08-10T00:00:00.025Z')
    }
  });

  assert.equal(record.status, 'infrastructure-error');
  assert.equal(record.taskSuccess, null);
  assert.equal(record.turns, 0);
  assert.equal(record.toolCalls, 0);
  assert.deepEqual(record.error, { category: 'mcp', code: 'TOOL_CONNECTION_FAILED' });
  assert.deepEqual(record.usage, {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0
  });
  assert.doesNotMatch(JSON.stringify(record), /private|server failed/);

  const path = await writeStage2bRecord(repositoryRoot, record);
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  assert.equal((await lstat(join(repositoryRoot, '.experiment-runs/stage-2b', record.runId))).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), record);
});

test('returns a safe configuration record when experiment setup fails', async t => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'stage2b-smoke-'));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));

  const record = await runStage2bSmoke({
    repositoryRoot,
    apiKey: 'offline-test-key',
    dependencies: {
      createModelClient: () => { throw new Error('must not be reached'); },
      connectTools: async () => { throw new Error('must not be reached'); }
    }
  });

  assert.equal(record.status, 'infrastructure-error');
  assert.equal(record.taskSuccess, null);
  assert.equal(record.turns, 0);
  assert.deepEqual(record.error, { category: 'configuration', code: 'SETUP_FAILED' });
  assert.doesNotMatch(JSON.stringify(record), /must not be reached/);
});

test('accepts one nested answer in a fenced provider wrapper', async t => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'stage2b-smoke-'));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  await cp(resolve('experiments'), join(repositoryRoot, 'experiments'), { recursive: true });
  const model = new T1FakeModel([
    'The result is:',
    '```json',
    '{"type":"response","name":"experiment_answer","metadata":{},"result":{"status":"completed","answer":3,"explanation":"Counted with jq.","tool":"jq_query"}}',
    '```',
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
    nestedAnswerCandidateCount: 0,
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
