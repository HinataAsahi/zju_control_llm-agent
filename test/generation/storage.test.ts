import assert from 'node:assert/strict';
import { lstat, mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  readGenerationJson,
  writeGenerationJson,
  writeGenerationText
} from '../../src/generation/storage.js';

async function repository(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'generation-storage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('atomically writes private generation artifacts with restrictive permissions', async (t) => {
  const root = await repository(t);
  const jsonPath = await writeGenerationJson(root, 'ir.json', { schemaVersion: 1, value: 'ok' });
  const reportPath = await writeGenerationText(root, 'review.md', '# Review\n');

  assert.deepEqual(await readGenerationJson(root, 'ir.json'), { schemaVersion: 1, value: 'ok' });
  assert.equal(await readFile(reportPath, 'utf8'), '# Review\n');
  assert.equal((await lstat(jsonPath)).mode & 0o777, 0o600);
  assert.equal((await lstat(join(root, '.generation-runs', 'stage-3', 'jq'))).mode & 0o777, 0o700);
});

test('rejects unknown artifact names and symlinked storage directories', async (t) => {
  const root = await repository(t);
  await assert.rejects(writeGenerationJson(root, '../outside.json', {}), /Unsafe generation artifact name/);

  const outside = join(root, 'outside');
  await mkdir(outside);
  await symlink(outside, join(root, '.generation-runs'));
  await assert.rejects(writeGenerationJson(root, 'ir.json', {}), /Unsafe generation storage directory/);
});
