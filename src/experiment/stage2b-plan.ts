import { STAGE2B_LIMITS } from '../agent/agent-loop.js';
import { DEEPSEEK_TEMPERATURE } from '../agent/deepseek-client.js';
import type { ExperimentCondition } from './schema.js';
import {
  expandStage2bSuite,
  getStage2bSuite,
  type Stage2bSuiteId,
  type Stage2bTreatment
} from './stage2b-suite.js';

export const STAGE2B_PLAN_MAX_REPETITIONS = 100;
export const STAGE2B_PLAN_TASKS = ['T2', 'T7'] as const;
export const STAGE2B_PLAN_CONDITIONS: readonly ExperimentCondition[] = [
  'explicit',
  'description',
  'skill'
];

export type Stage2bSuiteTaskId<Suite extends Stage2bSuiteId> = Suite extends 'baseline-v1'
  ? 'T2' | 'T7'
  : Suite extends 'diagnostic-v1'
    ? 'T9' | 'T10' | 'T11'
    : 'T12' | 'T13' | 'T14' | 'T15' | 'T16' | 'T17';

export interface Stage2bPlanRun<Suite extends Stage2bSuiteId = Stage2bSuiteId> {
  taskId: Stage2bSuiteTaskId<Suite>;
  condition: Stage2bTreatment;
  repetition: number;
}

export interface Stage2bPlan<Suite extends Stage2bSuiteId = Stage2bSuiteId> {
  version: 2;
  mode: 'plan';
  suite: Suite;
  tasks: Array<Stage2bSuiteTaskId<Suite>>;
  conditions: Stage2bTreatment[];
  repetitions: number;
  totalRuns: number;
  requiresApiKey: false;
  sampling: {
    temperature: number;
  };
  upperBounds: {
    modelRequests: number;
    toolCalls: number;
  };
  runs: Stage2bPlanRun<Suite>[];
}

export function createStage2bPlan(): Stage2bPlan<'baseline-v1'>;
export function createStage2bPlan(repetitions: number): Stage2bPlan<'baseline-v1'>;
export function createStage2bPlan<Suite extends Stage2bSuiteId>(
  repetitions: number,
  suite: Suite
): Stage2bPlan<Suite>;
export function createStage2bPlan(
  repetitions = 1,
  suite: Stage2bSuiteId = 'baseline-v1'
): Stage2bPlan {
  validateStage2bPlanRepetitions(repetitions);
  const runs = expandStage2bSuite(suite, repetitions);
  const selectedSuite = getStage2bSuite(suite);
  return {
    version: 2,
    mode: 'plan',
    suite,
    tasks: [...selectedSuite.taskIds] as Stage2bSuiteTaskId<Stage2bSuiteId>[],
    conditions: [...new Set(runs.map(run => run.condition))],
    repetitions,
    totalRuns: runs.length,
    requiresApiKey: false,
    sampling: { temperature: DEEPSEEK_TEMPERATURE },
    upperBounds: {
      modelRequests: runs.length * STAGE2B_LIMITS.maxTurns,
      toolCalls: runs.length * STAGE2B_LIMITS.maxToolCalls
    },
    runs: runs as Stage2bPlanRun[]
  };
}

export function validateStage2bPlanRepetitions(repetitions: number): void {
  if (
    !Number.isSafeInteger(repetitions)
    || repetitions < 1
    || repetitions > STAGE2B_PLAN_MAX_REPETITIONS
  ) {
    throw new Error(
      `Repetitions must be an integer from 1 to ${STAGE2B_PLAN_MAX_REPETITIONS}.`
    );
  }
}
