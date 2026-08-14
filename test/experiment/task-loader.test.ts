import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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

test('loads isolated Stage 2B diagnostic tasks without changing Stage 2A', async () => {
  const stage2a = await loadTasks(resolve('experiments/stage-2a'));
  const stage2b = await loadTasks(resolve('experiments/stage-2b'));

  assert.deepEqual(stage2a.map(task => task.id), ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8']);
  assert.deepEqual(stage2b.map(task => task.id), [
    'T9', 'T10', 'T11', 'T12', 'T13', 'T14', 'T15', 'T16', 'T17',
    'T18', 'T19', 'T20', 'T21', 'T22', 'T23'
  ]);
  assert.equal(stage2b[0]?.kind, 'negative');
  assert.equal(stage2b[0]?.expected.answer, 2);
  assert.deepEqual(stage2b[1]?.expected.answer, [
    { region: 'east', revenue: 245 },
    { region: 'north', revenue: 180 }
  ]);
  assert.deepEqual(stage2b[2]?.expected.answer, ['api', 'search']);
  assert.deepEqual(
    stage2b.slice(3, 9).map(task => ({ id: task.id, kind: task.kind, answer: task.expected.answer })),
    [
      { id: 'T12', kind: 'negative', answer: 3 },
      { id: 'T13', kind: 'normal', answer: 3 },
      { id: 'T14', kind: 'negative', answer: ['n2', 'n4'] },
      { id: 'T15', kind: 'normal', answer: ['n2', 'n4'] },
      { id: 'T16', kind: 'negative', answer: { east: 125, west: 145 } },
      { id: 'T17', kind: 'normal', answer: { east: 125, west: 145 } }
    ]
  );
  for (let index = 3; index < stage2b.length; index += 2) {
    if (index >= 9) break;
    const negative = stage2b[index];
    const positive = stage2b[index + 1];
    assert.ok(negative);
    assert.ok(positive);
    assert.deepEqual(negative.expected, positive.expected);
    assert.deepEqual(negative.inputFiles, []);
    assert.deepEqual(positive.inputFiles, []);
  }
  assert.deepEqual(
    stage2b.slice(9).map(task => ({ id: task.id, kind: task.kind, answer: task.expected.answer })),
    [
      { id: 'T18', kind: 'normal', answer: 4 },
      { id: 'T19', kind: 'normal', answer: 13 },
      { id: 'T20', kind: 'normal', answer: ['t01', 't06'] },
      { id: 'T21', kind: 'normal', answer: ['t01', 't06', 't07', 't12', 't16', 't22'] },
      { id: 'T22', kind: 'normal', answer: { east: 250, west: 230 } },
      { id: 'T23', kind: 'normal', answer: { east: 962, west: 897 } }
    ]
  );
  for (const task of stage2b.slice(9)) {
    assert.deepEqual(task.inputFiles, []);
    assert.match(task.prompt, /JSON object/);
  }
});

test('pairs each complexity operation across nested 6-row and 24-row datasets', async () => {
  const tasks = await loadTasks(resolve('experiments/stage-2b'));
  const byId = new Map(tasks.map(task => [task.id, task]));
  type Transaction = { id: string; region: 'east' | 'west'; status: string; amount: number };
  type Input = { transactions: Transaction[] };
  const cases = [
    ['T18', 'T19', (input: Input) => input.transactions.filter(row => row.status === 'ready').length],
    ['T20', 'T21', (input: Input) => input.transactions
      .filter(row => row.region === 'east' && row.status === 'ready' && row.amount >= 80)
      .map(row => row.id)
      .sort()],
    ['T22', 'T23', (input: Input) => input.transactions
      .filter(row => row.status !== 'void')
      .reduce<Record<string, number>>((totals, row) => ({
        ...totals,
        [row.region]: (totals[row.region] ?? 0) + row.amount
      }), {})]
  ] as const;

  for (const [smallId, mediumId, calculate] of cases) {
    const small = byId.get(smallId);
    const medium = byId.get(mediumId);
    assert.ok(small);
    assert.ok(medium);

    const smallInput = JSON.parse(small.prompt.split('\n\n').at(-1) ?? '') as Input;
    const mediumInput = JSON.parse(medium.prompt.split('\n\n').at(-1) ?? '') as Input;
    assert.equal(smallInput.transactions.length, 6);
    assert.equal(mediumInput.transactions.length, 24);
    assert.deepEqual(mediumInput.transactions.slice(0, 6), smallInput.transactions);
    assert.deepEqual(calculate(smallInput), small.expected.answer);
    assert.deepEqual(calculate(mediumInput), medium.expected.answer);
  }
});

test('defines condition-neutral and explicit prompt assets without disclosing a skill', async () => {
  const promptDirectory = resolve('experiments/stage-2a/prompts');
  const filenames = (await readdir(promptDirectory)).sort();
  assert.deepEqual(filenames, ['common.txt', 'explicit-applicable.txt', 'explicit-negative.txt']);

  const prompts = await Promise.all(filenames.map(filename => readFile(join(promptDirectory, filename), 'utf8')));
  const common = prompts[0];
  assert.doesNotMatch(common ?? '', /jq_query|\btool\b|\bskill\b/i);
  for (const prompt of prompts) assert.doesNotMatch(prompt, /\bskill\b/i);
});

test('defines the exact deterministic recovery prompt for T7', async () => {
  const tasks = await loadTasks(resolve('experiments/stage-2a'));

  assert.equal(
    tasks.find(task => task.id === 'T7')?.prompt,
    'Using users.json, first call jq_query with the filter exactly `if`, then correct the call and return the count of active users.'
  );
});

test('provides a valid generic jq-query skill without experiment task IDs', async () => {
  const skill = await readFile(resolve('experiments/stage-2a/reference-skill/SKILL.md'), 'utf8');

  assert.match(skill, /^---\nname: jq-query\ndescription: Use when [^\n]+\n---\n/);
  assert.match(skill, /## When to Use/);
  assert.match(skill, /## When Not to Use/);
  for (const code of [
    'PATH_NOT_ALLOWED', 'FILE_NOT_FOUND', 'INPUT_TOO_LARGE', 'JQ_SYNTAX_ERROR',
    'JQ_RUNTIME_ERROR', 'TIMEOUT', 'OUTPUT_LIMIT', 'INTERNAL_ERROR'
  ]) {
    assert.match(skill, new RegExp(`\\b${code}\\b`));
  }
  assert.doesNotMatch(skill, /\bT[1-8]\b/);
});

test('freezes Stage 2B skill v1 and defines a compact boundary-gated v2', async () => {
  const current = await readFile(resolve('experiments/stage-2a/reference-skill/SKILL.md'), 'utf8');
  const v1 = await readFile(resolve('experiments/stage-2b/skills/jq-query-v1/SKILL.md'), 'utf8');
  const v2 = await readFile(resolve('experiments/stage-2b/skills/jq-query-v2/SKILL.md'), 'utf8');

  assert.equal(v1, current);
  assert.match(v2, /Source gate/);
  assert.match(v2, /Task gate/);
  assert.match(v2, /Availability gate/);
  assert.match(v2, /all three gates pass/i);
  assert.match(v2, /Do not convert.*non-JSON.*JSON/i);
  assert.match(v2, /known.*one target query/i);
  assert.match(v2, /unknown.*inspect/i);
  assert.match(v2, /Do not repeat.*failed call/i);
  assert.doesNotMatch(v2, /\bT(?:9|1[0-7])\b/);
});

test('uses explicit structured-output types for every supported answer shape', async () => {
  const schema = JSON.parse(
    await readFile(resolve('experiments/stage-2a/schemas/final-answer.schema.json'), 'utf8')
  ) as {
    properties: {
      answer: {
        anyOf: Array<{ type: string; additionalProperties?: boolean; required?: string[] }>;
      };
    };
  };

  assert.deepEqual(schema.properties.answer.anyOf.map(branch => branch.type), [
    'integer', 'array', 'object', 'object', 'null'
  ]);
  for (const branch of schema.properties.answer.anyOf.filter(branch => branch.type === 'object')) {
    assert.equal(branch.additionalProperties, false);
    assert.ok((branch.required?.length ?? 0) > 0);
  }
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

test('rejects duplicate fixture references within a task', async (t) => {
  const root = await setupExperiment(t);
  await writeTask(root, 'T1.json', {
    ...validTask,
    inputFiles: ['fixtures/users.json', 'fixtures/users.json']
  });

  await assert.rejects(loadTasks(root), Error);
});
