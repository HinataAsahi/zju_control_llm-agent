import type { ExperimentCondition } from './schema.js';

export type Stage2bSuiteId = 'baseline-v1' | 'diagnostic-v1' | 'boundary-v1';
export type Stage2bTaskId =
  | 'T1' | 'T2' | 'T6' | 'T7' | 'T9' | 'T10' | 'T11'
  | 'T12' | 'T13' | 'T14' | 'T15' | 'T16' | 'T17';
export const STAGE2B_TASK_IDS = [
  'T1', 'T2', 'T6', 'T7', 'T9', 'T10', 'T11',
  'T12', 'T13', 'T14', 'T15', 'T16', 'T17'
] as const;
export type Stage2bTreatment = ExperimentCondition | 'skill-v1' | 'skill-v2';
export type Stage2bToolPolicy = 'required' | 'forbidden';
export type Stage2bRecoveryMode = 'none' | 'required' | 'natural';

export interface Stage2bTaskProfile {
  taskId: Stage2bTaskId;
  taskRoot: 'stage-2a' | 'stage-2b';
  toolPolicy: Stage2bToolPolicy;
  recoveryMode: Stage2bRecoveryMode;
}

export interface Stage2bSuite {
  id: Stage2bSuiteId;
  taskIds: readonly Stage2bTaskId[];
  runs: readonly Pick<Stage2bSuiteRun, 'taskId' | 'condition'>[];
}

export interface Stage2bSuiteRun {
  taskId: Stage2bTaskId;
  condition: Stage2bTreatment;
  repetition: number;
}

const taskProfiles: Readonly<Record<Stage2bTaskId, Readonly<Stage2bTaskProfile>>> = Object.freeze({
  T1: Object.freeze({ taskId: 'T1', taskRoot: 'stage-2a', toolPolicy: 'required', recoveryMode: 'none' }),
  T2: Object.freeze({ taskId: 'T2', taskRoot: 'stage-2a', toolPolicy: 'required', recoveryMode: 'none' }),
  T6: Object.freeze({ taskId: 'T6', taskRoot: 'stage-2a', toolPolicy: 'required', recoveryMode: 'none' }),
  T7: Object.freeze({ taskId: 'T7', taskRoot: 'stage-2a', toolPolicy: 'required', recoveryMode: 'required' }),
  T9: Object.freeze({ taskId: 'T9', taskRoot: 'stage-2b', toolPolicy: 'forbidden', recoveryMode: 'none' }),
  T10: Object.freeze({ taskId: 'T10', taskRoot: 'stage-2b', toolPolicy: 'required', recoveryMode: 'none' }),
  T11: Object.freeze({ taskId: 'T11', taskRoot: 'stage-2b', toolPolicy: 'required', recoveryMode: 'natural' }),
  T12: Object.freeze({ taskId: 'T12', taskRoot: 'stage-2b', toolPolicy: 'forbidden', recoveryMode: 'none' }),
  T13: Object.freeze({ taskId: 'T13', taskRoot: 'stage-2b', toolPolicy: 'required', recoveryMode: 'none' }),
  T14: Object.freeze({ taskId: 'T14', taskRoot: 'stage-2b', toolPolicy: 'forbidden', recoveryMode: 'none' }),
  T15: Object.freeze({ taskId: 'T15', taskRoot: 'stage-2b', toolPolicy: 'required', recoveryMode: 'none' }),
  T16: Object.freeze({ taskId: 'T16', taskRoot: 'stage-2b', toolPolicy: 'forbidden', recoveryMode: 'none' }),
  T17: Object.freeze({ taskId: 'T17', taskRoot: 'stage-2b', toolPolicy: 'required', recoveryMode: 'none' })
});

const suites: Readonly<Record<Stage2bSuiteId, Readonly<Stage2bSuite>>> = Object.freeze({
  'baseline-v1': Object.freeze({
    id: 'baseline-v1',
    taskIds: Object.freeze(['T2', 'T7'] as const),
    runs: Object.freeze([
      ['T2', 'explicit'], ['T2', 'description'], ['T2', 'skill'],
      ['T7', 'explicit'], ['T7', 'description'], ['T7', 'skill']
    ].map(([taskId, condition]) => Object.freeze({
      taskId: taskId as Stage2bTaskId,
      condition: condition as ExperimentCondition
    })))
  }),
  'diagnostic-v1': Object.freeze({
    id: 'diagnostic-v1',
    taskIds: Object.freeze(['T9', 'T10', 'T11'] as const),
    runs: Object.freeze([
      ['T9', 'explicit'], ['T10', 'description'], ['T11', 'skill'],
      ['T9', 'description'], ['T10', 'skill'], ['T11', 'explicit'],
      ['T9', 'skill'], ['T10', 'explicit'], ['T11', 'description']
    ].map(([taskId, condition]) => Object.freeze({
      taskId: taskId as Stage2bTaskId,
      condition: condition as ExperimentCondition
    })))
  }),
  'boundary-v1': Object.freeze({
    id: 'boundary-v1',
    taskIds: Object.freeze(['T12', 'T13', 'T14', 'T15', 'T16', 'T17'] as const),
    runs: Object.freeze([
      ['T12', 'description'], ['T13', 'skill-v1'], ['T14', 'skill-v2'],
      ['T15', 'description'], ['T16', 'skill-v1'], ['T17', 'skill-v2'],
      ['T12', 'skill-v1'], ['T13', 'skill-v2'], ['T14', 'description'],
      ['T15', 'skill-v1'], ['T16', 'skill-v2'], ['T17', 'description'],
      ['T12', 'skill-v2'], ['T13', 'description'], ['T14', 'skill-v1'],
      ['T15', 'skill-v2'], ['T16', 'description'], ['T17', 'skill-v1']
    ].map(([taskId, condition]) => Object.freeze({
      taskId: taskId as Stage2bTaskId,
      condition: condition as Stage2bTreatment
    })))
  })
});

export function getStage2bSuite(id: Stage2bSuiteId): Readonly<Stage2bSuite> {
  const suite = suites[id];
  if (!suite) throw new Error(`Unknown Stage 2B suite: ${id}`);
  return suite;
}

export function getStage2bTaskProfile(taskId: Stage2bTaskId): Readonly<Stage2bTaskProfile> {
  const profile = taskProfiles[taskId];
  if (!profile) throw new Error(`Unknown Stage 2B task: ${taskId}`);
  return profile;
}

export function expandStage2bSuite(
  id: Stage2bSuiteId,
  repetitions: number
): Stage2bSuiteRun[] {
  if (!Number.isSafeInteger(repetitions) || repetitions < 1) {
    throw new Error('Stage 2B repetitions must be a positive safe integer.');
  }
  const suite = getStage2bSuite(id);
  if (id !== 'baseline-v1') {
    return Array.from({ length: repetitions }, (_, index) =>
      suite.runs.map(run => ({
        taskId: run.taskId,
        condition: run.condition,
        repetition: index + 1
      }))
    ).flat();
  }
  return suite.runs.flatMap(run =>
    Array.from({ length: repetitions }, (_, index) => ({
      taskId: run.taskId,
      condition: run.condition,
      repetition: index + 1
    }))
  );
}
