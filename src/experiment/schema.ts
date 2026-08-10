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

export const experimentAnswerSchema: z.ZodType<ExperimentAnswer> = z.strictObject({
  status: z.enum(['completed', 'cannot_complete']),
  answer: jsonValueSchema,
  explanation: z.string()
});

export function parseExperimentAnswer(value: unknown): ExperimentAnswer {
  return experimentAnswerSchema.parse(value);
}

export function answerMatchesExpected(
  answer: ExperimentAnswer,
  expected: ExperimentTask['expected']
): boolean {
  return answer.status === expected.status
    && canonicalJson(answer.answer) === canonicalJson(expected.answer);
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

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
