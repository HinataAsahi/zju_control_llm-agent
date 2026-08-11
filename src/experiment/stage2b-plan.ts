import { STAGE2B_LIMITS } from '../agent/agent-loop.js';
import { DEEPSEEK_TEMPERATURE } from '../agent/deepseek-client.js';
import type { ExperimentCondition } from './schema.js';

export const STAGE2B_PLAN_MAX_REPETITIONS = 100;
export const STAGE2B_PLAN_TASKS = ['T2', 'T7'] as const;
export const STAGE2B_PLAN_CONDITIONS: readonly ExperimentCondition[] = [
  'explicit',
  'description',
  'skill'
];

export interface Stage2bPlanRun {
  taskId: 'T2' | 'T7';
  condition: ExperimentCondition;
  repetition: number;
}

export interface Stage2bPlan {
  version: 1;
  mode: 'plan';
  tasks: Array<'T2' | 'T7'>;
  conditions: ExperimentCondition[];
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
  runs: Stage2bPlanRun[];
}

export function createStage2bPlan(repetitions = 1): Stage2bPlan {
  validateStage2bPlanRepetitions(repetitions);
  const runs = STAGE2B_PLAN_TASKS.flatMap(taskId =>
    STAGE2B_PLAN_CONDITIONS.flatMap(condition =>
      Array.from({ length: repetitions }, (_, index) => ({
        taskId,
        condition,
        repetition: index + 1
      }))
    )
  );
  return {
    version: 1,
    mode: 'plan',
    tasks: [...STAGE2B_PLAN_TASKS],
    conditions: [...STAGE2B_PLAN_CONDITIONS],
    repetitions,
    totalRuns: runs.length,
    requiresApiKey: false,
    sampling: { temperature: DEEPSEEK_TEMPERATURE },
    upperBounds: {
      modelRequests: runs.length * STAGE2B_LIMITS.maxTurns,
      toolCalls: runs.length * STAGE2B_LIMITS.maxToolCalls
    },
    runs
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
