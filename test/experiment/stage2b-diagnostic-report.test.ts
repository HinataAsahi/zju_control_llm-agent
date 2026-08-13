import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
  summarizeStage2bDiagnosticBatches,
  writeStage2bDiagnosticReport
} from '../../src/experiment/stage2b-diagnostic-report.js';
import {
  readStage2bReportRecord,
  type Stage2bReportRecord
} from '../../src/experiment/stage2b-report.js';
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

test('preserves the base single-batch public artifact bytes', () => {
  const report = summarizeStage2bDiagnosticBatch(diagnosticFixture());
  assert.equal(report.repeatBatchId, undefined);
  const summarizedBytes = `${JSON.stringify(report, null, 2)}\n`;
  // SHA-256 of the fixed single-batch fixture serialized by the 23e2a87 implementation.
  assert.equal(
    createHash('sha256').update(summarizedBytes).digest('hex'),
    '9ec167aaba03a0c4cafa62000ba69af33a598b3dd52d91928b3206e3cf10e316'
  );
  assert.equal(
    createHash('sha256').update(renderStage2bDiagnosticMarkdown(report)).digest('hex'),
    'b25f8ce617177fb063d0a679c168f77b517a140b70d7cd23efb95ef233f595bf'
  );
});

test('combines an initial batch with two complete repetitions as n=3', () => {
  const initial = diagnosticFixture(
    1,
    'stage2b-batch-20260813T000000000Z-initial',
    0,
    true
  );
  const repeat = diagnosticFixture(
    2,
    'stage2b-batch-20260814T000000000Z-repeat',
    1_000,
    true
  );
  const initialReport = summarizeStage2bDiagnosticBatch(initial);
  const repeatReport = summarizeStage2bDiagnosticBatch(repeat);
  const report = summarizeStage2bDiagnosticBatches(initial, repeat);

  assert.equal(report.batchId, initial.manifest.batchId);
  assert.equal(report.repeatBatchId, repeat.manifest.batchId);
  assert.equal(report.repetitions, 3);
  assert.equal(report.runs.length, 27);
  assert.deepEqual(report.counts, {
    total: 27,
    completed: 27,
    failed: 0,
    taskSuccess: 18,
    toolCompliance: 21,
    recoverySuccess: 3,
    recoveryApplicable: 6,
    limitExceeded: 0
  });
  assert.deepEqual(new Set(report.runs.map(run => run.repetition)), new Set([1, 2, 3]));
  assert.equal(new Set(report.runs.map(run =>
    `${run.taskId}/${run.condition}/${run.repetition}`
  )).size, 27);
  assert.ok(report.cells.every(cell => cell.observations === 3));
  assert.deepEqual(report.cells.map(cell => [cell.taskId, cell.condition]), matrix);
  assert.deepEqual(report.usage, sumUsages(initialReport.usage, repeatReport.usage));
  assert.equal(report.turns, initialReport.turns + repeatReport.turns);
  assert.equal(report.toolCalls, initialReport.toolCalls + repeatReport.toolCalls);
  for (const cell of report.cells) {
    const initialCell = initialReport.cells.find(candidate =>
      candidate.taskId === cell.taskId && candidate.condition === cell.condition
    )!;
    const repeatCell = repeatReport.cells.find(candidate =>
      candidate.taskId === cell.taskId && candidate.condition === cell.condition
    )!;
    assert.equal(cell.completed, initialCell.completed + repeatCell.completed);
    assert.equal(cell.taskSuccess, initialCell.taskSuccess + repeatCell.taskSuccess);
    assert.equal(cell.toolCompliance, initialCell.toolCompliance + repeatCell.toolCompliance);
    assert.equal(cell.recoverySuccess, initialCell.recoverySuccess + repeatCell.recoverySuccess);
    assert.equal(cell.recoveryApplicable, initialCell.recoveryApplicable + repeatCell.recoveryApplicable);
    assert.equal(cell.totalTokens.sum, initialCell.totalTokens.sum + repeatCell.totalTokens.sum);
    assert.deepEqual(
      cell.firstCallOutcomes,
      mergeCounts(initialCell.firstCallOutcomes, repeatCell.firstCallOutcomes)
    );
    assert.deepEqual(
      cell.strategies,
      mergeCounts(initialCell.strategies, repeatCell.strategies)
    );
    const cellRuns = report.runs.filter(run =>
      run.taskId === cell.taskId && run.condition === cell.condition
    );
    assert.deepEqual(cell.turns, metric(cellRuns.map(run => run.turns)));
    assert.deepEqual(cell.toolCalls, metric(cellRuns.map(run => run.toolCalls)));
    assert.deepEqual(cell.totalTokens, {
      ...metric(cellRuns.map(run => run.usage.totalTokens)),
      sum: cellRuns.reduce((sum, run) => sum + run.usage.totalTokens, 0)
    });
  }
  const markdown = renderStage2bDiagnosticMarkdown(report);
  assert.match(markdown, /initial.*repeat/s);
  const detailRows = markdown
    .split('## 逐项观测\n')[1]!
    .split('\n## 任务解释重点')[0]!
    .split('\n')
    .filter(line => /^\| T(?:9|10|11) \|/.test(line));
  assert.equal(detailRows.length, 27);
  assertSafePublicText(JSON.stringify(report));
  assertSafePublicText(markdown);

  assert.throws(() => summarizeStage2bDiagnosticBatches(initial, {
    ...repeat,
    manifest: { ...repeat.manifest, batchId: initial.manifest.batchId }
  }), /distinct|different|duplicate.*batch/i);

  const incompatible = diagnosticFixture(
    2,
    'stage2b-batch-20260814T000000000Z-incompatible'
  );
  incompatible.manifest.sampling = { temperature: null };
  incompatible.records.forEach(record => { record.sampling = { temperature: null }; });
  assert.throws(
    () => summarizeStage2bDiagnosticBatches(initial, incompatible),
    /configuration|temperature|sampling/i
  );

  const duplicateRecord = diagnosticFixture(
    2,
    'stage2b-batch-20260814T000000000Z-duplicate-record'
  );
  duplicateRecord.records[0]!.runId = initial.records[0]!.runId;
  Object.assign(duplicateRecord.manifest.runs[0]!, {
    recordRunId: initial.records[0]!.runId
  });
  assert.throws(
    () => summarizeStage2bDiagnosticBatches(initial, duplicateRecord),
    /duplicate record/i
  );

  for (const [field, value] of [
    ['provider', 'other-provider'],
    ['model', 'other-model'],
    ['thinking', 'other-thinking']
  ] as const) {
    const changed = diagnosticFixture(2, `stage2b-batch-20260814T000000000Z-${field}`);
    Object.assign(changed.manifest, { [field]: value });
    changed.records.forEach(record => { Object.assign(record, { [field]: value }); });
    assert.throws(
      () => summarizeStage2bDiagnosticBatches(initial, changed),
      /configuration/i,
      field
    );
  }

  for (const [field, value] of [
    ['maxTurns', 7],
    ['maxToolCalls', 6],
    ['requestTimeoutMs', 60_001],
    ['totalTimeoutMs', 120_001]
  ] as const) {
    const changed = diagnosticFixture(2, `stage2b-batch-20260814T000000000Z-${field}`);
    changed.manifest.limits = { ...changed.manifest.limits, [field]: value };
    changed.records.forEach(record => {
      record.limits = { ...record.limits, [field]: value };
    });
    assert.throws(
      () => summarizeStage2bDiagnosticBatches(initial, changed),
      /configuration/i,
      field
    );
  }

  const wrongMatrix = diagnosticFixture(
    2,
    'stage2b-batch-20260814T000000000Z-wrong-matrix'
  );
  wrongMatrix.manifest.runs[0]!.condition = 'description';
  assert.throws(
    () => summarizeStage2bDiagnosticBatches(initial, wrongMatrix),
    /plan mismatch/i
  );

  const wrongSuite = diagnosticFixture(
    2,
    'stage2b-batch-20260814T000000000Z-wrong-suite'
  );
  Object.assign(wrongSuite.manifest, { suite: 'baseline-v1' });
  assert.throws(
    () => summarizeStage2bDiagnosticBatches(initial, wrongSuite),
    /version 2 diagnostic manifest/i
  );
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

  const failedManifestRun = {
    ...fixture.manifest,
    runs: fixture.manifest.runs.map((run, index) => index === 0
      ? { ...run, status: 'failed' as const }
      : run)
  } as Stage2bBatchManifest;
  assert.throws(() => summarizeStage2bDiagnosticBatch({
    manifest: failedManifestRun,
    records: fixture.records
  }), /terminal status|status.*record/i);

  const infrastructureRecords = fixture.records.map((record, index) => index === 0
    ? { ...record, status: 'infrastructure-error' as const, taskSuccess: null }
    : record);
  const completedManifestRun = {
    ...fixture.manifest,
    runs: fixture.manifest.runs.map((run, index) => index === 0
      ? {
          ...run,
          status: 'completed' as const,
          recordStatus: 'infrastructure-error' as const,
          taskSuccess: null
        }
      : run)
  } as Stage2bBatchManifest;
  assert.throws(() => summarizeStage2bDiagnosticBatch({
    manifest: completedManifestRun,
    records: infrastructureRecords
  }), /terminal status|status.*record/i);
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

test('rejects truncated or wrongly versioned private records', async t => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'stage2b-record-reader-'));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const fixture = diagnosticFixture();
  await persistDiagnosticFixture(repositoryRoot, fixture);
  const record = fixture.records[0]!;
  const recordPath = join(repositoryRoot, '.experiment-runs/stage-2b', record.runId, 'record.json');
  const persisted = JSON.parse(await readFile(recordPath, 'utf8')) as Record<string, unknown>;

  const missingStartedAt = { ...persisted };
  delete missingStartedAt.startedAt;
  await writeFile(recordPath, `${JSON.stringify(missingStartedAt, null, 2)}\n`);
  await assert.rejects(readStage2bReportRecord(repositoryRoot, record.runId));

  await writeFile(recordPath, `${JSON.stringify({ ...persisted, version: 2 }, null, 2)}\n`);
  await assert.rejects(readStage2bReportRecord(repositoryRoot, record.runId));
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
  const expectedSingleOutput = {
    status: 'reported',
    kind: 'diagnostic',
    batchId: fixture.manifest.batchId,
    jsonPath: join(repositoryRoot, 'experiments/stage-2b/results/diagnostic-v1/observations.json'),
    markdownPath: join(repositoryRoot, 'experiments/stage-2b/results/diagnostic-v1/report.zh.md')
  };
  assert.deepEqual(JSON.parse(output), expectedSingleOutput);
  assert.equal(output, `${JSON.stringify(expectedSingleOutput, null, 2)}\n`);

  const repeat = diagnosticFixture(
    2,
    'stage2b-batch-20260814T000000000Z-repeat'
  );
  await persistDiagnosticFixture(repositoryRoot, repeat);
  const combinedArgv = [
    'report', '--batch', fixture.manifest.batchId,
    '--repeat-batch', repeat.manifest.batchId
  ];
  assert.deepEqual(parseStage2bArgs(combinedArgv), {
    mode: 'report',
    kind: 'diagnostic',
    batchId: fixture.manifest.batchId,
    repeatBatchId: repeat.manifest.batchId
  });
  output = '';
  assert.equal(await main(combinedArgv, {
    repositoryRoot,
    env: new Proxy({}, {
      get: () => { throw new Error('diagnostic report must not read an API key'); }
    }),
    writeOutput: text => { output += text; },
    dependencies: {
      createModelClient: () => { throw new Error('report must not create a model client'); },
      connectTools: async () => { throw new Error('report must not connect MCP tools'); }
    }
  }), 0);
  assert.equal(JSON.parse(output).repeatBatchId, repeat.manifest.batchId);
  assert.equal(output, `${JSON.stringify({
    status: 'reported',
    kind: 'diagnostic',
    batchId: fixture.manifest.batchId,
    repeatBatchId: repeat.manifest.batchId,
    jsonPath: join(repositoryRoot, 'experiments/stage-2b/results/diagnostic-v1/observations.json'),
    markdownPath: join(repositoryRoot, 'experiments/stage-2b/results/diagnostic-v1/report.zh.md')
  }, null, 2)}\n`);
  assert.equal(
    JSON.parse(await readFile(
      join(repositoryRoot, 'experiments/stage-2b/results/diagnostic-v1/observations.json'),
      'utf8'
    )).repetitions,
    3
  );

  const malformedRepeat = diagnosticFixture(
    2,
    'stage2b-batch-20260814T000000000Z-malformed-repeat'
  );
  await persistDiagnosticFixture(repositoryRoot, malformedRepeat);
  const malformedRecordPath = join(
    repositoryRoot,
    '.experiment-runs/stage-2b',
    malformedRepeat.records[0]!.runId,
    'record.json'
  );
  const malformedRecord = JSON.parse(await readFile(malformedRecordPath, 'utf8'));
  delete malformedRecord.startedAt;
  await writeFile(malformedRecordPath, `${JSON.stringify(malformedRecord, null, 2)}\n`);
  await assert.rejects(writeStage2bDiagnosticReport({
    repositoryRoot,
    batchId: fixture.manifest.batchId,
    repeatBatchId: malformedRepeat.manifest.batchId
  }), /record|invalid|schema/i);
});

function diagnosticFixture(
  repetitions = 1,
  batchId = 'stage2b-batch-20260813T000000000Z-diagnostic',
  tokenOffset = 0,
  useSentinelUsage = false
): {
  manifest: Stage2bBatchManifest;
  records: Stage2bReportRecord[];
} {
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
  const expanded = Array.from({ length: repetitions }, (_, repetitionIndex) =>
    matrix.map(([taskId, condition], cellIndex) => ({
      taskId,
      condition,
      repetition: repetitionIndex + 1,
      process: processFixtures[cellIndex]!
    }))
  ).flat();
  const records: Stage2bReportRecord[] = expanded.map((run, index) => {
    const { taskId, condition, process, repetition } = run;
    return {
      runId: `${batchId}-record-r${repetition}-${index + 1}`,
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
      usage: useSentinelUsage
        ? sentinelUsage(tokenOffset + 100 + index)
        : usage(tokenOffset + 100 + index)
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
      repetitions,
      totalRuns: expanded.length,
      limits: limits(),
      runs: expanded.map(({ taskId, condition, repetition }, index) => ({
        runKey: `${taskId}-${condition}-r${repetition}`,
        taskId,
        condition,
        repetition,
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
      version: 1,
      startedAt: '2026-08-13T00:01:00.000Z',
      finalAnswer: {
        status: 'completed',
        answer: 'private-output',
        explanation: 'final explanation private-output'
      },
      durationMs: 100
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

function sentinelUsage(value: number) {
  return {
    inputTokens: value * 6,
    cachedInputTokens: value * 2,
    outputTokens: value * 4,
    reasoningOutputTokens: value,
    totalTokens: value * 10
  };
}

function sumUsages(...values: Array<ReturnType<typeof usage>>) {
  return values.reduce((sum, value) => ({
    inputTokens: sum.inputTokens + value.inputTokens,
    cachedInputTokens: sum.cachedInputTokens + value.cachedInputTokens,
    outputTokens: sum.outputTokens + value.outputTokens,
    reasoningOutputTokens: sum.reasoningOutputTokens + value.reasoningOutputTokens,
    totalTokens: sum.totalTokens + value.totalTokens
  }), {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0
  });
}

function mergeCounts(...values: Array<Record<string, number>>) {
  const merged: Record<string, number> = {};
  for (const counts of values) {
    for (const [key, count] of Object.entries(counts)) {
      merged[key] = (merged[key] ?? 0) + count;
    }
  }
  return merged;
}

function metric(values: number[]) {
  const sum = values.reduce((total, value) => total + value, 0);
  return {
    min: Math.min(...values),
    max: Math.max(...values),
    mean: Number((sum / values.length).toFixed(2))
  };
}

function assertSafePublicText(text: string): void {
  assert.doesNotMatch(text, /select\(|\.payload|"filter"|toolEvents|recordRunId/i);
  assert.doesNotMatch(text, /call-private|private-output|private-record|PRIVATE_SECRET_CODE/i);
  assert.doesNotMatch(text, /\/private\/path|final explanation|DEEPSEEK_API_KEY|Authorization/i);
}
