import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AppConfig } from '../src/config.js';
import { JqToolError } from '../src/jq-schema.js';
import { resolveSource } from '../src/source-resolver.js';

const limits = { inputLimitBytes: 1024, outputLimitBytes: 1024, timeoutMs: 5000 };

async function setup(t: test.TestContext): Promise<{ root: string; outside: string; config: AppConfig }> {
  const directory = await mkdtemp(join(tmpdir(), 'jq-source-'));
  const root = join(directory, 'root');
  const outside = join(directory, 'outside.json');
  await mkdir(root);
  await writeFile(outside, '{"outside":true}\n');
  await writeFile(join(root, 'users.json'), '{"users":["Alice"]}\n');
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { root, outside, config: { root, jqExecutable: 'jq', limits } };
}

function expectsCode(code: JqToolError['code']): (error: unknown) => boolean {
  return (error: unknown) => error instanceof JqToolError && error.code === code;
}

test('resolves inline JSON and files below the root', async (t) => {
  const { config } = await setup(t);

  assert.equal(await resolveSource(
    { type: 'inline', data: { users: ['Alice'] } }, config
  ), '{"users":["Alice"]}');
  assert.equal(await resolveSource(
    { type: 'file', path: 'users.json' }, config
  ), '{"users":["Alice"]}\n');
});

test('rejects paths that escape the configured root', async (t) => {
  const { root, outside, config } = await setup(t);
  await symlink(outside, join(root, 'outside-link.json'));
  await writeFile(join(root, 'directory'), '');

  await assert.rejects(resolveSource({ type: 'file', path: '../outside.json' }, config), expectsCode('PATH_NOT_ALLOWED'));
  await assert.rejects(resolveSource({ type: 'file', path: outside }, config), expectsCode('PATH_NOT_ALLOWED'));
  await assert.rejects(resolveSource({ type: 'file', path: 'outside-link.json' }, config), expectsCode('PATH_NOT_ALLOWED'));
});

test('maps missing files and non-file sources to safe errors', async (t) => {
  const { root, config } = await setup(t);
  const directory = join(root, 'directory');
  await mkdir(directory);

  await assert.rejects(resolveSource({ type: 'file', path: 'missing.json' }, config), expectsCode('FILE_NOT_FOUND'));
  await assert.rejects(resolveSource({ type: 'file', path: 'directory' }, config), expectsCode('PATH_NOT_ALLOWED'));
});

test('enforces input byte limits for inline and file input', async (t) => {
  const { root, config } = await setup(t);
  const limitedConfig = { ...config, limits: { ...config.limits, inputLimitBytes: 10 } };
  await writeFile(join(root, 'large.json'), '12345678901');

  await assert.rejects(
    resolveSource({ type: 'inline', data: { value: '12345' } }, limitedConfig),
    expectsCode('INPUT_TOO_LARGE')
  );
  await assert.rejects(resolveSource({ type: 'file', path: 'large.json' }, limitedConfig), expectsCode('INPUT_TOO_LARGE'));
});
