import assert from 'node:assert/strict';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { McpToolBridge } from '../../src/agent/mcp-tool-bridge.js';
import type {
  ModelTurnClient,
  ModelTurnRequest,
  ModelTurnResult
} from '../../src/agent/model-client.js';
import {
  buildStage2bInstructions,
  main,
  parseStage2bArgs,
  runStage2bSmoke,
  stage2bExitCode,
  type Stage2bTaskId
} from '../../src/experiment/stage2b.js';
import {
  writeStage2bRecord,
  type Stage2bRecord
} from '../../src/experiment/stage2b-record.js';
import { analyzeStage2bProcess } from '../../src/experiment/stage2b-evaluation.js';
import {
  claimNextStage2bBatchRun,
  prepareStage2bBatch,
  readStage2bBatchManifest,
  recordStage2bBatchRun,
  stage2bManifestSuite
} from '../../src/experiment/stage2b-batch.js';

class T1FakeModel implements ModelTurnClient {
  readonly requests: ModelTurnRequest[] = [];

  constructor(private readonly finalText = '{"status":"completed","answer":3,"explanation":"Three values are greater than five."}') {}

  async createTurn(request: ModelTurnRequest): Promise<ModelTurnResult> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      return {
        historyItems: [{
          type: 'function_call',
          callId: 'call-1',
          name: 'jq_query',
          arguments: JSON.stringify({
            filter: '[.values[] | select(. > 5)] | length',
            source: { type: 'inline', data: { values: [3, 8, 8, 2, 11] } }
          })
        }],
        functionCalls: [{
          callId: 'call-1',
          name: 'jq_query',
          arguments: JSON.stringify({
            filter: '[.values[] | select(. > 5)] | length',
            source: { type: 'inline', data: { values: [3, 8, 8, 2, 11] } }
          })
        }],
        usage: usage(20, 4)
      };
    }
    return {
      historyItems: [{ type: 'message', role: 'assistant', content: this.finalText }],
      functionCalls: [],
      finalText: this.finalText,
      usage: usage(30, 6)
    };
  }
}

test('runs fake model to real MCP for the explicit T1 smoke', async t => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'stage2b-smoke-'));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  await cp(resolve('experiments'), join(repositoryRoot, 'experiments'), { recursive: true });
  const model = new T1FakeModel();
  const times = [
    new Date('2026-08-10T00:00:00.000Z'),
    new Date('2026-08-10T00:00:00.100Z')
  ];

  const record = await runStage2bSmoke({
    repositoryRoot,
    apiKey: 'offline-test-key',
    dependencies: {
      createModelClient: () => model,
      connectTools: options => McpToolBridge.connect({
        ...options,
        serverEntrypoint: resolve('dist/src/mcp/server.js')
      }),
      now: () => times.shift() ?? new Date('2026-08-10T00:00:00.100Z')
    }
  });

  assert.equal(record.taskId, 'T1');
  assert.equal(record.condition, 'explicit');
  assert.equal(record.status, 'completed');
  assert.equal(record.taskSuccess, true);
  assert.equal(record.recoverySuccess, null);
  assert.equal(record.finalAnswer?.answer, 3);
  assert.equal(record.turns, 2);
  assert.equal(record.toolCalls, 1);
  assert.deepEqual(record.limits, {
    maxTurns: 6,
    maxToolCalls: 5,
    requestTimeoutMs: 60_000,
    totalTimeoutMs: 120_000
  });
  assert.deepEqual(record.usage, {
    inputTokens: 50,
    cachedInputTokens: 10,
    outputTokens: 10,
    reasoningOutputTokens: 0,
    totalTokens: 60
  });
  assert.match(model.requests[0]?.history[0]?.type === 'message'
    ? model.requests[0].history[0].content
    : '', /jq_query/);
  assert.match(model.requests[0]?.instructions ?? '', /JSON/);
  assert.match(model.requests[0]?.instructions ?? '', /"status"/);
  assert.match(model.requests[0]?.instructions ?? '', /no other fields/i);
  assert.deepEqual(model.requests[0]?.tools.map(tool => tool.name), ['jq_query']);
  assert.match(record.toolEvents[1]?.type === 'function_call_output'
    ? record.toolEvents[1].output
    : '', /"values":\[3\]/);
});

test('runs representative file, recovery, and missing-file tasks through real MCP', async t => {
  const cases: Array<{
    taskId: Stage2bTaskId;
    turns: ModelTurnResult[];
    expectedAnswer: unknown;
    expectedToolCalls: number;
    expectedToolOutput: RegExp;
  }> = [{
    taskId: 'T2',
    turns: [
      toolTurn('call-t2', '.users | map(select(.active)) | map(.name)', {
        type: 'file', path: 'users.json'
      }),
      finalTurn(['Alice', 'Carol', 'Dave'], 'Read active users from the file.')
    ],
    expectedAnswer: ['Alice', 'Carol', 'Dave'],
    expectedToolCalls: 1,
    expectedToolOutput: /Alice.*Carol.*Dave/
  }, {
    taskId: 'T7',
    turns: [
      toolTurn('call-t7-bad', 'if', { type: 'file', path: 'users.json' }),
      toolTurn('call-t7-fixed', '[.users[] | select(.active)] | length', {
        type: 'file', path: 'users.json'
      }),
      finalTurn(3, 'Corrected the invalid jq filter.')
    ],
    expectedAnswer: 3,
    expectedToolCalls: 2,
    expectedToolOutput: /JQ_SYNTAX_ERROR/
  }, {
    taskId: 'T6',
    turns: [
      toolTurn('call-t6', '.', { type: 'file', path: 'missing.json' }),
      finalTurn(null, 'The required file does not exist.', 'cannot_complete')
    ],
    expectedAnswer: null,
    expectedToolCalls: 1,
    expectedToolOutput: /FILE_NOT_FOUND/
  }];

  for (const scenario of cases) {
    await t.test(scenario.taskId, async t => {
      const repositoryRoot = await mkdtemp(join(tmpdir(), 'stage2b-smoke-'));
      t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
      await cp(resolve('experiments'), join(repositoryRoot, 'experiments'), { recursive: true });
      const model = new ScriptedModel(scenario.turns);

      const record = await runStage2bSmoke({
        repositoryRoot,
        taskId: scenario.taskId,
        apiKey: 'offline-test-key',
        dependencies: {
          createModelClient: () => model,
          connectTools: options => McpToolBridge.connect({
            ...options,
            serverEntrypoint: resolve('dist/src/mcp/server.js')
          })
        }
      });

      assert.equal(record.taskId, scenario.taskId);
      assert.match(record.runId, new RegExp(`^stage2b-${scenario.taskId}-explicit-`));
      assert.equal(record.status, 'completed');
      assert.equal(record.taskSuccess, true);
      assert.equal(record.recoverySuccess, scenario.taskId === 'T7' ? true : null);
      assert.deepEqual(record.finalAnswer?.answer, scenario.expectedAnswer);
      assert.equal(record.toolCalls, scenario.expectedToolCalls);
      assert.match(
        record.toolEvents
          .filter(event => event.type === 'function_call_output')
          .map(event => event.output)
          .join('\n'),
        scenario.expectedToolOutput
      );
      assert.match(
        model.requests[0]?.history[0]?.type === 'message'
          ? model.requests[0].history[0].content
          : '',
        new RegExp(scenario.taskId === 'T6' ? 'missing\\.json' : 'users\\.json')
      );
    });
  }
});

test('runs diagnostic tasks through their isolated task root and real MCP', async t => {
  const scenarios: Array<{
    name: string;
    taskId: 'T9' | 'T10' | 'T11';
    condition: 'explicit' | 'description' | 'skill';
    turns: ModelTurnResult[];
    expectedAnswer: unknown;
    expectedToolCalls: number;
    expectedRecovery: boolean | null;
    expectedToolOutput?: RegExp;
  }> = [{
    name: 'T9 avoids jq for a plain-text answer',
    taskId: 'T9',
    condition: 'explicit',
    turns: [finalTurn(2, 'Counted the two ERROR lines directly.')],
    expectedAnswer: 2,
    expectedToolCalls: 0,
    expectedRecovery: null
  }, {
    name: 'T10 aggregates shipments in one query',
    taskId: 'T10',
    condition: 'description',
    turns: [
      toolTurn(
        'call-t10',
        '.shipments | map(select(.status != "cancelled")) | group_by(.region) | map({region: .[0].region, revenue: (map(.unitPrice * .quantity) | add)}) | sort_by(-.revenue, .region) | .[:2]',
        { type: 'file', path: 'shipments.json' }
      ),
      finalTurn([
        { region: 'east', revenue: 245 },
        { region: 'north', revenue: 180 }
      ], 'Aggregated non-cancelled shipment revenue.')
    ],
    expectedAnswer: [
      { region: 'east', revenue: 245 },
      { region: 'north', revenue: 180 }
    ],
    expectedToolCalls: 1,
    expectedRecovery: null,
    expectedToolOutput: /east.*245.*north.*180/
  }, {
    name: 'T11 inspects the metrics root before querying',
    taskId: 'T11',
    condition: 'skill',
    turns: [
      toolTurn('call-t11-inspect', '.', { type: 'file', path: 'metrics.json' }),
      toolTurn(
        'call-t11-query',
        '.payload.series | map(select(.samples[-1].latencyMs > 200) | .service) | sort',
        { type: 'file', path: 'metrics.json' }
      ),
      finalTurn(['api', 'search'], 'Inspected the root and selected latest high latency samples.')
    ],
    expectedAnswer: ['api', 'search'],
    expectedToolCalls: 2,
    expectedRecovery: null,
    expectedToolOutput: /api.*search/
  }, {
    name: 'T11 recovers from a root-unaware query',
    taskId: 'T11',
    condition: 'explicit',
    turns: [
      toolTurn(
        'call-t11-error',
        '.series | map(select(.samples[-1].latencyMs > 200) | .service) | sort',
        { type: 'file', path: 'metrics.json' }
      ),
      toolTurn(
        'call-t11-retry',
        '.payload.series | map(select(.samples[-1].latencyMs > 200) | .service) | sort',
        { type: 'file', path: 'metrics.json' }
      ),
      finalTurn(['api', 'search'], 'Corrected the query after the runtime error.')
    ],
    expectedAnswer: ['api', 'search'],
    expectedToolCalls: 2,
    expectedRecovery: true,
    expectedToolOutput: /JQ_RUNTIME_ERROR[\s\S]*api.*search/
  }];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async t => {
      const repositoryRoot = await mkdtemp(join(tmpdir(), 'stage2b-diagnostic-smoke-'));
      t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
      await cp(resolve('experiments'), join(repositoryRoot, 'experiments'), { recursive: true });
      const model = new ScriptedModel(scenario.turns);

      const record = await runStage2bSmoke({
        repositoryRoot,
        taskId: scenario.taskId,
        condition: scenario.condition,
        apiKey: 'offline-test-key',
        dependencies: {
          createModelClient: () => model,
          connectTools: options => McpToolBridge.connect({
            ...options,
            serverEntrypoint: resolve('dist/src/mcp/server.js')
          })
        }
      });

      assert.equal(record.status, 'completed');
      assert.equal(record.taskSuccess, true);
      assert.equal(record.recoverySuccess, scenario.expectedRecovery);
      assert.deepEqual(record.finalAnswer?.answer, scenario.expectedAnswer);
      assert.equal(record.toolCalls, scenario.expectedToolCalls);
      if (scenario.expectedToolOutput) {
        assert.match(record.toolEvents
          .filter(event => event.type === 'function_call_output')
          .map(event => event.output)
          .join('\n'), scenario.expectedToolOutput);
      }
      const firstRequest = model.requests[0];
      assert.ok(firstRequest);
      const input = firstRequest.history[0]?.type === 'message'
        ? firstRequest.history[0].content
        : '';
      assert.doesNotMatch(input, /experiments\/stage-2[ab]|fixtures\//);
      if (scenario.condition === 'description') {
        assert.doesNotMatch(input, /Use the `jq_query` tool|Do not call/i);
      }
      if (scenario.condition === 'skill') {
        assert.match(firstRequest.instructions, /Reference skill: jq-query/);
        assert.doesNotMatch(input, /Use the `jq_query` tool|Do not call/i);
      }
    });
  }
});

test('does not count a correct T7 answer without the required recovery path', async t => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'stage2b-smoke-'));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  await cp(resolve('experiments'), join(repositoryRoot, 'experiments'), { recursive: true });

  const record = await runStage2bSmoke({
    repositoryRoot,
    taskId: 'T7',
    condition: 'description',
    apiKey: 'offline-test-key',
    dependencies: {
      createModelClient: () => new ScriptedModel([
        finalTurn(3, 'Returned the expected count without calling jq.')
      ]),
      connectTools: options => McpToolBridge.connect({
        ...options,
        serverEntrypoint: resolve('dist/src/mcp/server.js')
      })
    }
  });

  assert.equal(record.taskSuccess, true);
  assert.equal(record.recoverySuccess, false);
});

test('does not count a same-turn successful jq call as recovery from an unobserved error', async t => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'stage2b-same-turn-'));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  await cp(resolve('experiments'), join(repositoryRoot, 'experiments'), { recursive: true });

  const record = await runStage2bSmoke({
    repositoryRoot,
    taskId: 'T11',
    apiKey: 'offline-test-key',
    dependencies: {
      createModelClient: () => new ScriptedModel([
        multiToolTurn([
          {
            callId: 'same-turn-error',
            filter: '.series | map(.service)',
            source: { type: 'file', path: 'metrics.json' }
          }, {
            callId: 'same-turn-success',
            filter: '.payload.series | map(select(.samples[-1].latencyMs > 200) | .service) | sort',
            source: { type: 'file', path: 'metrics.json' }
          }
        ]),
        finalTurn(['api', 'search'], 'The second same-turn query returned the expected answer.')
      ]),
      connectTools: options => McpToolBridge.connect({
        ...options,
        serverEntrypoint: resolve('dist/src/mcp/server.js')
      })
    }
  });

  assert.equal(record.taskSuccess, true);
  assert.equal(record.toolCalls, 2);
  assert.equal(record.recoverySuccess, false);
  assert.equal(analyzeStage2bProcess(record).strategy, 'unresolved');
});

test('keeps description and versioned skill treatment inputs isolated', async t => {
  const firstRequests = new Map<'description' | 'skill-v1' | 'skill-v2', ModelTurnRequest>();
  const records = new Map<'description' | 'skill-v1' | 'skill-v2', Stage2bRecord>();
  for (const condition of ['description', 'skill-v1', 'skill-v2'] as const) {
    await t.test(condition, async t => {
      const repositoryRoot = await mkdtemp(join(tmpdir(), 'stage2b-smoke-'));
      t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
      await cp(resolve('experiments'), join(repositoryRoot, 'experiments'), { recursive: true });
      const model = new ScriptedModel([
        toolTurn('call-t2', '.users[] | select(.active) | .name', {
          type: 'file', path: 'users.json'
        }),
        finalTurn(['Alice', 'Carol', 'Dave'], 'Read active users from the file.')
      ]);

      const record = await runStage2bSmoke({
        repositoryRoot,
        taskId: 'T2',
        condition,
        apiKey: 'offline-test-key',
        dependencies: {
          createModelClient: () => model,
          connectTools: options => McpToolBridge.connect({
            ...options,
            serverEntrypoint: resolve('dist/src/mcp/server.js')
          })
        }
      });

      const request = model.requests[0];
      assert.ok(request);
      firstRequests.set(condition, request);
      records.set(condition, record);
      assert.equal(record.condition, condition);
      assert.match(record.runId, new RegExp(`^stage2b-T2-${condition}-`));
      assert.equal(record.taskSuccess, true);
      assert.doesNotMatch(request?.history[0]?.type === 'message'
        ? request.history[0].content
        : '', /Use the `jq_query` tool/);
      if (condition === 'skill-v1' || condition === 'skill-v2') {
        assert.match(request?.instructions ?? '', /Reference skill: jq-query/);
        assert.match(request?.instructions ?? '', /# jq Query/);
        assert.match(request?.instructions ?? '', /JQ_SYNTAX_ERROR/);
      } else {
        assert.doesNotMatch(request?.instructions ?? '', /Reference skill|# jq Query|JQ_SYNTAX_ERROR/);
      }
    });
  }

  const description = firstRequests.get('description');
  const skillV1 = firstRequests.get('skill-v1');
  const skillV2 = firstRequests.get('skill-v2');
  assert.ok(description);
  assert.ok(skillV1);
  assert.ok(skillV2);
  for (const skill of [skillV1, skillV2]) {
    assert.deepEqual(skill.history, description.history);
    assert.deepEqual(skill.tools, description.tools);
    assert.deepEqual(skill.outputSchema, description.outputSchema);
  }
  assert.doesNotMatch(skillV1.instructions, /Source gate/);
  assert.match(skillV2.instructions, /Source gate/);
  assert.equal(records.get('description')?.version, 1);
  assert.equal(records.get('skill-v1')?.skill?.version, 'v1');
  assert.equal(records.get('skill-v2')?.skill?.version, 'v2');
  assert.notEqual(records.get('skill-v1')?.skill?.sha256, records.get('skill-v2')?.skill?.sha256);
});

test('accepts smoke for the supported representative task set', () => {
  assert.deepEqual(parseStage2bArgs(['smoke']), {
    mode: 'smoke', taskId: 'T1', condition: 'explicit'
  });
  for (const taskId of [
    'T1', 'T2', 'T6', 'T7', 'T9', 'T10', 'T11', 'T12', 'T13', 'T14', 'T15', 'T16', 'T17',
    'T18', 'T19', 'T20', 'T21', 'T22', 'T23'
  ] as const) {
    assert.deepEqual(parseStage2bArgs(['smoke', '--task', taskId]), {
      mode: 'smoke', taskId, condition: 'explicit'
    });
  }
  for (const condition of ['explicit', 'description', 'skill', 'skill-v1', 'skill-v2'] as const) {
    assert.deepEqual(parseStage2bArgs(['smoke', '--condition', condition]), {
      mode: 'smoke', taskId: 'T1', condition
    });
  }
  assert.deepEqual(
    parseStage2bArgs(['smoke', '--condition', 'skill-v2', '--task', 'T17']),
    { mode: 'smoke', taskId: 'T17', condition: 'skill-v2' }
  );
  assert.throws(() => parseStage2bArgs([]), /smoke/);
  assert.throws(() => parseStage2bArgs(['smoke', '--extra']), /smoke/);
  assert.throws(() => parseStage2bArgs(['smoke', '--task']), /task/i);
  assert.throws(() => parseStage2bArgs(['smoke', '--task', 'T3']), /task/i);
  assert.throws(() => parseStage2bArgs(['smoke', '--condition']), /condition/i);
  assert.throws(() => parseStage2bArgs(['smoke', '--condition', 'unknown']), /condition/i);
  assert.throws(
    () => parseStage2bArgs(['smoke', '--condition', 'skill', '--condition', 'description']),
    /condition/i
  );
  assert.throws(() => parseStage2bArgs(['formal']), /smoke/);
});

test('accepts suite-aware bounded repetition arguments for offline plans', () => {
  assert.deepEqual(parseStage2bArgs(['plan']), {
    mode: 'plan', suite: 'baseline-v1', repetitions: 1
  });
  assert.deepEqual(
    parseStage2bArgs(['plan', '--repetitions', '3']),
    { mode: 'plan', suite: 'baseline-v1', repetitions: 3 }
  );
  assert.deepEqual(
    parseStage2bArgs(['plan', '--suite', 'diagnostic-v1']),
    { mode: 'plan', suite: 'diagnostic-v1', repetitions: 1 }
  );
  assert.deepEqual(
    parseStage2bArgs(['plan', '--suite', 'boundary-v1']),
    { mode: 'plan', suite: 'boundary-v1', repetitions: 1 }
  );
  assert.deepEqual(
    parseStage2bArgs(['plan', '--suite', 'complexity-v1']),
    { mode: 'plan', suite: 'complexity-v1', repetitions: 1 }
  );
  assert.throws(
    () => parseStage2bArgs(['plan', '--suite', 'complexity-v1', '--repetitions', '2']),
    /complexity.*one|repetition/i
  );
  for (const argv of [
    ['plan', '--repetitions'],
    ['plan', '--repetitions', '0'],
    ['plan', '--repetitions', '1.5'],
    ['plan', '--repetitions', '101'],
    ['plan', '--unknown', '2'],
    ['plan', '--repetitions', '2', '--repetitions', '3'],
    ['plan', '--suite', 'unknown-v1'],
    ['plan', '--suite', 'baseline-v1', '--suite', 'diagnostic-v1'],
    ['plan', '--suite', 'baseline-v1', '--repetitions']
  ]) {
    assert.throws(() => parseStage2bArgs(argv), /plan|repetitions/i);
  }
});

test('accepts suite-aware bounded repetition arguments for batch preparation', () => {
  assert.deepEqual(parseStage2bArgs(['prepare']), {
    mode: 'prepare', suite: 'baseline-v1', repetitions: 1
  });
  assert.deepEqual(
    parseStage2bArgs(['prepare', '--repetitions', '3']),
    { mode: 'prepare', suite: 'baseline-v1', repetitions: 3 }
  );
  assert.deepEqual(
    parseStage2bArgs(['prepare', '--repetitions', '2', '--suite', 'diagnostic-v1']),
    { mode: 'prepare', suite: 'diagnostic-v1', repetitions: 2 }
  );
  assert.deepEqual(
    parseStage2bArgs(['prepare', '--suite', 'complexity-v1']),
    { mode: 'prepare', suite: 'complexity-v1', repetitions: 1 }
  );
  assert.throws(
    () => parseStage2bArgs(['prepare', '--suite', 'complexity-v1', '--repetitions', '2']),
    /complexity.*one|repetition/i
  );
  assert.deepEqual(
    parseStage2bArgs([
      'prepare',
      '--suite', 'boundary-v1',
      '--repetitions', '2',
      '--initial-batch', 'stage2b-batch-boundary-initial'
    ]),
    {
      mode: 'prepare',
      suite: 'boundary-v1',
      repetitions: 2,
      initialBatchId: 'stage2b-batch-boundary-initial'
    }
  );
  for (const argv of [
    ['prepare', '--repetitions'],
    ['prepare', '--repetitions', '0'],
    ['prepare', '--repetitions', '101'],
    ['prepare', '--unknown', '2'],
    ['prepare', '--suite', 'unknown-v1'],
    ['prepare', '--suite', 'boundary-v1', '--repetitions', '2'],
    ['prepare', '--suite', 'boundary-v1', '--initial-batch', 'stage2b-batch-boundary-initial'],
    ['prepare', '--initial-batch', 'stage2b-batch-boundary-initial'],
    ['prepare', '--suite', 'baseline-v1', '--suite', 'diagnostic-v1'],
    ['prepare', '--suite', 'diagnostic-v1', '--repetitions']
  ]) {
    assert.throws(() => parseStage2bArgs(argv), /prepare|repetitions/i);
  }
});

test('requires a verified initial gate before preparing boundary confirmation repetitions', async t => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'stage2b-boundary-repeat-gate-'));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  await cp(resolve('experiments'), join(repositoryRoot, 'experiments'), { recursive: true });

  await assert.rejects(prepareStage2bBatch({
    repositoryRoot,
    suite: 'boundary-v1',
    repetitions: 2,
    createdAt: new Date('2026-08-13T11:00:00.000Z')
  }), /initial batch/i);
});

test('refuses direct preparation of repeated complexity calibration batches', async t => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'stage2b-complexity-repetitions-'));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));

  await assert.rejects(prepareStage2bBatch({
    repositoryRoot,
    suite: 'complexity-v1',
    repetitions: 2,
    createdAt: new Date('2026-08-14T08:00:00.000Z')
  }), /complexity.*one|repetition/i);
});

test('builds skill instructions from the already verified contents', () => {
  const instructions = buildStage2bInstructions('skill-v2', '# verified skill\n');

  assert.match(instructions, /Reference skill: jq-query/);
  assert.match(instructions, /# verified skill/);
  assert.doesNotMatch(instructions, /# changed later/);
  assert.throws(() => buildStage2bInstructions('skill-v2'), /contents/i);
});

test('accepts only one safe batch ID for run-next', () => {
  assert.deepEqual(
    parseStage2bArgs(['run-next', '--batch', 'stage2b-batch-20260811T080000000Z-a1b2c3d4']),
    { mode: 'run-next', batchId: 'stage2b-batch-20260811T080000000Z-a1b2c3d4' }
  );
  for (const argv of [
    ['run-next'],
    ['run-next', '--batch'],
    ['run-next', '--batch', '../escape'],
    ['run-next', '--batch', 'other-batch'],
    ['run-next', '--unknown', 'stage2b-batch-safe']
  ]) {
    assert.throws(() => parseStage2bArgs(argv), /run-next|batch/i);
  }
});

test('renders the T2 and T7 condition matrix without credentials or side effects', async t => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'stage2b-plan-'));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  let output = '';

  const exitCode = await main(['plan', '--repetitions', '2'], {
    repositoryRoot,
    env: {},
    writeOutput: text => { output += text; },
    dependencies: {
      createModelClient: () => { throw new Error('plan must not create a model client'); },
      connectTools: async () => { throw new Error('plan must not connect MCP tools'); }
    }
  });

  assert.equal(exitCode, 0);
  const plan = JSON.parse(output) as {
    version: number;
    mode: string;
    suite: string;
    tasks: string[];
    conditions: string[];
    repetitions: number;
    totalRuns: number;
    requiresApiKey: boolean;
    sampling: { temperature: number | null };
    upperBounds: { modelRequests: number; toolCalls: number };
    runs: Array<{ taskId: string; condition: string; repetition: number }>;
  };
  assert.deepEqual({
    version: plan.version,
    mode: plan.mode,
    suite: plan.suite,
    tasks: plan.tasks,
    conditions: plan.conditions,
    repetitions: plan.repetitions,
    totalRuns: plan.totalRuns,
    requiresApiKey: plan.requiresApiKey,
    sampling: plan.sampling,
    upperBounds: plan.upperBounds
  }, {
    version: 2,
    mode: 'plan',
    suite: 'baseline-v1',
    tasks: ['T2', 'T7'],
    conditions: ['explicit', 'description', 'skill'],
    repetitions: 2,
    totalRuns: 12,
    requiresApiKey: false,
    sampling: { temperature: 0 },
    upperBounds: { modelRequests: 72, toolCalls: 60 }
  });
  assert.deepEqual(plan.runs.slice(0, 4), [
    { taskId: 'T2', condition: 'explicit', repetition: 1 },
    { taskId: 'T2', condition: 'explicit', repetition: 2 },
    { taskId: 'T2', condition: 'description', repetition: 1 },
    { taskId: 'T2', condition: 'description', repetition: 2 }
  ]);
  assert.deepEqual(plan.runs.slice(-2), [
    { taskId: 'T7', condition: 'skill', repetition: 1 },
    { taskId: 'T7', condition: 'skill', repetition: 2 }
  ]);
  await assert.rejects(lstat(join(repositoryRoot, '.experiment-runs')), { code: 'ENOENT' });
});

test('prepares a private pending batch manifest without credentials or tool connections', async t => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'stage2b-prepare-'));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  let output = '';

  const exitCode = await main(['prepare', '--repetitions', '2'], {
    repositoryRoot,
    env: {},
    writeOutput: text => { output += text; },
    dependencies: {
      createModelClient: () => { throw new Error('prepare must not create a model client'); },
      connectTools: async () => { throw new Error('prepare must not connect MCP tools'); },
      now: () => new Date('2026-08-11T08:00:00.000Z')
    }
  });

  assert.equal(exitCode, 0);
  const summary = JSON.parse(output) as {
    batchId: string;
    suite: string;
    totalRuns: number;
    pendingRuns: number;
    manifestPath: string;
  };
  assert.match(summary.batchId, /^stage2b-batch-20260811T080000000Z-[a-f0-9]{8}$/);
  assert.equal(summary.suite, 'baseline-v1');
  assert.equal(summary.totalRuns, 12);
  assert.equal(summary.pendingRuns, 12);
  assert.equal(
    summary.manifestPath,
    join(repositoryRoot, '.experiment-runs/stage-2b/batches', summary.batchId, 'manifest.json')
  );

  const manifest = JSON.parse(await readFile(summary.manifestPath, 'utf8')) as {
    version: number;
    suite: string;
    batchId: string;
    createdAt: string;
    provider: string;
    model: string;
    thinking: string;
    sampling: { temperature: number | null };
    repetitions: number;
    totalRuns: number;
    limits: Record<string, number>;
    runs: Array<{
      runKey: string;
      taskId: string;
      condition: string;
      repetition: number;
      status: string;
    }>;
  };
  assert.deepEqual({
    version: manifest.version,
    suite: manifest.suite,
    batchId: manifest.batchId,
    createdAt: manifest.createdAt,
    provider: manifest.provider,
    model: manifest.model,
    thinking: manifest.thinking,
    sampling: manifest.sampling,
    repetitions: manifest.repetitions,
    totalRuns: manifest.totalRuns,
    limits: manifest.limits
  }, {
    version: 2,
    suite: 'baseline-v1',
    batchId: summary.batchId,
    createdAt: '2026-08-11T08:00:00.000Z',
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    thinking: 'none',
    sampling: { temperature: 0 },
    repetitions: 2,
    totalRuns: 12,
    limits: {
      maxTurns: 6,
      maxToolCalls: 5,
      requestTimeoutMs: 60_000,
      totalTimeoutMs: 120_000
    }
  });
  assert.equal(new Set(manifest.runs.map(run => run.runKey)).size, 12);
  assert.ok(manifest.runs.every(run => run.status === 'pending'));
  assert.deepEqual(manifest.runs.slice(0, 2), [{
    runKey: 'T2-explicit-r1',
    taskId: 'T2',
    condition: 'explicit',
    repetition: 1,
    status: 'pending'
  }, {
    runKey: 'T2-explicit-r2',
    taskId: 'T2',
    condition: 'explicit',
    repetition: 2,
    status: 'pending'
  }]);
  assert.equal((await lstat(join(repositoryRoot, '.experiment-runs'))).mode & 0o777, 0o700);
  assert.equal((await lstat(join(repositoryRoot, '.experiment-runs/stage-2b/batches'))).mode & 0o777, 0o700);
  assert.equal((await lstat(summary.manifestPath)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(join(summary.manifestPath, '..')), ['manifest.json']);
  assert.doesNotMatch(JSON.stringify(manifest), /API_KEY|Authorization|Bearer|\/(?:home|Users)\//i);
});

test('writes version 2 diagnostic manifests and maps version 1 manifests to baseline', async t => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'stage2b-manifest-version-'));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));

  let diagnosticOutput = '';
  await main(['prepare', '--suite', 'diagnostic-v1'], {
    repositoryRoot,
    writeOutput: text => { diagnosticOutput += text; },
    dependencies: { now: () => new Date('2026-08-11T08:00:00.000Z') }
  });
  const diagnosticSummary = JSON.parse(diagnosticOutput) as {
    batchId: string;
    suite: string;
    manifestPath: string;
  };
  const diagnostic = await readStage2bBatchManifest(repositoryRoot, diagnosticSummary.batchId);

  assert.equal(diagnosticSummary.suite, 'diagnostic-v1');
  assert.equal(diagnostic.manifest.version, 2);
  assert.equal(stage2bManifestSuite(diagnostic.manifest), 'diagnostic-v1');
  assert.deepEqual(diagnostic.manifest.runs.map(run => run.runKey), [
    'T9-explicit-r1', 'T10-description-r1', 'T11-skill-r1',
    'T9-description-r1', 'T10-skill-r1', 'T11-explicit-r1',
    'T9-skill-r1', 'T10-explicit-r1', 'T11-description-r1'
  ]);

  let baselineOutput = '';
  await main(['prepare'], {
    repositoryRoot,
    writeOutput: text => { baselineOutput += text; },
    dependencies: { now: () => new Date('2026-08-11T08:00:01.000Z') }
  });
  const baselineSummary = JSON.parse(baselineOutput) as {
    batchId: string;
    manifestPath: string;
  };
  const legacy = JSON.parse(await readFile(baselineSummary.manifestPath, 'utf8')) as Record<string, unknown>;
  legacy.version = 1;
  delete legacy.suite;
  await writeFile(baselineSummary.manifestPath, `${JSON.stringify(legacy, null, 2)}\n`, 'utf8');

  const loadedLegacy = await readStage2bBatchManifest(repositoryRoot, baselineSummary.batchId);
  assert.equal(loadedLegacy.manifest.version, 1);
  assert.equal(stage2bManifestSuite(loadedLegacy.manifest), 'baseline-v1');
  assert.equal('suite' in loadedLegacy.manifest, false);

  const claimed = await claimNextStage2bBatchRun({
    repositoryRoot,
    batchId: baselineSummary.batchId,
    claimedAt: new Date('2026-08-11T08:01:00.000Z')
  });
  assert.ok(claimed.run);
  const record = completedBatchRecord(claimed.run.recordRunId);
  await writeStage2bRecord(repositoryRoot, record);
  await recordStage2bBatchRun({
    repositoryRoot,
    batchId: baselineSummary.batchId,
    runKey: claimed.run.runKey,
    record
  });
  const persistedLegacy = JSON.parse(await readFile(baselineSummary.manifestPath, 'utf8')) as {
    version: number;
    suite?: string;
  };
  assert.equal(persistedLegacy.version, 1);
  assert.equal('suite' in persistedLegacy, false);
});

test('writes a version 3 boundary manifest with fixed skill hashes and 18 balanced runs', async t => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'stage2b-boundary-manifest-'));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  await cp(resolve('experiments'), join(repositoryRoot, 'experiments'), { recursive: true });
  let output = '';

  const exitCode = await main(['prepare', '--suite', 'boundary-v1'], {
    repositoryRoot,
    env: {},
    writeOutput: text => { output += text; },
    dependencies: {
      createModelClient: () => { throw new Error('prepare must not create a model client'); },
      connectTools: async () => { throw new Error('prepare must not connect MCP tools'); },
      now: () => new Date('2026-08-13T10:00:00.000Z')
    }
  });

  assert.equal(exitCode, 0);
  const summary = JSON.parse(output) as { batchId: string; manifestPath: string; totalRuns: number };
  assert.equal(summary.totalRuns, 18);
  const loaded = await readStage2bBatchManifest(repositoryRoot, summary.batchId);
  assert.equal(loaded.manifest.version, 3);
  assert.equal(stage2bManifestSuite(loaded.manifest), 'boundary-v1');
  if (loaded.manifest.version !== 3) assert.fail('Expected boundary manifest version 3.');
  assert.equal(loaded.manifest.skills.v1.version, 'v1');
  assert.equal(loaded.manifest.skills.v2.version, 'v2');
  assert.match(loaded.manifest.skills.v1.sha256, /^[a-f0-9]{64}$/);
  assert.match(loaded.manifest.skills.v2.sha256, /^[a-f0-9]{64}$/);
  assert.notEqual(loaded.manifest.skills.v1.sha256, loaded.manifest.skills.v2.sha256);
  assert.deepEqual(loaded.manifest.runs.slice(0, 6).map(run => run.runKey), [
    'T12-description-r1', 'T13-skill-v1-r1', 'T14-skill-v2-r1',
    'T15-description-r1', 'T16-skill-v1-r1', 'T17-skill-v2-r1'
  ]);

  const firstClaim = await claimNextStage2bBatchRun({
    repositoryRoot,
    batchId: summary.batchId,
    claimedAt: new Date('2026-08-13T10:01:00.000Z')
  });
  assert.ok(firstClaim.run);
  const legacyDescriptionRecord: Stage2bRecord = {
    ...completedBatchRecord(firstClaim.run.recordRunId),
    taskId: firstClaim.run.taskId,
    condition: firstClaim.run.condition,
    limits: { ...loaded.manifest.limits }
  };
  await assert.rejects(recordStage2bBatchRun({
    repositoryRoot,
    batchId: summary.batchId,
    runKey: firstClaim.run.runKey,
    record: legacyDescriptionRecord
  }), /skill identity/i);
  await recordStage2bBatchRun({
    repositoryRoot,
    batchId: summary.batchId,
    runKey: firstClaim.run.runKey,
    record: { ...legacyDescriptionRecord, version: 2, skill: null }
  });

  const secondClaim = await claimNextStage2bBatchRun({
    repositoryRoot,
    batchId: summary.batchId,
    claimedAt: new Date('2026-08-13T10:02:00.000Z')
  });
  assert.ok(secondClaim.run);
  const wrongSkillRecord: Stage2bRecord = {
    ...completedBatchRecord(secondClaim.run.recordRunId),
    version: 2,
    taskId: secondClaim.run.taskId,
    condition: secondClaim.run.condition,
    skill: { version: 'v1', sha256: 'f'.repeat(64) },
    limits: { ...loaded.manifest.limits }
  };
  await assert.rejects(recordStage2bBatchRun({
    repositoryRoot,
    batchId: summary.batchId,
    runKey: secondClaim.run.runKey,
    record: wrongSkillRecord
  }), /skill identity/i);
  await recordStage2bBatchRun({
    repositoryRoot,
    batchId: summary.batchId,
    runKey: secondClaim.run.runKey,
    record: { ...wrongSkillRecord, skill: loaded.manifest.skills.v1 }
  });
});

test('rejects manifests whose version, suite, and run order disagree', async t => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'stage2b-invalid-manifest-'));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  let output = '';
  await main(['prepare', '--suite', 'diagnostic-v1', '--repetitions', '2'], {
    repositoryRoot,
    writeOutput: text => { output += text; },
    dependencies: { now: () => new Date('2026-08-11T08:00:00.000Z') }
  });
  const { batchId, manifestPath } = JSON.parse(output) as {
    batchId: string;
    manifestPath: string;
  };
  const valid = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    version: number;
    suite?: string;
    runs: Array<{ repetition: number }>;
  };

  const version1WithDiagnosticTasks = { ...valid, version: 1 };
  delete version1WithDiagnosticTasks.suite;
  await writeFile(manifestPath, `${JSON.stringify(version1WithDiagnosticTasks, null, 2)}\n`);
  await assert.rejects(
    readStage2bBatchManifest(repositoryRoot, batchId),
    /batch (?:size|plan) mismatch/i
  );

  const version2WithoutSuite = { ...valid };
  delete version2WithoutSuite.suite;
  await writeFile(manifestPath, `${JSON.stringify(version2WithoutSuite, null, 2)}\n`);
  await assert.rejects(readStage2bBatchManifest(repositoryRoot, batchId));

  const cellMajorRuns = [
    ...valid.runs.filter(run => run.repetition === 1).flatMap((run, index) => [
      run,
      valid.runs.filter(candidate => candidate.repetition === 2)[index]
    ])
  ];
  await writeFile(manifestPath, `${JSON.stringify({ ...valid, runs: cellMajorRuns }, null, 2)}\n`);
  await assert.rejects(readStage2bBatchManifest(repositoryRoot, batchId), /batch plan mismatch/i);
});

test('refuses to prepare a batch through a symlinked batches directory', async t => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'stage2b-prepare-'));
  const outside = await mkdtemp(join(tmpdir(), 'stage2b-outside-'));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await mkdir(join(repositoryRoot, '.experiment-runs/stage-2b'), { recursive: true });
  await symlink(outside, join(repositoryRoot, '.experiment-runs/stage-2b/batches'), 'dir');

  await assert.rejects(main(['prepare'], {
    repositoryRoot,
    env: {},
    dependencies: { now: () => new Date('2026-08-11T08:00:00.000Z') }
  }), /unsafe.*batch/i);
  assert.deepEqual(await readdir(outside), []);
});

test('normalizes a legacy batch without sampling metadata to provider defaults', async t => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'stage2b-legacy-batch-'));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  let prepareOutput = '';
  await main(['prepare'], {
    repositoryRoot,
    writeOutput: text => { prepareOutput += text; },
    dependencies: { now: () => new Date('2026-08-11T08:00:00.000Z') }
  });
  const { batchId, manifestPath } = JSON.parse(prepareOutput) as {
    batchId: string;
    manifestPath: string;
  };
  const legacy = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  legacy.version = 1;
  delete legacy.suite;
  delete legacy.sampling;
  legacy.limits = {
    maxTurns: 5,
    maxToolCalls: 4,
    requestTimeoutMs: 60_000,
    totalTimeoutMs: 120_000
  };
  await writeFile(manifestPath, `${JSON.stringify(legacy, null, 2)}\n`, 'utf8');

  const loaded = await readStage2bBatchManifest(repositoryRoot, batchId) as unknown as {
    manifest: {
      sampling: { temperature: number | null };
      limits: Record<string, number>;
    };
  };

  assert.deepEqual(loaded.manifest.sampling, { temperature: null });
  assert.deepEqual(loaded.manifest.limits, legacy.limits);
});

test('serializes concurrent claims for the same Stage 2B batch', async t => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'stage2b-claim-'));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  let prepareOutput = '';
  await main(['prepare'], {
    repositoryRoot,
    writeOutput: text => { prepareOutput += text; },
    dependencies: { now: () => new Date('2026-08-11T08:00:00.000Z') }
  });
  const { batchId, manifestPath } = JSON.parse(prepareOutput) as {
    batchId: string;
    manifestPath: string;
  };

  const results = await Promise.allSettled([
    claimNextStage2bBatchRun({
      repositoryRoot,
      batchId,
      claimedAt: new Date('2026-08-11T08:01:00.000Z')
    }),
    claimNextStage2bBatchRun({
      repositoryRoot,
      batchId,
      claimedAt: new Date('2026-08-11T08:01:00.001Z')
    })
  ]);

  const fulfilled = results.filter(result => result.status === 'fulfilled');
  const rejected = results.filter(result => result.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.match(String(rejected[0]?.reason), /batch.*(?:busy|running)/i);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    runs: Array<{ status: string }>;
  };
  assert.equal(manifest.runs.filter(run => run.status === 'running').length, 1);
  assert.deepEqual(await readdir(join(manifestPath, '..')), ['manifest.json']);
});

test('run-next records one model-behavior failure as a completed observation', async t => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'stage2b-run-next-'));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  await cp(resolve('experiments'), join(repositoryRoot, 'experiments'), { recursive: true });
  let prepareOutput = '';
  await main(['prepare'], {
    repositoryRoot,
    writeOutput: text => { prepareOutput += text; },
    dependencies: { now: () => new Date('2026-08-11T08:00:00.000Z') }
  });
  const { batchId, manifestPath } = JSON.parse(prepareOutput) as {
    batchId: string;
    manifestPath: string;
  };
  let modelRequests = 0;
  let observedClaim: Record<string, unknown> | undefined;
  const model: ModelTurnClient = {
    async createTurn() {
      modelRequests += 1;
      const current = JSON.parse(await readFile(manifestPath, 'utf8')) as {
        runs: Array<Record<string, unknown>>;
      };
      observedClaim = current.runs[0];
      return finalTurn(['incorrect'], 'Returned an incorrect answer without calling the tool.');
    }
  };
  const times = [
    new Date('2026-08-11T08:01:00.000Z'),
    new Date('2026-08-11T08:01:00.100Z')
  ];
  let output = '';

  const exitCode = await main(['run-next', '--batch', batchId], {
    repositoryRoot,
    env: { DEEPSEEK_API_KEY: 'offline-test-key' },
    writeOutput: text => { output += text; },
    dependencies: {
      createModelClient: () => model,
      connectTools: options => McpToolBridge.connect({
        ...options,
        serverEntrypoint: resolve('dist/src/mcp/server.js')
      }),
      now: () => times.shift() ?? new Date('2026-08-11T08:01:00.100Z')
    }
  });

  assert.equal(exitCode, 0);
  const summary = JSON.parse(output) as {
    batchId: string;
    runKey: string;
    status: string;
    recordRunId: string;
    recordPath: string;
    taskSuccess: boolean | null;
    recoverySuccess: boolean | null;
    remainingPending: number;
  };
  assert.equal(summary.batchId, batchId);
  assert.equal(summary.runKey, 'T2-explicit-r1');
  assert.equal(summary.status, 'completed');
  assert.equal(summary.taskSuccess, false);
  assert.equal(summary.recoverySuccess, null);
  assert.equal(summary.remainingPending, 5);
  assert.match(summary.recordRunId, /^stage2b-T2-explicit-/);
  assert.equal((await lstat(summary.recordPath)).mode & 0o777, 0o600);
  const record = JSON.parse(await readFile(summary.recordPath, 'utf8')) as {
    sampling?: { temperature: number | null };
  };
  assert.deepEqual(record.sampling, { temperature: 0 });
  assert.equal(modelRequests, 1);
  assert.deepEqual(observedClaim, {
    runKey: 'T2-explicit-r1',
    taskId: 'T2',
    condition: 'explicit',
    repetition: 1,
    status: 'running',
    recordRunId: summary.recordRunId
  });

  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    runs: Array<Record<string, unknown>>;
  };
  assert.deepEqual(manifest.runs[0], {
    runKey: 'T2-explicit-r1',
    taskId: 'T2',
    condition: 'explicit',
    repetition: 1,
    status: 'completed',
    recordRunId: summary.recordRunId,
    recordStatus: 'completed',
    taskSuccess: false,
    recoverySuccess: null
  });
  assert.equal(manifest.runs[1]?.status, 'pending');
  assert.deepEqual(
    (await readdir(join(manifestPath, '..'))).filter(name => name.includes('.tmp')),
    []
  );
});

test('run-next records a setup failure as failed without creating a model client', async t => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'stage2b-run-next-'));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  let prepareOutput = '';
  await main(['prepare'], {
    repositoryRoot,
    writeOutput: text => { prepareOutput += text; },
    dependencies: { now: () => new Date('2026-08-11T08:00:00.000Z') }
  });
  const { batchId, manifestPath } = JSON.parse(prepareOutput) as {
    batchId: string;
    manifestPath: string;
  };
  const legacyManifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    limits: Record<string, number>;
  };
  legacyManifest.limits = {
    maxTurns: 5,
    maxToolCalls: 4,
    requestTimeoutMs: 60_000,
    totalTimeoutMs: 120_000
  };
  await writeFile(manifestPath, `${JSON.stringify(legacyManifest, null, 2)}\n`, 'utf8');
  const times = [
    new Date('2026-08-11T08:01:00.000Z'),
    new Date('2026-08-11T08:01:00.025Z')
  ];
  let output = '';

  const exitCode = await main(['run-next', '--batch', batchId], {
    repositoryRoot,
    env: {},
    writeOutput: text => { output += text; },
    dependencies: {
      createModelClient: () => { throw new Error('missing-key run must not create a model'); },
      connectTools: async () => { throw new Error('missing-key run must not connect tools'); },
      now: () => times.shift() ?? new Date('2026-08-11T08:01:00.025Z')
    }
  });

  assert.equal(exitCode, 1);
  const summary = JSON.parse(output) as {
    runKey: string;
    status: string;
    recordStatus: string;
    remainingPending: number;
  };
  assert.deepEqual(summary, {
    batchId,
    runKey: 'T2-explicit-r1',
    status: 'failed',
    recordRunId: (JSON.parse(await readFile(manifestPath, 'utf8')) as {
      runs: Array<{ recordRunId?: string }>;
    }).runs[0]?.recordRunId,
    recordStatus: 'infrastructure-error',
    taskSuccess: null,
    recoverySuccess: null,
    remainingPending: 5,
    manifestPath,
    recordPath: join(
      repositoryRoot,
      '.experiment-runs/stage-2b',
      (JSON.parse(await readFile(manifestPath, 'utf8')) as {
        runs: Array<{ recordRunId?: string }>;
      }).runs[0]?.recordRunId ?? '',
      'record.json'
    )
  });
  const recordPath = (JSON.parse(output) as { recordPath: string }).recordPath;
  const record = JSON.parse(await readFile(recordPath, 'utf8')) as {
    limits: Record<string, number>;
  };
  assert.deepEqual(record.limits, legacyManifest.limits);
});

test('run-next reconciles an existing record without starting another paid run', async t => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'stage2b-reconcile-'));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  let prepareOutput = '';
  await main(['prepare'], {
    repositoryRoot,
    writeOutput: text => { prepareOutput += text; },
    dependencies: { now: () => new Date('2026-08-11T08:00:00.000Z') }
  });
  const { batchId, manifestPath } = JSON.parse(prepareOutput) as {
    batchId: string;
    manifestPath: string;
  };
  const recordRunId = 'stage2b-T2-explicit-20260811T080100000Z-recovery01';
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    runs: Array<Record<string, unknown>>;
  };
  manifest.runs[0] = {
    runKey: 'T2-explicit-r1',
    taskId: 'T2',
    condition: 'explicit',
    repetition: 1,
    status: 'running',
    recordRunId
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeStage2bRecord(repositoryRoot, completedBatchRecord(recordRunId));
  let output = '';

  const exitCode = await main(['run-next', '--batch', batchId], {
    repositoryRoot,
    env: new Proxy({}, {
      get: () => { throw new Error('reconciliation must not read the API key'); }
    }),
    writeOutput: text => { output += text; },
    dependencies: {
      createModelClient: () => { throw new Error('reconciliation must not create a model'); },
      connectTools: async () => { throw new Error('reconciliation must not connect tools'); }
    }
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(JSON.parse(output), {
    batchId,
    status: 'reconciled',
    recoveredRunKeys: ['T2-explicit-r1'],
    remainingPending: 5,
    manifestPath
  });
  const updated = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    runs: Array<Record<string, unknown>>;
  };
  assert.deepEqual(updated.runs[0], {
    runKey: 'T2-explicit-r1',
    taskId: 'T2',
    condition: 'explicit',
    repetition: 1,
    status: 'completed',
    recordRunId,
    recordStatus: 'completed',
    taskSuccess: true,
    recoverySuccess: null
  });
});

test('run-next blocks an unresolved running item instead of risking a duplicate charge', async t => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'stage2b-reconcile-'));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  let prepareOutput = '';
  await main(['prepare'], {
    repositoryRoot,
    writeOutput: text => { prepareOutput += text; },
    dependencies: { now: () => new Date('2026-08-11T08:00:00.000Z') }
  });
  const { batchId, manifestPath } = JSON.parse(prepareOutput) as {
    batchId: string;
    manifestPath: string;
  };
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    runs: Array<Record<string, unknown>>;
  };
  manifest.runs[0] = {
    runKey: 'T2-explicit-r1',
    taskId: 'T2',
    condition: 'explicit',
    repetition: 1,
    status: 'running',
    recordRunId: 'stage2b-T2-explicit-20260811T080100000Z-missing01'
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  let output = '';

  const exitCode = await main(['run-next', '--batch', batchId], {
    repositoryRoot,
    env: new Proxy({}, {
      get: () => { throw new Error('blocked recovery must not read the API key'); }
    }),
    writeOutput: text => { output += text; },
    dependencies: {
      createModelClient: () => { throw new Error('blocked recovery must not create a model'); },
      connectTools: async () => { throw new Error('blocked recovery must not connect tools'); }
    }
  });

  assert.equal(exitCode, 1);
  assert.deepEqual(JSON.parse(output), {
    batchId,
    status: 'blocked-by-running',
    unresolvedRunKeys: ['T2-explicit-r1'],
    remainingPending: 5,
    manifestPath
  });
  const unchanged = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    runs: Array<Record<string, unknown>>;
  };
  assert.equal(unchanged.runs[0]?.status, 'running');
});

test('returns a failing process code unless the smoke task completes correctly', () => {
  assert.equal(stage2bExitCode({ status: 'completed', taskSuccess: true }), 0);
  assert.equal(stage2bExitCode({ status: 'completed', taskSuccess: false }), 1);
  assert.equal(stage2bExitCode({ status: 'infrastructure-error', taskSuccess: null }), 1);
  assert.equal(stage2bExitCode({ status: 'model-output-error', taskSuccess: null }), 1);
});

test('returns and privately persists a safe MCP connection failure record', async t => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'stage2b-smoke-'));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  await cp(resolve('experiments'), join(repositoryRoot, 'experiments'), { recursive: true });
  const times = [
    new Date('2026-08-10T00:00:00.000Z'),
    new Date('2026-08-10T00:00:00.025Z')
  ];

  const record = await runStage2bSmoke({
    repositoryRoot,
    apiKey: 'offline-test-key',
    dependencies: {
      createModelClient: () => new T1FakeModel(),
      connectTools: async () => { throw new Error('/home/private/server failed'); },
      now: () => times.shift() ?? new Date('2026-08-10T00:00:00.025Z')
    }
  });

  assert.equal(record.status, 'infrastructure-error');
  assert.equal(record.taskSuccess, null);
  assert.equal(record.turns, 0);
  assert.equal(record.toolCalls, 0);
  assert.deepEqual(record.error, { category: 'mcp', code: 'TOOL_CONNECTION_FAILED' });
  assert.deepEqual(record.usage, {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0
  });
  assert.doesNotMatch(JSON.stringify(record), /private|server failed/);

  const path = await writeStage2bRecord(repositoryRoot, record);
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  assert.equal((await lstat(join(repositoryRoot, '.experiment-runs/stage-2b', record.runId))).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), record);
});

test('rejects a changed versioned skill before creating a paid model client', async t => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'stage2b-skill-mismatch-'));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  await cp(resolve('experiments'), join(repositoryRoot, 'experiments'), { recursive: true });
  let modelClients = 0;

  const record = await runStage2bSmoke({
    repositoryRoot,
    taskId: 'T13',
    condition: 'skill-v1',
    expectedSkillIdentity: { version: 'v1', sha256: 'f'.repeat(64) },
    apiKey: 'offline-test-key',
    dependencies: {
      createModelClient: () => {
        modelClients += 1;
        throw new Error('must not create a model client');
      },
      connectTools: async () => { throw new Error('must not connect tools'); }
    }
  });

  assert.equal(modelClients, 0);
  assert.equal(record.status, 'infrastructure-error');
  assert.equal(record.error?.code, 'SETUP_FAILED');
  assert.equal(record.version, 2);
  assert.deepEqual(record.skill, { version: 'v1', sha256: 'f'.repeat(64) });
});

test('returns a safe configuration record when experiment setup fails', async t => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'stage2b-smoke-'));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));

  const record = await runStage2bSmoke({
    repositoryRoot,
    apiKey: 'offline-test-key',
    dependencies: {
      createModelClient: () => { throw new Error('must not be reached'); },
      connectTools: async () => { throw new Error('must not be reached'); }
    }
  });

  assert.equal(record.status, 'infrastructure-error');
  assert.equal(record.taskSuccess, null);
  assert.equal(record.turns, 0);
  assert.deepEqual(record.error, { category: 'configuration', code: 'SETUP_FAILED' });
  assert.doesNotMatch(JSON.stringify(record), /must not be reached/);
});

test('main records a safe setup failure when the API key is missing', async t => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'stage2b-smoke-'));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  await cp(resolve('experiments'), join(repositoryRoot, 'experiments'), { recursive: true });
  let output = '';

  const exitCode = await main(['smoke'], {
    repositoryRoot,
    env: {},
    writeOutput: text => { output += text; },
    dependencies: {
      createModelClient: () => { throw new Error('must not be reached'); },
      connectTools: async () => { throw new Error('must not be reached'); }
    }
  });

  assert.equal(exitCode, 1);
  const summary = JSON.parse(output) as { recordPath: string; status: string };
  assert.equal(summary.status, 'infrastructure-error');
  const record = JSON.parse(await readFile(summary.recordPath, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(record.error, { category: 'configuration', code: 'SETUP_FAILED' });
  assert.equal((await lstat(summary.recordPath)).mode & 0o777, 0o600);
  assert.doesNotMatch(JSON.stringify(record), /DEEPSEEK_API_KEY|must not be reached/);
});

test('main routes the selected task and condition into the record and summary', async t => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'stage2b-smoke-'));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  await cp(resolve('experiments'), join(repositoryRoot, 'experiments'), { recursive: true });
  let output = '';

  const exitCode = await main(['smoke', '--task', 'T6', '--condition', 'description'], {
    repositoryRoot,
    env: { DEEPSEEK_API_KEY: 'offline-test-key' },
    writeOutput: text => { output += text; },
    dependencies: {
      createModelClient: () => new ScriptedModel([
        toolTurn('call-t6', '.', { type: 'file', path: 'missing.json' }),
        finalTurn(null, 'The required file does not exist.', 'cannot_complete')
      ]),
      connectTools: options => McpToolBridge.connect({
        ...options,
        serverEntrypoint: resolve('dist/src/mcp/server.js')
      })
    }
  });

  assert.equal(exitCode, 0);
  const summary = JSON.parse(output) as {
    taskId: string;
    condition: string;
    recoverySuccess?: boolean | null;
    recordPath: string;
  };
  assert.equal(summary.taskId, 'T6');
  assert.equal(summary.condition, 'description');
  assert.equal(summary.recoverySuccess, null);
  const record = JSON.parse(await readFile(summary.recordPath, 'utf8')) as {
    taskId: string; condition: string;
  };
  assert.equal(record.taskId, 'T6');
  assert.equal(record.condition, 'description');
});

test('accepts one nested answer in a fenced provider wrapper', async t => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'stage2b-smoke-'));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  await cp(resolve('experiments'), join(repositoryRoot, 'experiments'), { recursive: true });
  const model = new T1FakeModel([
    'The result is:',
    '```json',
    '{"type":"response","name":"experiment_answer","metadata":{},"result":{"status":"completed","answer":3,"explanation":"Counted with jq.","tool":"jq_query"}}',
    '```',
    'This follows from the tool output.'
  ].join('\n'));

  const record = await runStage2bSmoke({
    repositoryRoot,
    apiKey: 'offline-test-key',
    dependencies: {
      createModelClient: () => model,
      connectTools: options => McpToolBridge.connect({
        ...options,
        serverEntrypoint: resolve('dist/src/mcp/server.js')
      })
    }
  });

  assert.equal(record.status, 'completed');
  assert.equal(record.taskSuccess, true);
  assert.equal(record.finalAnswer?.answer, 3);
});

test('records safe structural diagnostics for an invalid final answer', async t => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'stage2b-smoke-'));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  await cp(resolve('experiments'), join(repositoryRoot, 'experiments'), { recursive: true });
  const invalidPayload = '{"status":"completed","answer":"private-value","explanation":42,"extra":"private-extra"}';
  const invalidText = `\`\`\`json\n${invalidPayload}\n\`\`\``;
  const model = new T1FakeModel(invalidText);

  const record = await runStage2bSmoke({
    repositoryRoot,
    apiKey: 'offline-test-key',
    dependencies: {
      createModelClient: () => model,
      connectTools: options => McpToolBridge.connect({
        ...options,
        serverEntrypoint: resolve('dist/src/mcp/server.js')
      })
    }
  });

  assert.equal(record.status, 'model-output-error');
  assert.deepEqual(record.error?.diagnostics, {
    textLength: invalidText.length,
    trimmedLength: invalidText.length,
    hasMarkdownFence: true,
    markdownFenceUnwrapped: true,
    jsonParseSucceeded: true,
    topLevelType: 'object',
    nestedAnswerCandidateCount: 0,
    fields: {
      status: { present: true, type: 'string' },
      answer: { present: true, type: 'string' },
      explanation: { present: true, type: 'number' }
    },
    unknownFieldCount: 1,
    validationIssues: [
      { code: 'invalid_type', path: 'explanation' },
      { code: 'unrecognized_keys', path: '<root>' }
    ]
  });
  assert.doesNotMatch(JSON.stringify(record.error?.diagnostics), /private-value|private-extra/);
});

function usage(inputTokens: number, outputTokens: number) {
  return {
    inputTokens,
    cachedInputTokens: 5,
    outputTokens,
    reasoningOutputTokens: 0,
    totalTokens: inputTokens + outputTokens
  };
}

class ScriptedModel implements ModelTurnClient {
  readonly requests: ModelTurnRequest[] = [];

  constructor(private readonly turns: ModelTurnResult[]) {}

  async createTurn(request: ModelTurnRequest): Promise<ModelTurnResult> {
    this.requests.push(request);
    const turn = this.turns[this.requests.length - 1];
    if (!turn) throw new Error('Unexpected model turn.');
    return turn;
  }
}

function toolTurn(
  callId: string,
  filter: string,
  source: Record<string, unknown>
): ModelTurnResult {
  const call = {
    callId,
    name: 'jq_query',
    arguments: JSON.stringify({ filter, source })
  };
  return {
    historyItems: [{ type: 'function_call', ...call }],
    functionCalls: [call],
    usage: usage(10, 2)
  };
}

function multiToolTurn(calls: Array<{
  callId: string;
  filter: string;
  source: Record<string, unknown>;
}>): ModelTurnResult {
  const functionCalls = calls.map(call => ({
    callId: call.callId,
    name: 'jq_query',
    arguments: JSON.stringify({ filter: call.filter, source: call.source })
  }));
  return {
    historyItems: functionCalls.map(call => ({ type: 'function_call' as const, ...call })),
    functionCalls,
    usage: usage(10, 2)
  };
}

function finalTurn(
  answer: unknown,
  explanation: string,
  status: 'completed' | 'cannot_complete' = 'completed'
): ModelTurnResult {
  const text = JSON.stringify({ status, answer, explanation });
  return {
    historyItems: [{ type: 'message', role: 'assistant', content: text }],
    functionCalls: [],
    finalText: text,
    usage: usage(10, 2)
  };
}

function completedBatchRecord(runId: string): Stage2bRecord {
  return {
    version: 1,
    runId,
    startedAt: '2026-08-11T08:01:00.000Z',
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    thinking: 'none',
    sampling: { temperature: 0 },
    taskId: 'T2',
    condition: 'explicit',
    status: 'completed',
    taskSuccess: true,
    recoverySuccess: null,
    limits: {
      maxTurns: 5,
      maxToolCalls: 4,
      requestTimeoutMs: 60_000,
      totalTimeoutMs: 120_000
    },
    turns: 1,
    toolCalls: 0,
    toolEvents: [],
    finalAnswer: {
      status: 'completed',
      answer: ['Alice', 'Carol', 'Dave'],
      explanation: 'Recovered persisted observation.'
    },
    usage: {
      inputTokens: 10,
      cachedInputTokens: 0,
      outputTokens: 5,
      reasoningOutputTokens: 0,
      totalTokens: 15
    },
    durationMs: 100
  };
}
