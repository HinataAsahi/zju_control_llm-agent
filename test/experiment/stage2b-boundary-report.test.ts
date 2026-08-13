import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Stage2bBatchManifest } from '../../src/experiment/stage2b-batch.js';
import {
  renderStage2bBoundaryMarkdown,
  summarizeStage2bBoundaryBatch,
  summarizeStage2bBoundaryBatches,
  writeStage2bBoundaryReport
} from '../../src/experiment/stage2b-boundary-report.js';
import type { Stage2bRecord, Stage2bToolEvent } from '../../src/experiment/stage2b-record.js';
import { expandStage2bSuite } from '../../src/experiment/stage2b-suite.js';
import { main, parseStage2bArgs } from '../../src/experiment/stage2b.js';

const v1 = { version: 'v1' as const, sha256: '1'.repeat(64) };
const v2 = { version: 'v2' as const, sha256: '2'.repeat(64) };

function fixture(
  repetitions = 1,
  batchId = 'stage2b-batch-boundary-fixture'
): { manifest: Stage2bBatchManifest; records: Stage2bRecord[] } {
  const planned = expandStage2bSuite('boundary-v1', repetitions);
  const records = planned.map((run, index): Stage2bRecord => {
    const required = ['T13', 'T15', 'T17'].includes(run.taskId);
    const compliantNegative = run.condition === 'skill-v2';
    const toolEvents = required || !compliantNegative ? successfulToolEvents(`call-${index}`) : [];
    return {
      version: 2,
      runId: `stage2b-${run.taskId}-${run.condition}-${batchId}-${index}`,
      startedAt: '2026-08-13T10:00:00.000Z',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      thinking: 'none',
      sampling: { temperature: 0 },
      taskId: run.taskId,
      condition: run.condition,
      skill: run.condition === 'skill-v1' ? v1 : run.condition === 'skill-v2' ? v2 : null,
      status: 'completed',
      taskSuccess: true,
      recoverySuccess: null,
      limits: {
        maxTurns: 6,
        maxToolCalls: 5,
        requestTimeoutMs: 60_000,
        totalTimeoutMs: 120_000
      },
      turns: toolEvents.length === 0 ? 1 : 2,
      toolCalls: toolEvents.length === 0 ? 0 : 1,
      toolEvents,
      usage: {
        inputTokens: 100,
        cachedInputTokens: 50,
        outputTokens: 20,
        reasoningOutputTokens: 0,
        totalTokens: 120
      },
      durationMs: 100
    };
  });
  const manifest: Stage2bBatchManifest = {
    version: 3,
    suite: 'boundary-v1',
    skills: { v1, v2 },
    batchId,
    createdAt: '2026-08-13T10:00:00.000Z',
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    thinking: 'none',
    sampling: { temperature: 0 },
    repetitions,
    totalRuns: planned.length,
    limits: {
      maxTurns: 6,
      maxToolCalls: 5,
      requestTimeoutMs: 60_000,
      totalTimeoutMs: 120_000
    },
    runs: planned.map((run, index) => ({
      runKey: `${run.taskId}-${run.condition}-r${run.repetition}`,
      ...run,
      status: 'completed',
      recordRunId: records[index]!.runId,
      recordStatus: 'completed',
      taskSuccess: true,
      recoverySuccess: null
    }))
  };
  return { manifest, records };
}

test('summarizes the strict first-batch gate without publishing private traces', () => {
  const report = summarizeStage2bBoundaryBatch(fixture());

  assert.equal(report.counts.total, 18);
  assert.equal(report.counts.taskSuccess, 18);
  assert.equal(report.counts.toolCompliance, 12);
  assert.deepEqual(report.initialGate, {
    passed: true,
    boundaryTaskSuccess: { passed: 6, total: 6 },
    boundaryNegativeCompliance: { passed: 3, total: 3 },
    boundaryPositiveCompliance: { passed: 3, total: 3 },
    skillV1NegativeCompliance: { passed: 0, total: 3 },
    descriptionNegativeCompliance: { passed: 0, total: 3 },
    reasons: []
  });
  assert.equal(report.cells.length, 18);
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /toolEvents|finalAnswer|runId|call-\d|"filter"|\.records/);

  const markdown = renderStage2bBoundaryMarkdown(report);
  assert.match(markdown, /首轮门控：通过/);
  assert.match(markdown, /Boundary Skill v2/);
  assert.match(markdown, /Skill v1/);
  assert.match(markdown, /Description/);
});

test('rejects record skill identities that differ from the prepared manifest', () => {
  const input = fixture();
  const index = input.records.findIndex(record => record.condition === 'skill-v2');
  assert.notEqual(index, -1);
  input.records[index] = {
    ...input.records[index]!,
    skill: { version: 'v2', sha256: 'f'.repeat(64) }
  };

  assert.throws(() => summarizeStage2bBoundaryBatch(input), /skill identity/i);
});

test('does not count a tool output observed before its JSON-positive call', () => {
  const input = fixture();
  const index = input.records.findIndex(record => record.taskId === 'T13' && record.condition === 'skill-v2');
  assert.notEqual(index, -1);
  input.records[index] = {
    ...input.records[index]!,
    toolEvents: [...input.records[index]!.toolEvents].reverse()
  };

  const report = summarizeStage2bBoundaryBatch(input);
  assert.equal(report.initialGate.passed, false);
  assert.deepEqual(report.initialGate.boundaryPositiveCompliance, { passed: 2, total: 3 });
});

test('combines one gated repetition with two confirmation repetitions', () => {
  const initial = fixture(1, 'stage2b-batch-boundary-initial');
  const repeat = fixture(2, 'stage2b-batch-boundary-repeat');

  const report = summarizeStage2bBoundaryBatches(initial, repeat);

  assert.equal(report.batchId, initial.manifest.batchId);
  assert.equal(report.repeatBatchId, repeat.manifest.batchId);
  assert.equal(report.repetitions, 3);
  assert.equal(report.runs.length, 54);
  assert.equal(report.cells.length, 18);
  assert.ok(report.cells.every(cell => cell.observations === 3));
  assert.equal(report.runs[17]?.repetition, 1);
  assert.equal(report.runs[18]?.repetition, 2);
  assert.equal(report.runs[35]?.repetition, 2);
  assert.equal(report.runs[36]?.repetition, 3);
  assert.equal(report.initialGate.passed, true);
});

test('loads private records and writes separate sanitized boundary artifacts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'stage2b-boundary-report-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = fixture();
  await persistFixture(root, input);

  const result = await writeStage2bBoundaryReport({
    repositoryRoot: root,
    batchId: input.manifest.batchId
  });

  assert.equal(result.report.initialGate.passed, true);
  assert.equal(
    result.jsonPath,
    join(root, 'experiments/stage-2b/results/boundary-v1/observations.json')
  );
  assert.equal(
    result.markdownPath,
    join(root, 'experiments/stage-2b/results/boundary-v1/report.zh.md')
  );
  const json = await readFile(result.jsonPath, 'utf8');
  const markdown = await readFile(result.markdownPath, 'utf8');
  assert.deepEqual(JSON.parse(json), result.report);
  assert.match(markdown, /首轮门控：通过/);
  assert.doesNotMatch(`${json}\n${markdown}`, /toolEvents|finalAnswer|"filter"|call-\d/);
});

test('routes the boundary report CLI without credentials or paid dependencies', async t => {
  const root = await mkdtemp(join(tmpdir(), 'stage2b-boundary-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = fixture();
  await persistFixture(root, input);
  assert.deepEqual(
    parseStage2bArgs(['report', '--boundary-batch', input.manifest.batchId]),
    { mode: 'report', kind: 'boundary', batchId: input.manifest.batchId }
  );
  let output = '';

  const exitCode = await main(['report', '--boundary-batch', input.manifest.batchId], {
    repositoryRoot: root,
    env: {},
    writeOutput: text => { output += text; },
    dependencies: {
      createModelClient: () => { throw new Error('report must not create a model client'); },
      connectTools: async () => { throw new Error('report must not connect MCP tools'); }
    }
  });

  assert.equal(exitCode, 0);
  const summary = JSON.parse(output) as { status: string; suite: string; repetitions: number };
  assert.deepEqual(summary, {
    status: 'reported',
    suite: 'boundary-v1',
    repetitions: 1,
    jsonPath: join(root, 'experiments/stage-2b/results/boundary-v1/observations.json'),
    markdownPath: join(root, 'experiments/stage-2b/results/boundary-v1/report.zh.md')
  });
});

function successfulToolEvents(callId: string): Stage2bToolEvent[] {
  return [{
    type: 'function_call',
    callId,
    name: 'jq_query',
    arguments: JSON.stringify({
      filter: '.records | length',
      source: { type: 'inline', data: { records: [] } }
    })
  }, {
    type: 'function_call_output',
    callId,
    output: '{"ok":true,"values":[3],"exitCode":0}'
  }];
}

async function persistFixture(
  root: string,
  input: { manifest: Stage2bBatchManifest; records: Stage2bRecord[] }
): Promise<void> {
  const batchRoot = join(root, '.experiment-runs/stage-2b/batches', input.manifest.batchId);
  await mkdir(batchRoot, { recursive: true, mode: 0o700 });
  await chmod(join(root, '.experiment-runs'), 0o700);
  await chmod(join(root, '.experiment-runs/stage-2b'), 0o700);
  await chmod(join(root, '.experiment-runs/stage-2b/batches'), 0o700);
  await writeFile(join(batchRoot, 'manifest.json'), `${JSON.stringify(input.manifest, null, 2)}\n`, { mode: 0o600 });
  for (const record of input.records) {
    const recordRoot = join(root, '.experiment-runs/stage-2b', record.runId);
    await mkdir(recordRoot, { mode: 0o700 });
    await writeFile(join(recordRoot, 'record.json'), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  }
}
