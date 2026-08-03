import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import test from 'node:test';
import type { ExperimentTask } from '../../src/experiment/schema.js';
import { loadTasks } from '../../src/experiment/task-loader.js';
import { prepareWorkspace } from '../../src/experiment/workspace.js';

const experimentRoot = resolve('experiments/stage-2a');

async function setup(t: test.TestContext): Promise<string> {
  const runRoot = await mkdtemp(join(tmpdir(), 'stage-2a-workspaces-'));
  t.after(() => rm(runRoot, { recursive: true, force: true }));
  return runRoot;
}

const directTask: ExperimentTask = {
  id: 'T2',
  kind: 'normal',
  prompt: 'Read users.json.',
  inputFiles: ['fixtures/users.json'],
  expected: { status: 'completed', answer: null }
};

async function setupMutableExperiment(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'stage-2a-experiment-'));
  await Promise.all([
    mkdir(join(root, 'tasks', 'fixtures'), { recursive: true }),
    mkdir(join(root, 'prompts'), { recursive: true }),
    mkdir(join(root, 'reference-skill'), { recursive: true }),
    mkdir(join(root, 'schemas'), { recursive: true })
  ]);
  await Promise.all([
    writeFile(join(root, 'tasks', 'fixtures', 'users.json'), '{"users":[]}\n'),
    writeFile(join(root, 'prompts', 'common.txt'), 'Common prompt.\n'),
    writeFile(join(root, 'prompts', 'explicit-applicable.txt'), 'Use jq_query.\n'),
    writeFile(join(root, 'prompts', 'explicit-negative.txt'), 'Do not use jq_query.\n'),
    writeFile(join(root, 'reference-skill', 'SKILL.md'), '# Skill\n'),
    writeFile(join(root, 'schemas', 'final-answer.schema.json'), '{}\n')
  ]);
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function createSymlinkOrSkip(t: test.TestContext, target: string, path: string, type?: 'file' | 'dir'): Promise<boolean> {
  try {
    await symlink(target, path, type);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS' || code === 'ENOTSUP' || code === 'EOPNOTSUPP') {
      t.skip(`symlink creation is unsupported: ${code}`);
      return false;
    }
    throw error;
  }
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

test('refuses to replace an existing final workspace', async t => {
  const runRoot = await setup(t);
  const task = (await loadTasks(experimentRoot)).find(candidate => candidate.id === 'T1');
  assert.ok(task);
  const options = { task, condition: 'description' as const, experimentRoot, runRoot, runId: 'collision' };

  const first = await prepareWorkspace(options);
  await assert.rejects(prepareWorkspace(options), { code: 'EEXIST' });
  assert.equal(await readFile(first.outputSchemaPath, 'utf8'), await readFile(join(experimentRoot, 'schemas/final-answer.schema.json'), 'utf8'));
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

test('rejects a symlinked workspaces parent without writing through it', async t => {
  const runRoot = await setup(t);
  const escapedDirectory = join(runRoot, 'escaped');
  await mkdir(escapedDirectory);
  if (!await createSymlinkOrSkip(t, escapedDirectory, join(runRoot, 'workspaces'), 'dir')) return;

  await assert.rejects(
    prepareWorkspace({ task: directTask, condition: 'description', experimentRoot, runRoot, runId: 'symlink-parent' })
  );
  await assert.rejects(stat(join(escapedDirectory, 'symlink-parent')));
});

test('rejects a non-directory workspaces parent', async t => {
  const runRoot = await setup(t);
  await writeFile(join(runRoot, 'workspaces'), 'not a directory');

  await assert.rejects(
    prepareWorkspace({ task: directTask, condition: 'description', experimentRoot, runRoot, runId: 'file-parent' })
  );
});

test('rejects symlinked source assets instead of dereferencing them', async t => {
  const cases = [
    { name: 'fixture', path: 'tasks/fixtures/users.json', condition: 'description' as const },
    { name: 'prompt', path: 'prompts/common.txt', condition: 'description' as const },
    { name: 'schema', path: 'schemas/final-answer.schema.json', condition: 'description' as const },
    { name: 'skill', path: 'reference-skill/SKILL.md', condition: 'skill' as const }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async t => {
      const runRoot = await setup(t);
      const mutableExperimentRoot = await setupMutableExperiment(t);
      const sourcePath = join(mutableExperimentRoot, ...testCase.path.split('/'));
      const realPath = `${sourcePath}.real`;
      await rename(sourcePath, realPath);
      if (!await createSymlinkOrSkip(t, basename(realPath), sourcePath, 'file')) return;

      await assert.rejects(
        prepareWorkspace({
          task: directTask,
          condition: testCase.condition,
          experimentRoot: mutableExperimentRoot,
          runRoot,
          runId: `symlink-${testCase.name}`
        })
      );
      assert.deepEqual(await readdir(join(runRoot, 'workspaces')), []);
    });
  }
});

test('cleans failed temporary workspaces so the same run ID can be retried', async t => {
  const runRoot = await setup(t);
  const mutableExperimentRoot = await setupMutableExperiment(t);
  const schemaPath = join(mutableExperimentRoot, 'schemas', 'final-answer.schema.json');
  const unavailableSchemaPath = `${schemaPath}.unavailable`;
  await rename(schemaPath, unavailableSchemaPath);

  const options = {
    task: directTask,
    condition: 'description' as const,
    experimentRoot: mutableExperimentRoot,
    runRoot,
    runId: 'retryable'
  };
  await assert.rejects(prepareWorkspace(options));
  assert.deepEqual(await readdir(join(runRoot, 'workspaces')), []);

  await rename(unavailableSchemaPath, schemaPath);
  const prepared = await prepareWorkspace(options);
  assert.equal(prepared.path, join(runRoot, 'workspaces', 'retryable'));
  assert.equal(await readFile(prepared.outputSchemaPath, 'utf8'), '{}\n');
});
