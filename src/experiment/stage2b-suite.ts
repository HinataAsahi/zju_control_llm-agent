import type { ExperimentCondition } from './schema.js';

export type Stage2bSuiteId = 'baseline-v1' | 'diagnostic-v1';
export type Stage2bTaskId = 'T1' | 'T2' | 'T6' | 'T7' | 'T9' | 'T10' | 'T11';
export const STAGE2B_TASK_IDS = ['T1', 'T2', 'T6', 'T7', 'T9', 'T10', 'T11'] as const;
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
  condition: ExperimentCondition;
  repetition: number;
}

const taskProfiles: Readonly<Record<Stage2bTaskId, Readonly<Stage2bTaskProfile>>> = Object.freeze({
  T1: Object.freeze({ taskId: 'T1', taskRoot: 'stage-2a', toolPolicy: 'required', recoveryMode: 'none' }),
  T2: Object.freeze({ taskId: 'T2', taskRoot: 'stage-2a', toolPolicy: 'required', recoveryMode: 'none' }),
  T6: Object.freeze({ taskId: 'T6', taskRoot: 'stage-2a', toolPolicy: 'required', recoveryMode: 'none' }),
  T7: Object.freeze({ taskId: 'T7', taskRoot: 'stage-2a', toolPolicy: 'required', recoveryMode: 'required' }),
  T9: Object.freeze({ taskId: 'T9', taskRoot: 'stage-2b', toolPolicy: 'forbidden', recoveryMode: 'none' }),
  T10: Object.freeze({ taskId: 'T10', taskRoot: 'stage-2b', toolPolicy: 'required', recoveryMode: 'none' }),
  T11: Object.freeze({ taskId: 'T11', taskRoot: 'stage-2b', toolPolicy: 'required', recoveryMode: 'natural' })
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
  if (id === 'diagnostic-v1') {
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
