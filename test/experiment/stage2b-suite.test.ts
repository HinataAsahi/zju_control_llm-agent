import assert from 'node:assert/strict';
import test from 'node:test';
import {
  expandStage2bSuite,
  getStage2bSuite,
  getStage2bTaskProfile,
  STAGE2B_TASK_IDS
} from '../../src/experiment/stage2b-suite.js';

test('expands diagnostic-v1 in its fixed balanced order', () => {
  assert.deepEqual(expandStage2bSuite('diagnostic-v1', 1), [
    { taskId: 'T9', condition: 'explicit', repetition: 1 },
    { taskId: 'T10', condition: 'description', repetition: 1 },
    { taskId: 'T11', condition: 'skill', repetition: 1 },
    { taskId: 'T9', condition: 'description', repetition: 1 },
    { taskId: 'T10', condition: 'skill', repetition: 1 },
    { taskId: 'T11', condition: 'explicit', repetition: 1 },
    { taskId: 'T9', condition: 'skill', repetition: 1 },
    { taskId: 'T10', condition: 'explicit', repetition: 1 },
    { taskId: 'T11', condition: 'description', repetition: 1 }
  ]);
  assert.equal(expandStage2bSuite('diagnostic-v1', 2)[9]?.repetition, 2);
});

test('preserves baseline-v1 cell-major ordering across repetitions', () => {
  assert.deepEqual(expandStage2bSuite('baseline-v1', 2), [
    { taskId: 'T2', condition: 'explicit', repetition: 1 },
    { taskId: 'T2', condition: 'explicit', repetition: 2 },
    { taskId: 'T2', condition: 'description', repetition: 1 },
    { taskId: 'T2', condition: 'description', repetition: 2 },
    { taskId: 'T2', condition: 'skill', repetition: 1 },
    { taskId: 'T2', condition: 'skill', repetition: 2 },
    { taskId: 'T7', condition: 'explicit', repetition: 1 },
    { taskId: 'T7', condition: 'explicit', repetition: 2 },
    { taskId: 'T7', condition: 'description', repetition: 1 },
    { taskId: 'T7', condition: 'description', repetition: 2 },
    { taskId: 'T7', condition: 'skill', repetition: 1 },
    { taskId: 'T7', condition: 'skill', repetition: 2 }
  ]);
});

test('owns the Stage 2B task profiles and rejects unknown registry values', () => {
  assert.deepEqual(STAGE2B_TASK_IDS, ['T1', 'T2', 'T6', 'T7', 'T9', 'T10', 'T11']);
  assert.deepEqual(getStage2bTaskProfile('T9'), {
    taskId: 'T9', taskRoot: 'stage-2b', toolPolicy: 'forbidden', recoveryMode: 'none'
  });
  assert.deepEqual(getStage2bTaskProfile('T11'), {
    taskId: 'T11', taskRoot: 'stage-2b', toolPolicy: 'required', recoveryMode: 'natural'
  });
  assert.deepEqual(getStage2bSuite('baseline-v1').taskIds, ['T2', 'T7']);
  assert.throws(() => getStage2bTaskProfile('T99' as never), /unknown.*task/i);
  assert.throws(() => getStage2bSuite('other-v1' as never), /unknown.*suite/i);
});
