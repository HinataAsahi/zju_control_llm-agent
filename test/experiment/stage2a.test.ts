import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelConfiguration } from '../../src/experiment/codex-runner.js';
import type { EvaluatedRun } from '../../src/experiment/report.js';
import {
  CALIBRATION_LADDER,
  assertCalibrationMatch,
  buildFormalSchedule,
  buildInteractiveArguments,
  filterFormalSchedule,
  parseStage2aArgs,
  runCalibration
} from '../../src/experiment/stage2a.js';
import type { ExperimentCondition, ExperimentTask } from '../../src/experiment/schema.js';

function evaluated(
  taskId: string,
  overrides: Partial<EvaluatedRun> = {}
): EvaluatedRun {
  return {
    taskId,
    condition: 'explicit',
    validity: 'valid',
    taskSuccess: true,
    explicitCompliance: true,
    mcpSelected: null,
    firstCallValid: taskId === 'T7' ? false : true,
    recoverySuccess: taskId === 'T7' ? true : null,
    negativeAvoidance: null,
    alternativePath: 'mcp',
    usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 },
    durationMs: 1,
    notes: [],
    ...overrides
  };
}

test('calibration starts at Luna low and stops after a 3/3 pass', async () => {
  const calls: Array<{ taskId: string; model: ModelConfiguration }> = [];
  const result = await runCalibration(async (taskId, model) => {
    calls.push({ taskId, model });
    return evaluated(taskId);
  });

  assert.deepEqual(result.selected, CALIBRATION_LADDER[0]);
  assert.equal(result.status, 'selected');
  assert.deepEqual(calls.map(call => call.taskId), ['T1', 'T4', 'T7']);
  assert.equal(calls.every(call => call.model === CALIBRATION_LADDER[0]), true);
});

test('calibration advances only after model behavior failure', async () => {
  const calls: string[] = [];
  const result = await runCalibration(async (taskId, model) => {
    calls.push(`${model.model}/${model.reasoningEffort}/${taskId}`);
    if (model === CALIBRATION_LADDER[0] && taskId === 'T4') {
      return evaluated(taskId, { taskSuccess: false });
    }
    return evaluated(taskId);
  });

  assert.deepEqual(result.selected, CALIBRATION_LADDER[1]);
  assert.deepEqual(calls, [
    'gpt-5.6-luna/low/T1',
    'gpt-5.6-luna/low/T4',
    'gpt-5.6-luna/medium/T1',
    'gpt-5.6-luna/medium/T4',
    'gpt-5.6-luna/medium/T7'
  ]);
});

test('calibration stops on infrastructure error and retries the same tier when resumed', async () => {
  const first = await runCalibration(async taskId => (
    taskId === 'T4' ? evaluated(taskId, { validity: 'infrastructure-error', taskSuccess: null }) : evaluated(taskId)
  ));
  assert.equal(first.status, 'infrastructure-error');
  assert.equal(first.tierIndex, 0);
  assert.equal(first.selected, undefined);

  const calls: string[] = [];
  const retried = await runCalibration(async (taskId, model) => {
    calls.push(`${model.reasoningEffort}/${taskId}`);
    return evaluated(taskId);
  }, first.tierIndex);
  assert.equal(retried.status, 'selected');
  assert.deepEqual(retried.selected, CALIBRATION_LADDER[0]);
  assert.deepEqual(calls, ['low/T1', 'low/T4', 'low/T7']);
});

test('formal schedule contains exactly 24 unique pairs in sequential order', () => {
  const tasks = Array.from({ length: 8 }, (_, index) => ({
    id: `T${index + 1}`,
    kind: 'normal',
    prompt: 'task',
    inputFiles: [],
    expected: { status: 'completed', answer: index }
  })) as ExperimentTask[];
  const schedule = buildFormalSchedule(tasks);

  assert.equal(schedule.length, 24);
  assert.equal(new Set(schedule.map(pair => `${pair.task.id}/${pair.condition}`)).size, 24);
  assert.deepEqual(schedule.slice(0, 3).map(pair => pair.condition), ['explicit', 'description', 'skill']);
});

test('resume fills only missing and infrastructure-invalid formal pairs', () => {
  const tasks = ['T1', 'T2'].map(id => ({
    id,
    kind: 'normal',
    prompt: 'task',
    inputFiles: [],
    expected: { status: 'completed', answer: 1 }
  })) as ExperimentTask[];
  const schedule = buildFormalSchedule(tasks);
  const existing = [
    evaluated('T1'),
    evaluated('T1', { condition: 'description', validity: 'infrastructure-error', taskSuccess: null }),
    evaluated('T1', { condition: 'skill', taskSuccess: false })
  ];
  const remaining = filterFormalSchedule(schedule, existing, true);

  assert.deepEqual(remaining.map(pair => `${pair.task.id}/${pair.condition}`), [
    'T1/description', 'T2/explicit', 'T2/description', 'T2/skill'
  ]);
  assert.throws(() => filterFormalSchedule(schedule, existing, false), /already exist/);
});

test('formal model settings must match saved calibration', () => {
  const selected: ModelConfiguration = { model: 'gpt-5.6-luna', reasoningEffort: 'low' };
  assert.doesNotThrow(() => assertCalibrationMatch(selected, selected));
  assert.throws(
    () => assertCalibrationMatch(selected, { model: 'gpt-5.6-terra', reasoningEffort: 'medium' }),
    /calibration/
  );
});

test('experience accepts only T3 or T7 and emits interactive arguments without JSON scoring flags', () => {
  assert.deepEqual(parseStage2aArgs(['experience', '--task', 'T3']), {
    mode: 'experience', taskId: 'T3', launch: false
  });
  assert.throws(() => parseStage2aArgs(['experience', '--task', 'T2']), /T3 or T7/);
  assert.throws(() => parseStage2aArgs(['experience', '--task', 'T3', '--unknown']), /Unknown/);

  const args = buildInteractiveArguments({
    workspacePath: '/tmp/work space',
    serverEntrypoint: '/tmp/server.js',
    model: CALIBRATION_LADDER[0]!,
    prompt: 'Use jq_query.\nCount values.'
  });
  assert.equal(args.includes('--json'), false);
  assert.equal(args.includes('--output-schema'), false);
  assert.equal(args.includes('--ephemeral'), false);
  assert.equal(args.includes('--ignore-user-config'), false);
  assert.equal(args.includes('--skip-git-repo-check'), false);
  assert.deepEqual(args.slice(0, 4), ['--model', 'gpt-5.6-luna', '--sandbox', 'read-only']);
  assert.equal(args.at(-1), 'Use jq_query.\nCount values.');
});

test('strict CLI parser rejects unknown modes and incomplete formal settings', () => {
  assert.deepEqual(parseStage2aArgs(['formal', '--resume']), {
    mode: 'formal', resume: true
  });
  assert.deepEqual(parseStage2aArgs([
    'formal', '--model', 'gpt-5.6-luna', '--reasoning', 'medium'
  ]), {
    mode: 'formal',
    resume: false,
    model: 'gpt-5.6-luna',
    reasoningEffort: 'medium'
  });
  assert.throws(() => parseStage2aArgs(['formal', '--model', 'gpt-5.6-luna']), /together/);
  assert.throws(() => parseStage2aArgs(['unknown']), /Unknown mode/);
});
