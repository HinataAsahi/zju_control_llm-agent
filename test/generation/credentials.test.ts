import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadDeepSeekApiKey } from '../../src/generation/credentials.js';

test('prefers an environment key without reading local configuration', async () => {
  assert.equal(await loadDeepSeekApiKey({
    env: { DEEPSEEK_API_KEY: ' environment-key ' },
    configPath: '/missing/key'
  }), 'environment-key');
});

test('loads a private regular key file outside the repository', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'generation-key-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'deepseek.key');
  await writeFile(path, 'local-key\n', { mode: 0o600 });

  assert.equal(await loadDeepSeekApiKey({ env: {}, configPath: path }), 'local-key');
});

test('rejects permissive key-file permissions', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'generation-key-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'deepseek.key');
  await writeFile(path, 'local-key\n', { mode: 0o600 });
  await chmod(path, 0o644);

  await assert.rejects(
    loadDeepSeekApiKey({ env: {}, configPath: path }),
    /DeepSeek API key file permissions must be 0600/
  );
});
