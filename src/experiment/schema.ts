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

export function parseExperimentAnswerText(text: string): ExperimentAnswer {
  return parseExperimentAnswer(JSON.parse(jsonDocument(text).text));
}

export function diagnoseExperimentAnswer(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const document = jsonDocument(trimmed);
  const diagnostics: Record<string, unknown> = {
    textLength: text.length,
    trimmedLength: trimmed.length,
    hasMarkdownFence: /```/.test(trimmed),
    ...(document.markdownFenceUnwrapped ? { markdownFenceUnwrapped: true } : {}),
    ...(document.surroundingTextPresent ? { surroundingTextPresent: true } : {}),
    jsonParseSucceeded: false
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(document.text);
  } catch {
    return diagnostics;
  }

  diagnostics.jsonParseSucceeded = true;
  diagnostics.topLevelType = jsonType(parsed);
  if (isRecord(parsed)) {
    const expectedFields = ['status', 'answer', 'explanation'] as const;
    diagnostics.fields = Object.fromEntries(expectedFields.map(field => [field, {
      present: Object.hasOwn(parsed, field),
      type: Object.hasOwn(parsed, field) ? jsonType(parsed[field]) : 'missing'
    }]));
    diagnostics.unknownFieldCount = Object.keys(parsed)
      .filter(key => !expectedFields.includes(key as typeof expectedFields[number]))
      .length;
  }

  const validation = experimentAnswerSchema.safeParse(parsed);
  if (!validation.success) {
    diagnostics.validationIssues = validation.error.issues.map(issue => ({
      code: issue.code,
      path: issue.path.length === 0
        ? '<root>'
        : issue.path.map(part => typeof part === 'string' && ['status', 'answer', 'explanation'].includes(part)
          ? part
          : '<other>').join('.')
    }));
  }
  return diagnostics;
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

function jsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function jsonDocument(text: string): {
  text: string;
  markdownFenceUnwrapped: boolean;
  surroundingTextPresent: boolean;
} {
  const trimmed = text.trim();
  const fenceCount = trimmed.match(/```/g)?.length ?? 0;
  const fenced = fenceCount === 2
    ? /```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```/i.exec(trimmed)
    : null;
  if (!fenced) {
    return {
      text: trimmed,
      markdownFenceUnwrapped: false,
      surroundingTextPresent: false
    };
  }
  return {
    text: fenced[1]!,
    markdownFenceUnwrapped: true,
    surroundingTextPresent: fenced[0].length !== trimmed.length
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
