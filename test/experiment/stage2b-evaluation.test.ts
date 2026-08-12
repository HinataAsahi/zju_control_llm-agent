import assert from 'node:assert/strict';
import test from 'node:test';
import type { Stage2bToolEvent } from '../../src/experiment/stage2b-record.js';
import {
  analyzeStage2bProcess,
  evaluateStage2bRecovery
} from '../../src/experiment/stage2b-evaluation.js';

function jqEvents(
  callId: string,
  filter: string,
  output?: unknown
): Stage2bToolEvent[] {
  return [{
    type: 'function_call',
    callId,
    name: 'jq_query',
    arguments: JSON.stringify({
      filter,
      source: { type: 'file', path: 'private-fixture.json' }
    })
  }, ...(output === undefined ? [] : [{
    type: 'function_call_output' as const,
    callId,
    output: typeof output === 'string' ? output : JSON.stringify(output)
  }])];
}

test('classifies diagnostic process strategies with bounded public labels', () => {
  const cases = [{
    name: 'T9 avoids the forbidden tool',
    taskId: 'T9' as const,
    taskSuccess: true,
    toolEvents: [],
    expected: {
      toolCompliance: true,
      firstCallOutcome: 'no-call',
      strategy: 'avoided-tool',
      tracePath: []
    }
  }, {
    name: 'T9 calls the forbidden tool unnecessarily',
    taskId: 'T9' as const,
    taskSuccess: true,
    toolEvents: jqEvents('private-call-t9', '.privateFilter', {
      ok: true, values: ['private-output']
    }),
    expected: {
      toolCompliance: false,
      firstCallOutcome: 'ok',
      strategy: 'unnecessary-tool',
      tracePath: ['task-query:ok']
    }
  }, {
    name: 'T9 treats any unexpected tool call as unnecessary',
    taskId: 'T9' as const,
    taskSuccess: true,
    toolEvents: [{
      type: 'function_call' as const,
      callId: 'private-call-other',
      name: 'private_tool',
      arguments: '{"private":true}'
    }],
    expected: {
      toolCompliance: false,
      firstCallOutcome: 'no-call',
      strategy: 'unnecessary-tool',
      tracePath: []
    }
  }, {
    name: 'T10 succeeds with its first target query',
    taskId: 'T10' as const,
    taskSuccess: true,
    toolEvents: jqEvents('private-call-t10', '[.shipments[]]', { ok: true, values: [] }),
    expected: {
      toolCompliance: true,
      firstCallOutcome: 'ok',
      strategy: 'one-shot-query',
      tracePath: ['task-query:ok']
    }
  }, {
    name: 'T11 inspects the root before a successful target query',
    taskId: 'T11' as const,
    taskSuccess: true,
    toolEvents: [
      ...jqEvents('private-call-inspect', ' . ', { ok: true, values: [] }),
      ...jqEvents('private-call-target', '[.services[]]', { ok: true, values: [] })
    ],
    expected: {
      toolCompliance: true,
      firstCallOutcome: 'ok',
      strategy: 'inspect-first',
      tracePath: ['inspect-root:ok', 'task-query:ok']
    }
  }, {
    name: 'T11 recovers after a runtime error',
    taskId: 'T11' as const,
    taskSuccess: true,
    toolEvents: [
      ...jqEvents('private-call-error', '[.[]]', {
        ok: false, error: { code: 'JQ_RUNTIME_ERROR', detail: 'private-output' }
      }),
      ...jqEvents('private-call-retry', '[.services[]]', { ok: true, values: [] })
    ],
    expected: {
      toolCompliance: true,
      firstCallOutcome: 'JQ_RUNTIME_ERROR',
      strategy: 'recovered-after-error',
      tracePath: ['task-query:JQ_RUNTIME_ERROR', 'task-query:ok']
    }
  }, {
    name: 'T11 leaves an error unresolved',
    taskId: 'T11' as const,
    taskSuccess: false,
    toolEvents: jqEvents('private-call-unresolved', '[.[]]', {
      ok: false, error: { code: 'JQ_RUNTIME_ERROR' }
    }),
    expected: {
      toolCompliance: true,
      firstCallOutcome: 'JQ_RUNTIME_ERROR',
      strategy: 'unresolved',
      tracePath: ['task-query:JQ_RUNTIME_ERROR']
    }
  }, {
    name: 'missing output stays structural',
    taskId: 'T10' as const,
    taskSuccess: null,
    toolEvents: jqEvents('private-call-missing', '[.shipments[]]'),
    expected: {
      toolCompliance: true,
      firstCallOutcome: 'missing-output',
      strategy: 'unresolved',
      tracePath: ['task-query:missing-output']
    }
  }, {
    name: 'malformed output stays structural',
    taskId: 'T10' as const,
    taskSuccess: null,
    toolEvents: jqEvents('private-call-malformed', '[.shipments[]]', 'not-json-private-output'),
    expected: {
      toolCompliance: true,
      firstCallOutcome: 'malformed-output',
      strategy: 'unresolved',
      tracePath: ['task-query:malformed-output']
    }
  }, {
    name: 'unknown error codes collapse to tool-error',
    taskId: 'T11' as const,
    taskSuccess: false,
    toolEvents: jqEvents('private-call-secret', '[.services[]]', {
      ok: false, error: { code: 'PRIVATE_SECRET_CODE', detail: 'private-output' }
    }),
    expected: {
      toolCompliance: true,
      firstCallOutcome: 'tool-error',
      strategy: 'unresolved',
      tracePath: ['task-query:tool-error']
    }
  }];

  for (const fixture of cases) {
    const analysis = analyzeStage2bProcess(fixture);
    assert.deepEqual(analysis, fixture.expected, fixture.name);
    assert.doesNotMatch(
      JSON.stringify(analysis),
      /private|shipments|services|PRIVATE_SECRET_CODE|call-/i,
      fixture.name
    );
  }
});

test('derives required and natural recovery without exposing private events', () => {
  const t7Events = [
    ...jqEvents('t7-error', 'if', { ok: false, error: { code: 'JQ_SYNTAX_ERROR' } }),
    ...jqEvents('t7-retry', '[.users[]]', { ok: true, values: [] })
  ];
  assert.equal(evaluateStage2bRecovery({
    taskId: 'T7', status: 'completed', taskSuccess: true, toolEvents: t7Events
  }), true);
  assert.equal(evaluateStage2bRecovery({
    taskId: 'T7', status: 'model-output-error', taskSuccess: null, toolEvents: t7Events
  }), null);

  const naturalEvents = [
    ...jqEvents('t11-error', '[.[]]', { ok: false, error: { code: 'JQ_RUNTIME_ERROR' } }),
    ...jqEvents('t11-retry', '[.services[]]', { ok: true, values: [] })
  ];
  assert.equal(evaluateStage2bRecovery({
    taskId: 'T11', status: 'completed', taskSuccess: true, toolEvents: naturalEvents
  }), true);
  assert.equal(evaluateStage2bRecovery({
    taskId: 'T11', status: 'completed', taskSuccess: false, toolEvents: naturalEvents
  }), false);
  assert.equal(evaluateStage2bRecovery({
    taskId: 'T11', status: 'completed', taskSuccess: true,
    toolEvents: jqEvents('t11-inspect', '.', { ok: true, values: [] })
  }), null);
  assert.equal(evaluateStage2bRecovery({
    taskId: 'T9', status: 'completed', taskSuccess: true, toolEvents: []
  }), null);
});
