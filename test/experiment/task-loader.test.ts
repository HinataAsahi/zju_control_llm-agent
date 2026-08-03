import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { loadTasks } from '../../src/experiment/task-loader.js';

const validTask = {
  id: 'T1',
  kind: 'normal',
  prompt: 'Count the values.',
  inputFiles: ['fixtures/users.json'],
  expected: { status: 'completed', answer: 3 }
};

async function setupExperiment(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'stage-2a-tasks-'));
  await mkdir(join(root, 'tasks', 'fixtures'), { recursive: true });
  await writeFile(join(root, 'tasks', 'fixtures', 'users.json'), '{}\n');
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function writeTask(root: string, filename: string, task: unknown = validTask): Promise<void> {
  await writeFile(join(root, 'tasks', filename), JSON.stringify(task));
}

test('loads all stage 2A tasks in numeric ID order with known expected answers', async () => {
  const tasks = await loadTasks(resolve('experiments/stage-2a'));

  assert.deepEqual(tasks.map(task => task.id), ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8']);
  assert.deepEqual(tasks.find(task => task.id === 'T4')?.expected.answer, { east: 220, west: 330 });
  assert.deepEqual(tasks.find(task => task.id === 'T6')?.expected, { status: 'cannot_complete', answer: null });
});

test('rejects task fixture paths that are not normalized relative paths below tasks/fixtures', async (t) => {
  const root = await setupExperiment(t);
  await writeTask(root, 'T1.json', { ...validTask, inputFiles: ['fixtures/../users.json'] });

  await assert.rejects(loadTasks(root), Error);
});

test('rejects task fixture paths that traverse outside tasks/fixtures', async (t) => {
  const root = await setupExperiment(t);
  await writeTask(root, 'T1.json', { ...validTask, inputFiles: ['fixtures/../../outside.json'] });

  await assert.rejects(loadTasks(root), Error);
});

test('rejects tasks that reference a missing fixture', async (t) => {
  const root = await setupExperiment(t);
  await writeTask(root, 'T1.json', { ...validTask, inputFiles: ['fixtures/missing.json'] });

  await assert.rejects(loadTasks(root), Error);
});

test('rejects malformed expected answers', async (t) => {
  const root = await setupExperiment(t);
  await writeTask(root, 'T1.json', { ...validTask, expected: { status: 'completed' } as unknown });

  await assert.rejects(loadTasks(root), Error);
});

test('rejects duplicate task IDs', async (t) => {
  const root = await setupExperiment(t);
  await writeTask(root, 'T1.json');
  await writeTask(root, 'T2.json', { ...validTask, id: 'T1' });

  await assert.rejects(loadTasks(root), Error);
});
