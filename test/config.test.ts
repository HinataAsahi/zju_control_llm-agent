import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_LIMITS, loadConfig } from '../src/config.js';

test('loads a canonical directory root with default settings', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'jq-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const config = await loadConfig(['--root', root]);

  assert.equal(config.root, await realpath(root));
  assert.equal(config.jqExecutable, 'jq');
  assert.deepEqual(config.limits, DEFAULT_LIMITS);
});

test('rejects missing, unknown, and empty configuration arguments', async () => {
  await assert.rejects(loadConfig([]), Error);
  await assert.rejects(loadConfig(['--other', 'value']), Error);
  await assert.rejects(loadConfig(['--root', '']), Error);
  await assert.rejects(loadConfig(['--root']), Error);
  await assert.rejects(loadConfig(['--root', '.', '--root', '.']), Error);
});

test('rejects a root that is a file', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'jq-config-'));
  const file = join(directory, 'root-file');
  await writeFile(file, 'not a directory');
  t.after(() => rm(directory, { recursive: true, force: true }));

  await assert.rejects(loadConfig(['--root', file]), Error);
});
