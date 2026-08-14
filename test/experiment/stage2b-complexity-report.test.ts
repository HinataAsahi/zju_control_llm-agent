import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Stage2bBatchManifest } from '../../src/experiment/stage2b-batch.js';
import {
  renderStage2bComplexityMarkdown,
  summarizeStage2bComplexityBatch,
  writeStage2bComplexityReport
} from '../../src/experiment/stage2b-complexity-report.js';
import type { Stage2bRecord, Stage2bToolEvent } from '../../src/experiment/stage2b-record.js';
import { expandStage2bSuite } from '../../src/experiment/stage2b-suite.js';
import { main, parseStage2bArgs } from '../../src/experiment/stage2b.js';

function fixture(): { manifest: Stage2bBatchManifest; records: Stage2bRecord[] } {
  const batchId = 'stage2b-batch-complexity-fixture';
  const planned = expandStage2bSuite('complexity-v1', 1);
  const behaviors = ['direct', 'success', 'recovered', 'direct', 'success', 'failed'] as const;
  const records = planned.map((run, index): Stage2bRecord => {
    const behavior = behaviors[index]!;
    const taskSuccess = behavior !== 'failed';
    const toolEvents = complexityToolEvents(behavior, index);
    return {
      version: 1,
      runId: `stage2b-${run.taskId}-description-complexity-${index}`,
      startedAt: '2026-08-14T08:00:00.000Z',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      thinking: 'none',
      sampling: { temperature: 0 },
      taskId: run.taskId,
      condition: 'description',
      status: 'completed',
      taskSuccess,
      recoverySuccess: null,
      limits: {
        maxTurns: 6,
        maxToolCalls: 5,
        requestTimeoutMs: 60_000,
        totalTimeoutMs: 120_000
      },
      turns: toolEvents.length === 0 ? 1 : behavior === 'recovered' ? 3 : 2,
      toolCalls: toolEvents.filter(event => event.type === 'function_call').length,
      toolEvents,
      usage: {
        inputTokens: 90,
        cachedInputTokens: 30,
        outputTokens: 30,
        reasoningOutputTokens: 0,
        totalTokens: 120
      },
      durationMs: 100
    };
  });
  const manifest: Stage2bBatchManifest = {
    version: 2,
    suite: 'complexity-v1',
    batchId,
    createdAt: '2026-08-14T08:00:00.000Z',
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    thinking: 'none',
    sampling: { temperature: 0 },
    repetitions: 1,
    totalRuns: planned.length,
    limits: {
      maxTurns: 6,
      maxToolCalls: 5,
      requestTimeoutMs: 60_000,
      totalTimeoutMs: 120_000
    },
    runs: planned.map((run, index) => ({
      runKey: `${run.taskId}-${run.condition}-r1`,
      ...run,
      status: 'completed',
      recordRunId: records[index]!.runId,
      recordStatus: 'completed',
      taskSuccess: records[index]!.taskSuccess,
      recoverySuccess: null
    }))
  };
  return { manifest, records };
}

test('summarizes six observed complexity runs without treating direct answers as violations', () => {
  const report = summarizeStage2bComplexityBatch(fixture());

  assert.deepEqual(report.counts, {
    total: 6,
    completed: 6,
    failed: 0,
    taskSuccess: 5,
    toolAttempted: 4,
    successfulToolUse: 3,
    directAnswers: 2,
    limitExceeded: 0
  });
  assert.equal(report.calibration.usable, true);
  assert.equal(report.calibration.correctDirectAnswers, 2);
  assert.equal(report.calibration.correctSuccessfulToolUses, 3);
  assert.deepEqual(report.calibration.scaleSwitchOperations, []);
  assert.deepEqual(report.runs.map(run => run.taskId), ['T18', 'T21', 'T22', 'T19', 'T20', 'T23']);
  assert.deepEqual(report.runs.map(run => run.selection), [
    'direct', 'successful-tool', 'successful-tool', 'direct', 'successful-tool', 'failed-tool'
  ]);
  assert.deepEqual(report.runs.map(run => run.strategy), [
    'direct-answer', 'one-shot-query', 'recovered-after-error',
    'direct-answer', 'one-shot-query', 'failed-tool'
  ]);
  assert.deepEqual(report.matrix.map(cell => [cell.operation, cell.size]), [
    ['count', 'small'], ['count', 'medium'],
    ['filter-sort', 'small'], ['filter-sort', 'medium'],
    ['group-aggregate', 'small'], ['group-aggregate', 'medium']
  ]);

  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /batchId|toolCompliance|toolEvents|finalAnswer|runId|call-\d|"filter"|"output"/);
  const markdown = renderStage2bComplexityMarkdown(report);
  assert.match(markdown, /复杂度校准/);
  assert.match(markdown, /校准可用：是/);
  assert.match(markdown, /直接作答/);
  assert.doesNotMatch(markdown, /工具合规/);
});

test('requires exactly one complete complexity repetition', () => {
  const input = fixture();
  input.manifest.repetitions = 2;
  assert.throws(() => summarizeStage2bComplexityBatch(input), /exactly one|一次|repetition/i);

  const incomplete = fixture();
  incomplete.manifest.runs[0] = { ...incomplete.manifest.runs[0]!, status: 'pending' };
  assert.throws(() => summarizeStage2bComplexityBatch(incomplete), /terminal/i);
});

test('rejects versioned skill metadata from Description-only complexity records', () => {
  const input = fixture();
  input.records[0] = {
    ...input.records[0]!,
    version: 2,
    skill: null
  };

  assert.throws(() => summarizeStage2bComplexityBatch(input), /identity/i);
});

test('does not misclassify an infrastructure failure without calls as a direct answer', () => {
  const input = fixture();
  input.records[0] = {
    ...input.records[0]!,
    status: 'infrastructure-error',
    taskSuccess: null,
    error: { category: 'mcp', code: 'MCP_UNAVAILABLE' }
  };
  const originalRun = input.manifest.runs[0];
  if (originalRun?.status !== 'completed') assert.fail('Expected a completed fixture run.');
  input.manifest.runs[0] = {
    ...originalRun,
    status: 'failed',
    recordStatus: 'infrastructure-error',
    taskSuccess: null
  };

  const report = summarizeStage2bComplexityBatch(input);
  assert.equal(report.runs[0]?.selection, 'unresolved');
  assert.equal(report.runs[0]?.strategy, 'unresolved');
  assert.equal(report.counts.directAnswers, 1);
  assert.equal(report.counts.failed, 1);
});

test('writes sanitized complexity artifacts and routes the offline CLI', async t => {
  const root = await mkdtemp(join(tmpdir(), 'stage2b-complexity-report-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = fixture();
  await persistFixture(root, input);

  assert.deepEqual(
    parseStage2bArgs(['report', '--complexity-batch', input.manifest.batchId]),
    { mode: 'report', kind: 'complexity', batchId: input.manifest.batchId }
  );
  assert.throws(
    () => parseStage2bArgs(['report', '--complexity-batch', input.manifest.batchId, '--repeat-batch', input.manifest.batchId]),
    /report.*batch/i
  );

  let output = '';
  const exitCode = await main(['report', '--complexity-batch', input.manifest.batchId], {
    repositoryRoot: root,
    env: new Proxy({}, { get: () => { throw new Error('report must not read an API key'); } }),
    writeOutput: text => { output += text; },
    dependencies: {
      createModelClient: () => { throw new Error('report must not create a model client'); },
      connectTools: async () => { throw new Error('report must not connect MCP tools'); }
    }
  });

  assert.equal(exitCode, 0);
  const expected = {
    status: 'reported',
    kind: 'complexity',
    batchId: input.manifest.batchId,
    jsonPath: join(root, 'experiments/stage-2b/results/complexity-v1/observations.json'),
    markdownPath: join(root, 'experiments/stage-2b/results/complexity-v1/report.zh.md')
  };
  assert.deepEqual(JSON.parse(output), expected);
  assert.equal(output, `${JSON.stringify(expected, null, 2)}\n`);
  const written = await writeStage2bComplexityReport({
    repositoryRoot: root,
    batchId: input.manifest.batchId
  });
  assert.deepEqual(JSON.parse(await readFile(written.jsonPath, 'utf8')), written.report);
  const publicText = `${await readFile(written.jsonPath, 'utf8')}\n${await readFile(written.markdownPath, 'utf8')}`;
  assert.doesNotMatch(publicText, /batchId|toolEvents|finalAnswer|runId|call-\d|"filter"|"output"/);
});

function complexityToolEvents(
  behavior: 'direct' | 'success' | 'recovered' | 'failed',
  index: number
): Stage2bToolEvent[] {
  if (behavior === 'direct') return [];
  const failedCall = callPair(`call-${index}-failed`, false);
  if (behavior === 'failed') return failedCall;
  const successfulCall = callPair(`call-${index}-ok`, true);
  return behavior === 'recovered' ? [...failedCall, ...successfulCall] : successfulCall;
}

function callPair(callId: string, ok: boolean): Stage2bToolEvent[] {
  return [{
    type: 'function_call',
    callId,
    name: 'jq_query',
    arguments: JSON.stringify({
      filter: ok ? '.transactions | length' : 'if',
      source: { type: 'inline', data: { transactions: [] } }
    })
  }, {
    type: 'function_call_output',
    callId,
    output: ok
      ? '{"ok":true,"values":[6],"exitCode":0}'
      : '{"ok":false,"error":{"code":"JQ_SYNTAX_ERROR"}}'
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
