import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Stage2bBatchManifest } from '../../src/experiment/stage2b-batch.js';
import {
  renderStage2bDiagnosticMarkdown,
  summarizeStage2bDiagnosticBatch,
  writeStage2bDiagnosticReport
} from '../../src/experiment/stage2b-diagnostic-report.js';
import type { Stage2bReportRecord } from '../../src/experiment/stage2b-report.js';
import type { Stage2bToolEvent } from '../../src/experiment/stage2b-record.js';
import { main, parseStage2bArgs } from '../../src/experiment/stage2b.js';

const matrix = [
  ['T9', 'explicit'], ['T10', 'description'], ['T11', 'skill'],
  ['T9', 'description'], ['T10', 'skill'], ['T11', 'explicit'],
  ['T9', 'skill'], ['T10', 'explicit'], ['T11', 'description']
] as const;

test('summarizes nine diagnostic cells with safe derived process metrics', () => {
  const fixture = diagnosticFixture();
  const report = summarizeStage2bDiagnosticBatch(fixture);

  assert.equal(report.version, 4);
  assert.equal(report.scope, 'diagnostic-observations');
  assert.equal(report.suite, 'diagnostic-v1');
  assert.equal(report.runs.length, 9);
  assert.deepEqual(report.cells.map(cell => [cell.taskId, cell.condition]), matrix);
  assert.deepEqual(new Set(report.runs.map(run => run.strategy)), new Set([
    'avoided-tool', 'unnecessary-tool', 'one-shot-query',
    'inspect-first', 'recovered-after-error', 'unresolved'
  ]));
  assert.equal(report.counts.total, 9);
  assert.equal(report.counts.toolCompliance, 7);
  assert.equal(report.counts.recoveryApplicable, 2);
  assert.equal(report.counts.recoverySuccess, 1);

  const markdown = renderStage2bDiagnosticMarkdown(report);
  assert.match(markdown, /Stage 2B 诊断观测报告/);
  assert.match(markdown, /avoided-tool|避免工具/);
  assert.match(markdown, /recovered-after-error|错误后恢复/);
  assert.match(markdown, /小样本/);
  assertSafePublicText(JSON.stringify(report));
  assertSafePublicText(markdown);
});

test('rejects non-diagnostic, duplicate, missing, and mismatched report inputs', () => {
  const fixture = diagnosticFixture();
  assert.throws(() => summarizeStage2bDiagnosticBatch({
    ...fixture,
    manifest: { ...fixture.manifest, version: 1 } as never
  }), /version 2|diagnostic/i);
  assert.throws(() => summarizeStage2bDiagnosticBatch({
    ...fixture,
    records: fixture.records.slice(1)
  }), /record count|missing/i);
  assert.throws(() => summarizeStage2bDiagnosticBatch({
    ...fixture,
    records: fixture.records.map((record, index) => index === 1
      ? fixture.records[0]!
      : record)
  }), /record count|duplicate/i);
  assert.throws(() => summarizeStage2bDiagnosticBatch({
    ...fixture,
    records: fixture.records.map((record, index) => index === 0
      ? { ...record, taskSuccess: false }
      : record)
  }), /outcome/i);

  const recordsWithFalseRecovery = fixture.records.map((record, index) => index === 5
    ? { ...record, recoverySuccess: false }
    : record);
  const manifestWithFalseRecovery = {
    ...fixture.manifest,
    runs: fixture.manifest.runs.map((run, index) => index === 5
      ? { ...run, recoverySuccess: false }
      : run)
  } as Stage2bBatchManifest;
  assert.throws(() => summarizeStage2bDiagnosticBatch({
    manifest: manifestWithFalseRecovery,
    records: recordsWithFalseRecovery
  }), /derived recovery|recovery.*events/i);
});

test('writes private-input diagnostic reports atomically to the separate public directory', async t => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'stage2b-diagnostic-report-'));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const fixture = diagnosticFixture();
  await persistDiagnosticFixture(repositoryRoot, fixture);

  const written = await writeStage2bDiagnosticReport({
    repositoryRoot,
    batchId: fixture.manifest.batchId
  });
  const expectedRoot = join(repositoryRoot, 'experiments/stage-2b/results/diagnostic-v1');
  assert.equal(written.jsonPath, join(expectedRoot, 'observations.json'));
  assert.equal(written.markdownPath, join(expectedRoot, 'report.zh.md'));
  assert.equal((await stat(written.jsonPath)).mode & 0o777, 0o644);
  assert.equal((await stat(written.markdownPath)).mode & 0o777, 0o644);
  assert.deepEqual(JSON.parse(await readFile(written.jsonPath, 'utf8')), written.report);
  assertSafePublicText(await readFile(written.jsonPath, 'utf8'));
  assertSafePublicText(await readFile(written.markdownPath, 'utf8'));
});

test('refuses to write a diagnostic report through a symlinked results directory', async t => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'stage2b-diagnostic-symlink-'));
  const outside = await mkdtemp(join(tmpdir(), 'stage2b-diagnostic-outside-'));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const fixture = diagnosticFixture();
  await persistDiagnosticFixture(repositoryRoot, fixture);
  await mkdir(join(repositoryRoot, 'experiments/stage-2b'), { recursive: true });
  await symlink(outside, join(repositoryRoot, 'experiments/stage-2b/results'), 'dir');

  await assert.rejects(writeStage2bDiagnosticReport({
    repositoryRoot,
    batchId: fixture.manifest.batchId
  }), /unsafe.*results|symbolic/i);
  assert.deepEqual(await readdir(outside), []);
});

test('routes the mutually exclusive diagnostic report CLI without credentials or tools', async t => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'stage2b-diagnostic-cli-'));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const fixture = diagnosticFixture();
  await persistDiagnosticFixture(repositoryRoot, fixture);
  const argv = ['report', '--batch', fixture.manifest.batchId];

  assert.deepEqual(parseStage2bArgs(argv), {
    mode: 'report', kind: 'diagnostic', batchId: fixture.manifest.batchId
  });
  assert.throws(() => parseStage2bArgs([
    ...argv, '--pilot-batch', fixture.manifest.batchId
  ]), /report.*batch/i);
  assert.throws(() => parseStage2bArgs(['report', '--batch', '../escape']), /report.*batch/i);

  let output = '';
  const exitCode = await main(argv, {
    repositoryRoot,
    env: new Proxy({}, {
      get: () => { throw new Error('diagnostic report must not read an API key'); }
    }),
    writeOutput: text => { output += text; },
    dependencies: {
      createModelClient: () => { throw new Error('report must not create a model client'); },
      connectTools: async () => { throw new Error('report must not connect MCP tools'); }
    }
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(JSON.parse(output), {
    status: 'reported',
    kind: 'diagnostic',
    batchId: fixture.manifest.batchId,
    jsonPath: join(repositoryRoot, 'experiments/stage-2b/results/diagnostic-v1/observations.json'),
    markdownPath: join(repositoryRoot, 'experiments/stage-2b/results/diagnostic-v1/report.zh.md')
  });
});

function diagnosticFixture(): {
  manifest: Stage2bBatchManifest;
  records: Stage2bReportRecord[];
} {
  const batchId = 'stage2b-batch-20260813T000000000Z-diagnostic';
  const processFixtures: Array<{
    taskSuccess: boolean;
    recoverySuccess: boolean | null;
    toolEvents: Stage2bToolEvent[];
  }> = [
    { taskSuccess: true, recoverySuccess: null, toolEvents: [] },
    { taskSuccess: true, recoverySuccess: null, toolEvents: successfulQuery('call-private-t10') },
    { taskSuccess: true, recoverySuccess: null, toolEvents: [
      ...successfulQuery('call-private-inspect', '.'),
      ...successfulQuery('call-private-t11')
    ] },
    { taskSuccess: true, recoverySuccess: null, toolEvents: successfulQuery('call-private-extra') },
    { taskSuccess: false, recoverySuccess: null, toolEvents: [] },
    { taskSuccess: true, recoverySuccess: true, toolEvents: [
      ...failedQuery('call-private-error'),
      ...successfulQuery('call-private-retry')
    ] },
    { taskSuccess: true, recoverySuccess: null, toolEvents: [] },
    { taskSuccess: false, recoverySuccess: null, toolEvents: [{
      type: 'function_call',
      callId: 'call-private-invalid',
      name: 'jq_query',
      arguments: 'private-invalid-arguments'
    }, {
      type: 'function_call_output',
      callId: 'call-private-invalid',
      output: JSON.stringify({ ok: false, error: { code: 'PRIVATE_SECRET_CODE' } })
    }] },
    { taskSuccess: false, recoverySuccess: false, toolEvents: failedQuery('call-private-unresolved') }
  ];
  const records: Stage2bReportRecord[] = matrix.map(([taskId, condition], index) => {
    const process = processFixtures[index]!;
    return {
      runId: `private-record-${index + 1}`,
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      thinking: 'none',
      sampling: { temperature: 0 },
      taskId,
      condition,
      status: 'completed',
      taskSuccess: process.taskSuccess,
      recoverySuccess: process.recoverySuccess,
      limits: limits(),
      turns: process.toolEvents.filter(event => event.type === 'function_call').length + 1,
      toolCalls: process.toolEvents.filter(event => event.type === 'function_call').length,
      toolEvents: process.toolEvents,
      usage: usage(100 + index)
    };
  });
  return {
    manifest: {
      version: 2,
      suite: 'diagnostic-v1',
      batchId,
      createdAt: '2026-08-13T00:00:00.000Z',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      thinking: 'none',
      sampling: { temperature: 0 },
      repetitions: 1,
      totalRuns: matrix.length,
      limits: limits(),
      runs: matrix.map(([taskId, condition], index) => ({
        runKey: `${taskId}-${condition}-r1`,
        taskId,
        condition,
        repetition: 1,
        status: 'completed' as const,
        recordRunId: records[index]!.runId,
        recordStatus: 'completed' as const,
        taskSuccess: records[index]!.taskSuccess,
        recoverySuccess: records[index]!.recoverySuccess
      }))
    },
    records
  };
}

async function persistDiagnosticFixture(
  repositoryRoot: string,
  fixture: ReturnType<typeof diagnosticFixture>
): Promise<void> {
  const batchRoot = join(
    repositoryRoot,
    '.experiment-runs/stage-2b/batches',
    fixture.manifest.batchId
  );
  await mkdir(batchRoot, { recursive: true, mode: 0o700 });
  await writeFile(join(batchRoot, 'manifest.json'), `${JSON.stringify(fixture.manifest, null, 2)}\n`, {
    mode: 0o600
  });
  for (const record of fixture.records) {
    const recordRoot = join(repositoryRoot, '.experiment-runs/stage-2b', record.runId);
    await mkdir(recordRoot, { recursive: true, mode: 0o700 });
    const privateRecord = {
      ...record,
      finalAnswer: {
        status: 'completed',
        answer: 'private-output',
        explanation: 'final explanation private-output'
      }
    };
    await writeFile(join(recordRoot, 'record.json'), `${JSON.stringify(privateRecord, null, 2)}\n`, {
      mode: 0o600
    });
  }
}

function successfulQuery(callId: string, filter = 'select(private)'): Stage2bToolEvent[] {
  return [{
    type: 'function_call',
    callId,
    name: 'jq_query',
    arguments: JSON.stringify({ filter, source: { type: 'file', path: '/private/path.json' } })
  }, {
    type: 'function_call_output',
    callId,
    output: JSON.stringify({ ok: true, values: ['private-output'] })
  }];
}

function failedQuery(callId: string): Stage2bToolEvent[] {
  return [{
    type: 'function_call',
    callId,
    name: 'jq_query',
    arguments: JSON.stringify({
      filter: '.payload | select(private)',
      source: { type: 'file', path: '/private/path.json' }
    })
  }, {
    type: 'function_call_output',
    callId,
    output: JSON.stringify({
      ok: false,
      error: { code: 'JQ_RUNTIME_ERROR', message: 'private-output' }
    })
  }];
}

function limits() {
  return {
    maxTurns: 6,
    maxToolCalls: 5,
    requestTimeoutMs: 60_000,
    totalTimeoutMs: 120_000
  };
}

function usage(totalTokens: number) {
  return {
    inputTokens: totalTokens - 20,
    cachedInputTokens: 10,
    outputTokens: 20,
    reasoningOutputTokens: 0,
    totalTokens
  };
}

function assertSafePublicText(text: string): void {
  assert.doesNotMatch(text, /select\(|\.payload|"filter"|toolEvents|recordRunId/i);
  assert.doesNotMatch(text, /call-private|private-output|private-record|PRIVATE_SECRET_CODE/i);
  assert.doesNotMatch(text, /\/private\/path|final explanation|DEEPSEEK_API_KEY|Authorization/i);
}
