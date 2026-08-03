import * as z from 'zod/v4';
import { jsonValueSchema, type JsonValue } from '../mcp/jq-schema.js';

export type ExperimentCondition = 'explicit' | 'description' | 'skill';
export type TaskKind = 'normal' | 'missing-file' | 'error-recovery' | 'negative';

export interface ExperimentAnswer {
  status: 'completed' | 'cannot_complete';
  answer: JsonValue;
  explanation: string;
}

export interface ExperimentTask {
  id: `T${number}`;
  kind: TaskKind;
  prompt: string;
  inputFiles: string[];
  expected: Pick<ExperimentAnswer, 'status' | 'answer'>;
}

export const experimentTaskSchema: z.ZodType<ExperimentTask> = z.strictObject({
  id: z.string().regex(/^T[1-9]\d*$/) as z.ZodType<`T${number}`>,
  kind: z.enum(['normal', 'missing-file', 'error-recovery', 'negative']),
  prompt: z.string().min(1),
  inputFiles: z.array(z.string().min(1)),
  expected: z.strictObject({
    status: z.enum(['completed', 'cannot_complete']),
    answer: jsonValueSchema
  })
});
