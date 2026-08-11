import assert from 'node:assert/strict';
import { cp, lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
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
  main,
  parseStage2bArgs,
  runStage2bSmoke,
  stage2bExitCode,
  type Stage2bTaskId
} from '../../src/experiment/stage2b.js';
import { writeStage2bRecord } from '../../src/experiment/stage2b-record.js';

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
    maxTurns: 5,
    maxToolCalls: 4,
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

test('keeps description and skill condition inputs isolated', async t => {
  const firstRequests = new Map<'description' | 'skill', ModelTurnRequest>();
  for (const condition of ['description', 'skill'] as const) {
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
      assert.equal(record.condition, condition);
      assert.match(record.runId, new RegExp(`^stage2b-T2-${condition}-`));
      assert.equal(record.taskSuccess, true);
      assert.doesNotMatch(request?.history[0]?.type === 'message'
        ? request.history[0].content
        : '', /Use the `jq_query` tool/);
      if (condition === 'skill') {
        assert.match(request?.instructions ?? '', /Reference skill: jq-query/);
        assert.match(request?.instructions ?? '', /# jq Query/);
        assert.match(request?.instructions ?? '', /JQ_SYNTAX_ERROR/);
      } else {
        assert.doesNotMatch(request?.instructions ?? '', /Reference skill|# jq Query|JQ_SYNTAX_ERROR/);
      }
    });
  }

  const description = firstRequests.get('description');
  const skill = firstRequests.get('skill');
  assert.ok(description);
  assert.ok(skill);
  assert.deepEqual(skill.history, description.history);
  assert.deepEqual(skill.tools, description.tools);
  assert.deepEqual(skill.outputSchema, description.outputSchema);
});

test('accepts smoke for the supported representative task set', () => {
  assert.deepEqual(parseStage2bArgs(['smoke']), {
    mode: 'smoke', taskId: 'T1', condition: 'explicit'
  });
  for (const taskId of ['T1', 'T2', 'T6', 'T7'] as const) {
    assert.deepEqual(parseStage2bArgs(['smoke', '--task', taskId]), {
      mode: 'smoke', taskId, condition: 'explicit'
    });
  }
  for (const condition of ['explicit', 'description', 'skill'] as const) {
    assert.deepEqual(parseStage2bArgs(['smoke', '--condition', condition]), {
      mode: 'smoke', taskId: 'T1', condition
    });
  }
  assert.deepEqual(
    parseStage2bArgs(['smoke', '--condition', 'skill', '--task', 'T7']),
    { mode: 'smoke', taskId: 'T7', condition: 'skill' }
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

test('accepts a bounded repetition count for an offline plan', () => {
  assert.deepEqual(parseStage2bArgs(['plan']), { mode: 'plan', repetitions: 1 });
  assert.deepEqual(
    parseStage2bArgs(['plan', '--repetitions', '3']),
    { mode: 'plan', repetitions: 3 }
  );
  for (const argv of [
    ['plan', '--repetitions'],
    ['plan', '--repetitions', '0'],
    ['plan', '--repetitions', '1.5'],
    ['plan', '--repetitions', '101'],
    ['plan', '--unknown', '2'],
    ['plan', '--repetitions', '2', '--repetitions', '3']
  ]) {
    assert.throws(() => parseStage2bArgs(argv), /plan|repetitions/i);
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
    tasks: string[];
    conditions: string[];
    repetitions: number;
    totalRuns: number;
    requiresApiKey: boolean;
    upperBounds: { modelRequests: number; toolCalls: number };
    runs: Array<{ taskId: string; condition: string; repetition: number }>;
  };
  assert.deepEqual({
    version: plan.version,
    mode: plan.mode,
    tasks: plan.tasks,
    conditions: plan.conditions,
    repetitions: plan.repetitions,
    totalRuns: plan.totalRuns,
    requiresApiKey: plan.requiresApiKey,
    upperBounds: plan.upperBounds
  }, {
    version: 1,
    mode: 'plan',
    tasks: ['T2', 'T7'],
    conditions: ['explicit', 'description', 'skill'],
    repetitions: 2,
    totalRuns: 12,
    requiresApiKey: false,
    upperBounds: { modelRequests: 60, toolCalls: 48 }
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
