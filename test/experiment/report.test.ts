import assert from 'node:assert/strict';
import test from 'node:test';
import type { RawCodexRun } from '../../src/experiment/codex-runner.js';
import {
  evaluateRun,
  renderMarkdownReport,
  sanitizeRun,
  type EvaluateRunInput,
  type EvaluatedRun
} from '../../src/experiment/report.js';
import type { ExperimentCondition, ExperimentTask } from '../../src/experiment/schema.js';
import type { TraceSummary } from '../../src/experiment/trace-parser.js';

function task(id = 'T4', expected: ExperimentTask['expected'] = {
  status: 'completed',
  answer: { east: 220, west: 330 }
}): ExperimentTask {
  return { id: id as `T${number}`, kind: 'normal', prompt: 'task', inputFiles: [], expected };
}

function raw(overrides: Partial<RawCodexRun> = {}): RawCodexRun {
  return {
    exitCode: 0,
    signal: null,
    durationMs: 120,
    stdoutPath: '/tmp/stdout',
    stderrPath: '/tmp/stderr',
    timedOut: false,
    ...overrides
  };
}

function trace(overrides: Partial<TraceSummary> = {}): TraceSummary {
  return {
    terminalStatus: 'completed',
    usage: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 3, reasoningOutputTokens: 1 },
    mcpCalls: [],
    commandExecutions: [],
    finalAnswer: {
      status: 'completed',
      answer: { west: 330, east: 220 },
      explanation: 'done'
    },
    parseErrors: [],
    unknownEventTypes: [],
    needsReview: false,
    ...overrides
  };
}

function evaluate(
  condition: ExperimentCondition,
  overrides: Partial<EvaluateRunInput> = {}
): EvaluatedRun {
  return evaluateRun({
    task: task(),
    condition,
    raw: raw(),
    trace: trace(),
    ...overrides
  });
}

test('uses canonical JSON equality and keeps condition-specific metrics nullable', () => {
  const result = evaluate('description');

  assert.equal(result.validity, 'valid');
  assert.equal(result.taskSuccess, true);
  assert.equal(result.mcpSelected, false);
  assert.equal(result.explicitCompliance, null);
  assert.equal(result.firstCallValid, null);
  assert.equal(result.recoverySuccess, null);
  assert.equal(result.negativeAvoidance, null);
  assert.equal(result.alternativePath, 'direct');
});

test('scores T6 only for cannot_complete with a null answer', () => {
  const t6 = task('T6', { status: 'cannot_complete', answer: null });
  const success = evaluate('skill', {
    task: t6,
    trace: trace({
      finalAnswer: { status: 'cannot_complete', answer: null, explanation: 'missing' }
    })
  });
  const guessed = evaluate('skill', {
    task: t6,
    trace: trace({
      finalAnswer: { status: 'completed', answer: 3, explanation: 'guessed' }
    })
  });

  assert.equal(success.taskSuccess, true);
  assert.equal(guessed.taskSuccess, false);
});

test('scores T7 recovery and T8 negative avoidance from jq calls', () => {
  const failed = {
    tool: 'jq_query',
    arguments: { filter: 'if' },
    error: { code: 'JQ_SYNTAX_ERROR' },
    status: 'failed'
  };
  const succeeded = {
    tool: 'jq_query',
    arguments: { filter: 'length' },
    result: { ok: true, values: [3] },
    status: 'completed'
  };
  const t7 = evaluate('explicit', {
    task: task('T7', { status: 'completed', answer: 3 }),
    trace: trace({
      mcpCalls: [failed, succeeded],
      finalAnswer: { status: 'completed', answer: 3, explanation: 'recovered' }
    })
  });
  const t8 = evaluate('explicit', {
    task: task('T8', { status: 'completed', answer: 3 }),
    trace: trace({
      finalAnswer: { status: 'completed', answer: 3, explanation: 'read text' }
    })
  });

  assert.equal(t7.explicitCompliance, true);
  assert.equal(t7.firstCallValid, false);
  assert.equal(t7.recoverySuccess, true);
  assert.equal(t8.explicitCompliance, true);
  assert.equal(t8.negativeAvoidance, true);
  assert.equal(t8.mcpSelected, null);
});

test('keeps model mistakes valid but separates infrastructure and review failures', () => {
  const wrong = evaluate('description', {
    trace: trace({ finalAnswer: { status: 'completed', answer: 999, explanation: 'wrong' } })
  });
  const timeout = evaluate('description', { raw: raw({ timedOut: true, exitCode: null, signal: 'SIGKILL' }) });
  const nonzero = evaluate('description', { raw: raw({ exitCode: 7 }) });
  const failed = evaluate('description', { trace: trace({ terminalStatus: 'failed', needsReview: true }) });
  const incompleteTrace = trace({ terminalStatus: 'incomplete', needsReview: true });
  delete incompleteTrace.finalAnswer;
  const incomplete = evaluate('description', {
    trace: incompleteTrace
  });
  const malformed = evaluate('description', {
    trace: trace({ parseErrors: ['bad line'], needsReview: true })
  });

  assert.deepEqual([wrong.validity, wrong.taskSuccess], ['valid', false]);
  for (const result of [timeout, nonzero, failed]) {
    assert.equal(result.validity, 'infrastructure-error');
    assert.equal(result.taskSuccess, null);
  }
  for (const result of [incomplete, malformed]) {
    assert.equal(result.validity, 'needs-review');
    assert.equal(result.taskSuccess, null);
  }
});

test('classifies MCP, shell, file-read, mixed, direct, and unknown paths', () => {
  const jqCall = { tool: 'jq_query', arguments: {}, result: { ok: true } };
  assert.equal(evaluate('description', { trace: trace({ mcpCalls: [jqCall] }) }).alternativePath, 'mcp');
  assert.equal(evaluate('description', { trace: trace({ commandExecutions: ['jq . file.json'] }) }).alternativePath, 'shell');
  assert.equal(evaluate('description', { trace: trace({ commandExecutions: ['cat notes.txt'] }) }).alternativePath, 'file-read');
  assert.equal(evaluate('description', {
    trace: trace({ mcpCalls: [jqCall], commandExecutions: ['cat data.json'] })
  }).alternativePath, 'mixed');
  assert.equal(evaluate('description').alternativePath, 'direct');
  const unknownTrace = trace();
  delete unknownTrace.finalAnswer;
  assert.equal(evaluate('description', {
    trace: unknownTrace
  }).alternativePath, 'unknown');
});

test('sanitizes paths, thread IDs, bearer tokens, and API-key-like values', () => {
  const run = evaluate('description');
  run.notes.push(
    'read /home/alice/project/data.json and C:\\Users\\Alice\\secret.txt',
    'thread_id=0199a213-81c0-7800-8aa1-bbab2a035a53',
    'Authorization: Bearer abc.def.ghi api_key=super-secret'
  );
  const sanitized = sanitizeRun(run);
  const serialized = JSON.stringify(sanitized);

  assert.doesNotMatch(serialized, /\/home\/alice|C:\\\\Users|0199a213|abc\.def|super-secret/);
  assert.match(serialized, /\[REDACTED_/);
});

test('renders descriptive single-observation counts with explicit denominators and sanitized notes', () => {
  const runs = [
    evaluate('description'),
    evaluate('skill', {
      trace: trace({
        mcpCalls: [{ tool: 'jq_query', arguments: {}, result: { ok: true }, status: 'completed' }]
      })
    }),
    evaluate('explicit', {
      raw: raw({ timedOut: true, exitCode: null, signal: 'SIGKILL' })
    })
  ];
  runs[2]!.notes.push('failure at /home/alice/private Bearer secret-token');

  const report = renderMarkdownReport(runs, {
    generatedAt: '2026-08-09T12:00:00.000Z',
    codexVersion: 'codex-cli 0.146.0',
    repositoryCommit: 'abc1234',
    model: { model: 'gpt-5.6-luna', reasoningEffort: 'low' }
  });

  assert.match(report, /单次观测/);
  assert.match(report, /任务成功.*2\/2/);
  assert.match(report, /MCP 选择.*1\/2/);
  assert.match(report, /输入 token.*30/);
  assert.match(report, /人工复核/);
  assert.doesNotMatch(report, /\/home\/alice|secret-token|显著|证明/);
});
