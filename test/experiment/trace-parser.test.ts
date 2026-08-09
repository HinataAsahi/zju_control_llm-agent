import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { parseTrace } from '../../src/experiment/trace-parser.js';

const fixtures = resolve('test/fixtures/codex');

test('parses a successful MCP trace and token usage', async () => {
  const trace = await parseTrace(join(fixtures, 'success.jsonl'));

  assert.equal(trace.terminalStatus, 'completed');
  assert.deepEqual(trace.usage, {
    inputTokens: 120,
    cachedInputTokens: 20,
    outputTokens: 30,
    reasoningOutputTokens: 5
  });
  assert.deepEqual(trace.mcpCalls, [{
    server: 'jq_mcp_server',
    tool: 'jq_query',
    arguments: {
      filter: '.users | length',
      source: { type: 'file', path: 'fixtures/users.json' }
    },
    result: { ok: true, values: [4], exitCode: 0 },
    status: 'completed'
  }]);
  assert.deepEqual(trace.finalAnswer, {
    status: 'completed',
    answer: 4,
    explanation: 'Counted the users.'
  });
  assert.deepEqual(trace.parseErrors, []);
  assert.equal(trace.needsReview, false);
});

test('preserves failed and successful MCP calls and sums completed-turn usage', async () => {
  const trace = await parseTrace(join(fixtures, 'recovery.jsonl'));

  assert.equal(trace.terminalStatus, 'completed');
  assert.equal(trace.mcpCalls.length, 2);
  assert.deepEqual(trace.mcpCalls[0]?.error, { code: 'JQ_SYNTAX_ERROR' });
  assert.deepEqual(trace.mcpCalls[1]?.result, { ok: true, values: [3], exitCode: 0 });
  assert.deepEqual(trace.usage, {
    inputTokens: 210,
    cachedInputTokens: 55,
    outputTokens: 44,
    reasoningOutputTokens: 9
  });
  assert.equal(trace.finalAnswer?.explanation, 'Final checked answer.');
  assert.equal(trace.needsReview, false);
});

test('treats a completed real-shape MCP item with error null as successful', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'trace-parser-'));
  const path = join(directory, 'real-mcp.jsonl');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path, [
    '{"type":"turn.started"}',
    '{"type":"item.started","item":{"id":"mcp","type":"mcp_tool_call","server":"jq_mcp_server","tool":"jq_query","arguments":{"filter":"."},"result":null,"error":null,"status":"in_progress"}}',
    '{"type":"item.completed","item":{"id":"mcp","type":"mcp_tool_call","server":"jq_mcp_server","tool":"jq_query","arguments":{"filter":"."},"result":{"content":[],"structured_content":{"ok":true,"values":[3],"exitCode":0}},"error":null,"status":"completed"}}',
    '{"type":"item.completed","item":{"id":"answer","type":"agent_message","text":"{\"status\":\"completed\",\"answer\":3,\"explanation\":\"done\"}"}}',
    '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}'
  ].join('\n'));

  const parsed = await parseTrace(path);
  assert.equal(parsed.mcpCalls.length, 1);
  assert.equal(parsed.mcpCalls[0]?.status, 'completed');
  assert.equal('error' in parsed.mcpCalls[0]!, false);
});

test('records each command once and selects the last valid agent answer', async () => {
  const trace = await parseTrace(join(fixtures, 'shell.jsonl'));

  assert.deepEqual(trace.commandExecutions, ["jq '.users | length' fixtures/users.json"]);
  assert.deepEqual(trace.finalAnswer, {
    status: 'completed',
    answer: 4,
    explanation: 'Used a command.'
  });
  assert.equal(trace.usage.reasoningOutputTokens, 0);
  assert.deepEqual(trace.parseErrors, []);
});

test('retains partial observations while flagging malformed, unknown, and incomplete traces', async () => {
  const trace = await parseTrace(join(fixtures, 'truncated.jsonl'));

  assert.equal(trace.terminalStatus, 'incomplete');
  assert.deepEqual(trace.unknownEventTypes, ['item:future_item', 'future.event']);
  assert.equal(trace.parseErrors.length, 2);
  assert.match(trace.parseErrors[0] ?? '', /agent answer/);
  assert.match(trace.parseErrors[1] ?? '', /line 6/);
  assert.equal(trace.finalAnswer, undefined);
  assert.equal(trace.needsReview, true);
});

test('recognizes documented non-scoring item types without requiring review', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'trace-parser-'));
  const path = join(directory, 'known-items.jsonl');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path, [
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"r","type":"reasoning","text":"summary"}}',
    '{"type":"item.completed","item":{"id":"f","type":"file_change","changes":[]}}',
    '{"type":"item.completed","item":{"id":"w","type":"web_search","query":"q"}}',
    '{"type":"item.completed","item":{"id":"p","type":"plan_update","plan":[]}}',
    '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}'
  ].join('\n'));

  const trace = await parseTrace(path);
  assert.deepEqual(trace.unknownEventTypes, []);
  assert.equal(trace.needsReview, false);
});

test('classifies turn.failed and error events as failed without discarding observations', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'trace-parser-'));
  const path = join(directory, 'failed.jsonl');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path, [
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"mcp","type":"mcp_tool_call","tool":"jq_query","arguments":{},"status":"failed","error":{"code":"INTERNAL_ERROR"}}}',
    '{"type":"error","message":"transport interrupted"}',
    '{"type":"turn.failed","error":{"message":"failed"}}'
  ].join('\n'));

  const trace = await parseTrace(path);
  assert.equal(trace.terminalStatus, 'failed');
  assert.equal(trace.mcpCalls.length, 1);
  assert.equal(trace.needsReview, true);
});

test('ignores blank lines and rejects unsafe numeric usage fields for review', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'trace-parser-'));
  const path = join(directory, 'usage.jsonl');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path, [
    '',
    '{"type":"turn.started"}',
    '{"type":"turn.completed","usage":{"input_tokens":-1,"cached_input_tokens":"5","output_tokens":null}}',
    ''
  ].join('\n'));

  const trace = await parseTrace(path);
  assert.deepEqual(trace.usage, {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0
  });
  assert.equal(trace.terminalStatus, 'completed');
  assert.equal(trace.needsReview, true);
  assert.match(trace.parseErrors[0] ?? '', /usage/);
});
