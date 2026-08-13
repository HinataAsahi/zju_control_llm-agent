import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Stage2bBatchManifest } from '../../src/experiment/stage2b-batch.js';
import type { Stage2bRecord } from '../../src/experiment/stage2b-record.js';
import {
  main,
  parseStage2bArgs,
  stage2bFailureMessage
} from '../../src/experiment/stage2b.js';
import {
  renderStage2bComparisonMarkdown,
  summarizeStage2bBatches,
  writeStage2bComparisonReport
} from '../../src/experiment/stage2b-report.js';

test('summarizes pilot and calibrated batches without publishing raw traces', () => {
  const pilot = batchFixture('pilot', null, 5, 4, [
    runFixture('T2', 'explicit', 'completed', true, null, 4, 3, 100),
    runFixture('T2', 'description', 'completed', true, null, 4, 3, 110),
    runFixture('T2', 'skill', 'limit-exceeded', null, null, 5, 4, 120),
    runFixture('T7', 'explicit', 'limit-exceeded', null, false, 5, 4, 130),
    runFixture('T7', 'description', 'limit-exceeded', null, false, 5, 4, 140),
    runFixture('T7', 'skill', 'limit-exceeded', null, false, 5, 4, 150)
  ]);
  const calibrated = batchFixture('calibrated', 0, 6, 5, [
    runFixture('T2', 'explicit', 'completed', true, null, 4, 3, 200),
    runFixture('T2', 'description', 'completed', true, null, 4, 3, 210),
    runFixture('T2', 'skill', 'completed', true, null, 4, 3, 220),
    runFixture('T7', 'explicit', 'completed', true, true, 5, 4, 230),
    runFixture('T7', 'description', 'completed', true, true, 5, 4, 240),
    runFixture('T7', 'skill', 'completed', true, true, 5, 4, 250)
  ]);

  const report = summarizeStage2bBatches([pilot, calibrated]);
  const serialized = JSON.stringify(report);
  const markdown = renderStage2bComparisonMarkdown(report);

  assert.equal(report.version, 3);
  assert.equal(report.scope, 'descriptive-observations');
  assert.deepEqual(report.batches.map(batch => ({
    role: batch.role,
    completed: batch.counts.completed,
    taskSuccess: batch.counts.taskSuccess,
    limitExceeded: batch.counts.limitExceeded,
    totalTokens: batch.usage.totalTokens
  })), [{
    role: 'pilot',
    completed: 2,
    taskSuccess: 2,
    limitExceeded: 4,
    totalTokens: 750
  }, {
    role: 'calibrated',
    completed: 6,
    taskSuccess: 6,
    limitExceeded: 0,
    totalTokens: 1_350
  }]);
  assert.deepEqual(report.batches[1]?.runs[5], {
    taskId: 'T7',
    condition: 'skill',
    repetition: 1,
    status: 'completed',
    taskSuccess: true,
    recoverySuccess: true,
    turns: 5,
    toolCalls: 4,
    tracePath: [],
    usage: usage(250)
  });
  assert.doesNotMatch(serialized, /recordRunId|toolEvents|finalAnswer|secret|\/home\//i);
  assert.match(markdown, /描述性观测/);
  assert.match(markdown, /pilot.*2\/6.*4/s);
  assert.match(markdown, /calibrated.*6\/6.*0/s);
  assert.match(markdown, /恢复成功（可判定）/);
  assert.match(markdown, /不能归因|不能直接归因/);
  assert.doesNotMatch(markdown, /固定配置 repeat|每个任务与条件有三次/);
});

test('combines one calibrated run and two repeat runs into n=3 cell statistics', () => {
  const calibrated = batchFixture('calibrated', 0, 6, 5, successfulRecords(200));
  const repeat = batchFixture('repeat', 0, 6, 5, repeatedSuccessfulRecords(300, 400));

  const report = summarizeStage2bBatches([calibrated, repeat]);
  const comparison = report.repeatedComparison;

  assert.ok(comparison);
  assert.deepEqual(comparison.sourceRoles, ['calibrated', 'repeat']);
  assert.equal(comparison.totalRuns, 18);
  assert.equal(comparison.observationsPerCell, 3);
  assert.deepEqual(comparison.cells[0], {
    taskId: 'T2',
    condition: 'explicit',
    observations: 3,
    completed: 3,
    taskSuccess: 3,
    recoverySuccess: 0,
    recoveryApplicable: 0,
    turns: { min: 4, max: 4, mean: 4 },
    toolCalls: { min: 3, max: 3, mean: 3 },
    totalTokens: { min: 200, max: 400, mean: 300, sum: 900 }
  });
  assert.deepEqual(comparison.cells[5], {
    taskId: 'T7',
    condition: 'skill',
    observations: 3,
    completed: 3,
    taskSuccess: 3,
    recoverySuccess: 3,
    recoveryApplicable: 3,
    turns: { min: 5, max: 5, mean: 5 },
    toolCalls: { min: 4, max: 4, mean: 4 },
    totalTokens: { min: 250, max: 450, mean: 350, sum: 1_050 }
  });
  const markdown = renderStage2bComparisonMarkdown(report);
  assert.match(markdown, /固定配置重复观测.*n=3/s);
  assert.match(markdown, /T2.*explicit.*N\/A/);
  assert.doesNotMatch(markdown, /0\/0/);
});

test('publishes sanitized trace paths without raw jq filters or tool output', () => {
  const calibratedRecords = successfulRecords(200);
  calibratedRecords[0] = withJqTrace(calibratedRecords[0]!, [
    ['[.[] | select(.active == true) | .name]', 'JQ_RUNTIME_ERROR'],
    ['.', 'ok'],
    ['.users[] | select(.active == true) | .name', 'ok']
  ]);
  const repeatRecords = repeatedSuccessfulRecords(300, 400);
  repeatRecords[0] = withJqTrace(repeatRecords[0]!, [
    ['[.[] | select(.active == true) | .name]', 'JQ_RUNTIME_ERROR'],
    ['.', 'ok'],
    ['.users[] | select(.active == true) | .name', 'ok']
  ]);
  repeatRecords[1] = withJqTrace(repeatRecords[1]!, [
    ['[.[] | select(.active == true) | .name]', 'JQ_RUNTIME_ERROR'],
    ['.', 'ok'],
    ['[.users[] | select(.active == true) | .name]', 'ok']
  ]);
  const report = summarizeStage2bBatches([
    batchFixture('calibrated', 0, 6, 5, calibratedRecords),
    batchFixture('repeat', 0, 6, 5, repeatRecords)
  ]);

  assert.deepEqual(report.batches[0]?.runs[0]?.tracePath, [
    'root-unaware-name-array-query:JQ_RUNTIME_ERROR',
    'inspect-root:ok',
    'root-aware-name-stream-query:ok'
  ]);
  assert.deepEqual(report.traceAnalysis?.cells[0], {
    taskId: 'T2',
    condition: 'explicit',
    observations: 3,
    distinctPaths: 2,
    paths: [{
      steps: [
        'root-unaware-name-array-query:JQ_RUNTIME_ERROR',
        'inspect-root:ok',
        'root-aware-name-stream-query:ok'
      ],
      count: 2
    }, {
      steps: [
        'root-unaware-name-array-query:JQ_RUNTIME_ERROR',
        'inspect-root:ok',
        'root-aware-name-array-query:ok'
      ],
      count: 1
    }]
  });
  const publicText = `${JSON.stringify(report)}\n${renderStage2bComparisonMarkdown(report)}`;
  assert.match(publicText, /JQ_RUNTIME_ERROR|root-aware-name/);
  assert.doesNotMatch(publicText, /select\(|\.users|\"filter\"|call-secret/);
});

test('uses fixed trace labels for malformed or unsafe jq events', () => {
  const records = successfulRecords(200);
  records[0] = {
    ...records[0]!,
    toolEvents: [{
      type: 'function_call',
      callId: 'bad-arguments',
      name: 'jq_query',
      arguments: 'private-filter-text'
    }, {
      type: 'function_call_output',
      callId: 'bad-arguments',
      output: 'private-output-text'
    }, {
      type: 'function_call',
      callId: 'unsafe-code',
      name: 'jq_query',
      arguments: JSON.stringify({ filter: '.', source: { type: 'file', path: 'users.json' } })
    }, {
      type: 'function_call_output',
      callId: 'unsafe-code',
      output: JSON.stringify({ ok: false, error: { code: 'PRIVATE_SECRET_CODE' } })
    }, {
      type: 'function_call',
      callId: 'ignored-tool',
      name: 'other_tool',
      arguments: 'private-other-arguments'
    }]
  };

  const report = summarizeStage2bBatches([
    batchFixture('calibrated', 0, 6, 5, records)
  ]);
  const serialized = JSON.stringify(report);

  assert.deepEqual(report.batches[0]?.runs[0]?.tracePath, [
    'invalid-arguments:malformed-output',
    'inspect-root:tool-error'
  ]);
  assert.doesNotMatch(
    serialized,
    /private-filter-text|private-output-text|PRIVATE_SECRET_CODE|private-other-arguments/
  );
});

test('rejects a batch whose record does not match its manifest configuration', () => {
  const input = batchFixture('calibrated', 0, 6, 5, [
    runFixture('T2', 'explicit', 'completed', true, null, 4, 3, 100),
    runFixture('T2', 'description', 'completed', true, null, 4, 3, 100),
    runFixture('T2', 'skill', 'completed', true, null, 4, 3, 100),
    runFixture('T7', 'explicit', 'completed', true, true, 5, 4, 100),
    runFixture('T7', 'description', 'completed', true, true, 5, 4, 100),
    runFixture('T7', 'skill', 'completed', true, true, 5, 4, 100)
  ]);
  input.records[0] = {
    ...input.records[0]!,
    sampling: { temperature: null }
  };

  assert.throws(() => summarizeStage2bBatches([input]), /sampling.*manifest/i);
});

test('rejects repeated statistics across different execution limits', () => {
  const calibrated = batchFixture('calibrated', 0, 6, 5, successfulRecords(200));
  const repeat = batchFixture('repeat', 0, 5, 4, repeatedSuccessfulRecords(300, 400));

  assert.throws(
    () => summarizeStage2bBatches([calibrated, repeat]),
    /repeat configuration.*calibrated/i
  );
});

test('loads private records and writes deterministic public Stage 2B artifacts', async t => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'stage2b-report-'));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const pilot = batchFixture('pilot', null, 5, 4, successfulRecords(100));
  const calibrated = batchFixture('calibrated', 0, 6, 5, successfulRecords(200));
  await persistBatch(repositoryRoot, pilot);
  await persistBatch(repositoryRoot, calibrated);
  await removeLegacySamplingMetadata(repositoryRoot, pilot);

  const result = await writeStage2bComparisonReport({
    repositoryRoot,
    pilotBatchId: pilot.manifest.batchId,
    calibratedBatchId: calibrated.manifest.batchId
  });
  const json = await readFile(result.jsonPath, 'utf8');
  const markdown = await readFile(result.markdownPath, 'utf8');

  assert.equal(
    result.jsonPath,
    join(repositoryRoot, 'experiments/stage-2b/results/observations.json')
  );
  assert.equal(
    result.markdownPath,
    join(repositoryRoot, 'experiments/stage-2b/results/report.zh.md')
  );
  assert.deepEqual(JSON.parse(json), result.report);
  assert.equal(markdown, renderStage2bComparisonMarkdown(result.report));
  assert.equal((await lstat(result.jsonPath)).mode & 0o777, 0o644);
  assert.equal((await lstat(result.markdownPath)).mode & 0o777, 0o644);
  assert.doesNotMatch(`${json}\n${markdown}`, /toolEvents|recordRunId|finalAnswer|\/home\//i);
});

test('runs the offline report command without reading an API key', async t => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'stage2b-report-cli-'));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const pilot = batchFixture('pilot', null, 5, 4, successfulRecords(100));
  const calibrated = batchFixture('calibrated', 0, 6, 5, successfulRecords(200));
  const repeat = batchFixture('repeat', 0, 6, 5, repeatedSuccessfulRecords(300, 400));
  await persistBatch(repositoryRoot, pilot);
  await persistBatch(repositoryRoot, calibrated);
  await persistBatch(repositoryRoot, repeat);
  const argv = [
    'report',
    '--pilot-batch', pilot.manifest.batchId,
    '--calibrated-batch', calibrated.manifest.batchId,
    '--repeat-batch', repeat.manifest.batchId
  ];

  assert.deepEqual(parseStage2bArgs(argv), {
    mode: 'report',
    kind: 'baseline',
    pilotBatchId: pilot.manifest.batchId,
    calibratedBatchId: calibrated.manifest.batchId,
    repeatBatchId: repeat.manifest.batchId
  });
  assert.throws(
    () => parseStage2bArgs(['report', '--pilot-batch', pilot.manifest.batchId]),
    /report.*calibrated/i
  );
  assert.throws(
    () => parseStage2bArgs([
      'report',
      '--pilot-batch', '../escape',
      '--calibrated-batch', calibrated.manifest.batchId
    ]),
    /report.*batch/i
  );
  let output = '';
  const exitCode = await main(argv, {
    repositoryRoot,
    env: new Proxy({}, {
      get: () => { throw new Error('report must not read an API key'); }
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
    pilotBatchId: pilot.manifest.batchId,
    calibratedBatchId: calibrated.manifest.batchId,
    repeatBatchId: repeat.manifest.batchId,
    jsonPath: join(repositoryRoot, 'experiments/stage-2b/results/observations.json'),
    markdownPath: join(repositoryRoot, 'experiments/stage-2b/results/report.zh.md')
  });
});

test('uses a report-specific safe CLI failure message', () => {
  assert.equal(
    stage2bFailureMessage(['report']),
    'Stage 2B report failed. Verify the local batch records and configuration.\n'
  );
  assert.equal(
    stage2bFailureMessage(['smoke']),
    'Stage 2B smoke failed. Inspect the local record when available.\n'
  );
  assert.equal(
    stage2bFailureMessage(['prepare']),
    'Stage 2B batch preparation failed. Verify the requested suite and gate inputs.\n'
  );
});

function batchFixture<Role extends 'pilot' | 'calibrated' | 'repeat'>(
  role: Role,
  temperature: number | null,
  maxTurns: number,
  maxToolCalls: number,
  records: Stage2bRecord[]
): {
  role: Role;
  manifest: Stage2bBatchManifest;
  records: Stage2bRecord[];
} {
  const batchId = `stage2b-batch-20260811T080000000Z-${role}`;
  const configuredRecords = records.map((record, index) => ({
    ...record,
    runId: `${record.runId}-${role}-${index + 1}`,
    sampling: { temperature },
    limits: { maxTurns, maxToolCalls, requestTimeoutMs: 60_000, totalTimeoutMs: 120_000 }
  }));
  const repetitions = new Map<string, number>();
  const runs = configuredRecords.map(record => {
    const key = `${record.taskId}-${record.condition}`;
    const repetition = (repetitions.get(key) ?? 0) + 1;
    repetitions.set(key, repetition);
    return {
      runKey: `${key}-r${repetition}`,
      taskId: record.taskId as 'T2' | 'T7',
      condition: record.condition,
      repetition,
      status: record.status === 'completed' ? 'completed' as const : 'failed' as const,
      recordRunId: record.runId,
      recordStatus: record.status,
      taskSuccess: record.taskSuccess,
      recoverySuccess: record.recoverySuccess
    };
  });
  return {
    role,
    manifest: {
      version: 1,
      batchId,
      createdAt: '2026-08-11T08:00:00.000Z',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      thinking: 'none',
      sampling: { temperature },
      repetitions: Math.max(...repetitions.values()),
      totalRuns: configuredRecords.length,
      limits: { maxTurns, maxToolCalls, requestTimeoutMs: 60_000, totalTimeoutMs: 120_000 },
      runs
    },
    records: configuredRecords
  };
}

function runFixture(
  taskId: 'T2' | 'T7',
  condition: 'explicit' | 'description' | 'skill',
  status: Stage2bRecord['status'],
  taskSuccess: boolean | null,
  recoverySuccess: boolean | null,
  turns: number,
  toolCalls: number,
  totalTokens: number
): Stage2bRecord {
  return {
    version: 1,
    runId: `stage2b-${taskId}-${condition}-fixture`,
    startedAt: '2026-08-11T08:00:00.000Z',
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    thinking: 'none',
    sampling: { temperature: status === 'limit-exceeded' ? null : 0 },
    taskId,
    condition,
    status,
    taskSuccess,
    recoverySuccess,
    limits: {
      maxTurns: status === 'limit-exceeded' ? 5 : 6,
      maxToolCalls: status === 'limit-exceeded' ? 4 : 5,
      requestTimeoutMs: 60_000,
      totalTimeoutMs: 120_000
    },
    turns,
    toolCalls,
    toolEvents: [{
      type: 'function_call_output',
      callId: 'call-secret',
      output: '{"secret":"/home/alice/private"}'
    }],
    finalAnswer: { status: 'completed', answer: 3, explanation: 'secret trace' },
    usage: usage(totalTokens),
    durationMs: 100
  };
}

function usage(totalTokens: number): Stage2bRecord['usage'] {
  return {
    inputTokens: totalTokens - 10,
    cachedInputTokens: totalTokens - 20,
    outputTokens: 10,
    reasoningOutputTokens: 0,
    totalTokens
  };
}

function successfulRecords(firstTotalTokens: number): Stage2bRecord[] {
  return [
    runFixture('T2', 'explicit', 'completed', true, null, 4, 3, firstTotalTokens),
    runFixture('T2', 'description', 'completed', true, null, 4, 3, firstTotalTokens + 10),
    runFixture('T2', 'skill', 'completed', true, null, 4, 3, firstTotalTokens + 20),
    runFixture('T7', 'explicit', 'completed', true, true, 5, 4, firstTotalTokens + 30),
    runFixture('T7', 'description', 'completed', true, true, 5, 4, firstTotalTokens + 40),
    runFixture('T7', 'skill', 'completed', true, true, 5, 4, firstTotalTokens + 50)
  ];
}

function repeatedSuccessfulRecords(
  firstTotalTokens: number,
  secondTotalTokens: number
): Stage2bRecord[] {
  const first = successfulRecords(firstTotalTokens);
  const second = successfulRecords(secondTotalTokens);
  return first.flatMap((record, index) => [record, second[index]!]);
}

function withJqTrace(
  record: Stage2bRecord,
  steps: Array<[filter: string, outcome: 'ok' | 'JQ_RUNTIME_ERROR' | 'JQ_SYNTAX_ERROR']>
): Stage2bRecord {
  return {
    ...record,
    toolEvents: steps.flatMap(([filter, outcome], index) => {
      const callId = `call-${index + 1}`;
      return [{
        type: 'function_call' as const,
        callId,
        name: 'jq_query',
        arguments: JSON.stringify({ filter, source: { type: 'file', path: 'users.json' } })
      }, {
        type: 'function_call_output' as const,
        callId,
        output: outcome === 'ok'
          ? JSON.stringify({ ok: true, values: [3], exitCode: 0 })
          : JSON.stringify({ ok: false, error: { code: outcome }, exitCode: 5 })
      }];
    })
  };
}

async function persistBatch(
  repositoryRoot: string,
  input: ReturnType<typeof batchFixture>
): Promise<void> {
  const batchRoot = join(
    repositoryRoot,
    '.experiment-runs/stage-2b/batches',
    input.manifest.batchId
  );
  await mkdir(batchRoot, { recursive: true, mode: 0o700 });
  await chmod(batchRoot, 0o700);
  await writeFile(
    join(batchRoot, 'manifest.json'),
    `${JSON.stringify(input.manifest, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 }
  );
  for (const record of input.records) {
    const recordRoot = join(repositoryRoot, '.experiment-runs/stage-2b', record.runId);
    await mkdir(recordRoot, { recursive: true, mode: 0o700 });
    await writeFile(
      join(recordRoot, 'record.json'),
      `${JSON.stringify({ ...record, toolEvents: [] }, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 }
    );
  }
}

async function removeLegacySamplingMetadata(
  repositoryRoot: string,
  input: ReturnType<typeof batchFixture>
): Promise<void> {
  for (const record of input.records) {
    const path = join(
      repositoryRoot,
      '.experiment-runs/stage-2b',
      record.runId,
      'record.json'
    );
    const legacy = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    delete legacy.sampling;
    await writeFile(path, `${JSON.stringify(legacy, null, 2)}\n`, 'utf8');
  }
}
