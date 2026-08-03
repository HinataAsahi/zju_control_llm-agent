import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { loadTasks } from '../../src/experiment/task-loader.js';
import { prepareWorkspace } from '../../src/experiment/workspace.js';

const experimentRoot = resolve('experiments/stage-2a');

async function setup(t: test.TestContext): Promise<string> {
  const runRoot = await mkdtemp(join(tmpdir(), 'stage-2a-workspaces-'));
  t.after(() => rm(runRoot, { recursive: true, force: true }));
  return runRoot;
}

test('prepares distinct 0700 workspaces with only the task fixtures and an isolated schema', async t => {
  const runRoot = await setup(t);
  const tasks = await loadTasks(experimentRoot);
  const task = tasks.find(candidate => candidate.id === 'T2');
  assert.ok(task);

  const first = await prepareWorkspace({ task, condition: 'explicit', experimentRoot, runRoot, runId: 'run-one' });
  const second = await prepareWorkspace({ task, condition: 'explicit', experimentRoot, runRoot, runId: 'run-two' });

  assert.notEqual(first.path, second.path);
  assert.equal((await stat(first.path)).mode & 0o777, 0o700);
  assert.deepEqual((await readdir(first.path)).sort(), ['fixtures', 'final-answer.schema.json'].sort());
  assert.deepEqual((await readdir(join(first.path, 'fixtures'))).sort(), ['users.json']);
  assert.equal(await readFile(join(first.path, 'fixtures/users.json'), 'utf8'), await readFile(join(experimentRoot, 'tasks/fixtures/users.json'), 'utf8'));
  assert.equal(await readFile(first.outputSchemaPath, 'utf8'), await readFile(join(experimentRoot, 'schemas/final-answer.schema.json'), 'utf8'));
  assert.equal(first.outputSchemaPath, join(first.path, 'final-answer.schema.json'));
  await assert.rejects(readFile(join(first.path, 'fixtures/orders.json')));
});

test('isolates the reference skill to the skill condition', async t => {
  const runRoot = await setup(t);
  const task = (await loadTasks(experimentRoot)).find(candidate => candidate.id === 'T2');
  assert.ok(task);

  const explicit = await prepareWorkspace({ task, condition: 'explicit', experimentRoot, runRoot, runId: 'explicit' });
  const description = await prepareWorkspace({ task, condition: 'description', experimentRoot, runRoot, runId: 'description' });
  const skill = await prepareWorkspace({ task, condition: 'skill', experimentRoot, runRoot, runId: 'skill' });

  assert.equal(description.prompt, skill.prompt);
  assert.doesNotMatch(description.prompt, /skill|tool/i);
  assert.match(explicit.prompt, /jq_query/);
  assert.equal(await readFile(join(skill.path, '.agents/skills/jq-query/SKILL.md'), 'utf8'), await readFile(join(experimentRoot, 'reference-skill/SKILL.md'), 'utf8'));
  await assert.rejects(stat(join(explicit.path, '.agents')));
  await assert.rejects(stat(join(description.path, '.agents')));
});

test('adds the applicable explicit prompt for T1-T7 and the negative prompt for T8', async t => {
  const runRoot = await setup(t);
  const tasks = await loadTasks(experimentRoot);
  const common = await readFile(join(experimentRoot, 'prompts/common.txt'), 'utf8');
  const applicable = await readFile(join(experimentRoot, 'prompts/explicit-applicable.txt'), 'utf8');
  const negative = await readFile(join(experimentRoot, 'prompts/explicit-negative.txt'), 'utf8');

  for (const id of ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'] as const) {
    const task = tasks.find(candidate => candidate.id === id);
    assert.ok(task);
    const prepared = await prepareWorkspace({ task, condition: 'explicit', experimentRoot, runRoot, runId: `explicit-${id}` });
    assert.equal(prepared.prompt, [common, applicable, task.prompt].map(part => part.replace(/\r\n?/g, '\n').replace(/\n+$/g, '')).join('\n'));
  }

  const task = tasks.find(candidate => candidate.id === 'T8');
  assert.ok(task);
  const prepared = await prepareWorkspace({ task, condition: 'explicit', experimentRoot, runRoot, runId: 'explicit-T8' });
  assert.equal(prepared.prompt, [common, negative, task.prompt].map(part => part.replace(/\r\n?/g, '\n').replace(/\n+$/g, '')).join('\n'));
});

test('rejects unsafe run IDs', async t => {
  const runRoot = await setup(t);
  const task = (await loadTasks(experimentRoot)).find(candidate => candidate.id === 'T1');
  assert.ok(task);

  for (const runId of ['', '.', '..', '../escape', 'nested/run', 'nested\\run', '/absolute']) {
    await assert.rejects(
      prepareWorkspace({ task, condition: 'description', experimentRoot, runRoot, runId }),
      /unsafe run ID/
    );
  }
});
