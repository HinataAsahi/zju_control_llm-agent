import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AppConfig } from '../src/config.js';
import { createJqToolHandler } from '../src/jq-tool.js';

const limits = { inputLimitBytes: 1024, outputLimitBytes: 1024, timeoutMs: 5000 };

async function setup(t: test.TestContext): Promise<{ root: string; config: AppConfig }> {
  const root = await mkdtemp(join(tmpdir(), 'jq-tool-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, config: { root, jqExecutable: 'jq', limits } };
}

test('returns structured jq results for inline input', async (t) => {
  const { config } = await setup(t);
  const handler = createJqToolHandler(config);

  const result = await handler({
    filter: '.users | length',
    source: { type: 'inline', data: { users: ['Alice', 'Bob'] } }
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, { ok: true, values: [2], exitCode: 0 });
  assert.equal(result.content[0]?.text, JSON.stringify(result.structuredContent));
});

test('returns structured jq results for file input', async (t) => {
  const { root, config } = await setup(t);
  await writeFile(join(root, 'users.json'), '{"users":["Alice"]}\n');
  const handler = createJqToolHandler(config);

  const result = await handler({
    filter: '.users[0]',
    source: { type: 'file', path: 'users.json' }
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, { ok: true, values: ['Alice'], exitCode: 0 });
});

test('returns a safe structured path error for traversal', async (t) => {
  const { root, config } = await setup(t);
  const handler = createJqToolHandler(config);

  const result = await handler({
    filter: '.',
    source: { type: 'file', path: '../outside.json' }
  });

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.ok, false);
  if (result.structuredContent.ok) return;
  assert.equal(result.structuredContent.error.code, 'PATH_NOT_ALLOWED');
  assert.equal(JSON.stringify(result).includes(root), false);
});

test('returns a structured jq syntax error', async (t) => {
  const { root, config } = await setup(t);
  const handler = createJqToolHandler(config);

  const result = await handler({
    filter: 'if',
    source: { type: 'inline', data: null }
  });

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.ok, false);
  if (result.structuredContent.ok) return;
  assert.equal(result.structuredContent.error.code, 'JQ_SYNTAX_ERROR');
  assert.equal(JSON.stringify(result).includes(root), false);
});

test('redacts unknown dependency errors', async (t) => {
  const { config } = await setup(t);
  const handler = createJqToolHandler(config, {
    resolveSource: async () => { throw new Error('secret detail'); },
    executeJq: async () => ({ ok: true, values: [], exitCode: 0 })
  });

  const result = await handler({
    filter: '.',
    source: { type: 'inline', data: null }
  });

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.ok, false);
  assert.deepEqual(result.structuredContent, {
    ok: false,
    error: { code: 'INTERNAL_ERROR', message: 'Internal jq tool error' },
    exitCode: null
  });
  assert.equal(JSON.stringify(result).includes('secret detail'), false);
});
