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
  const parsed: unknown = JSON.parse(jsonDocument(text).text);
  return parseExperimentAnswer(projectAnswerFields(selectAnswerObject(parsed)));
}

export function diagnoseExperimentAnswer(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const document = jsonDocument(trimmed);
  const diagnostics: Record<string, unknown> = {
    textLength: text.length,
    trimmedLength: trimmed.length,
    hasMarkdownFence: /```/.test(trimmed),
    ...(document.markdownFenceUnwrapped ? { markdownFenceUnwrapped: true } : {}),
    ...(document.bareJsonObjectExtracted ? { bareJsonObjectExtracted: true } : {}),
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
  const nestedCandidates = findNestedAnswerObjects(parsed);
  diagnostics.nestedAnswerCandidateCount = nestedCandidates.values.length;
  if (nestedCandidates.truncated) diagnostics.answerCandidateScanTruncated = true;
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

function projectAnswerFields(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return {
    status: value.status,
    answer: value.answer,
    explanation: value.explanation
  };
}

function selectAnswerObject(value: unknown): unknown {
  if (hasAnswerFields(value)) return value;
  const candidates = findNestedAnswerObjects(value);
  return !candidates.truncated && candidates.values.length === 1
    ? candidates.values[0]
    : value;
}

function findNestedAnswerObjects(value: unknown): {
  values: Record<string, unknown>[];
  truncated: boolean;
} {
  const queue = childValues(value).map(child => ({ value: child, depth: 1 }));
  const values: Record<string, unknown>[] = [];
  let visited = 0;

  while (queue.length > 0 && visited < 256) {
    const current = queue.shift()!;
    visited += 1;
    if (hasAnswerFields(current.value)) {
      values.push(current.value);
      continue;
    }
    if (current.depth < 8) {
      queue.push(...childValues(current.value).map(child => ({
        value: child,
        depth: current.depth + 1
      })));
    }
  }
  return { values, truncated: queue.length > 0 };
}

function hasAnswerFields(value: unknown): value is Record<string, unknown> {
  return isRecord(value)
    && Object.hasOwn(value, 'status')
    && Object.hasOwn(value, 'answer')
    && Object.hasOwn(value, 'explanation');
}

function childValues(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return isRecord(value) ? Object.values(value) : [];
}

function jsonDocument(text: string): {
  text: string;
  markdownFenceUnwrapped: boolean;
  bareJsonObjectExtracted: boolean;
  surroundingTextPresent: boolean;
} {
  const trimmed = text.trim();
  if (isValidJson(trimmed)) {
    return {
      text: trimmed,
      markdownFenceUnwrapped: false,
      bareJsonObjectExtracted: false,
      surroundingTextPresent: false
    };
  }
  const fenceCount = trimmed.match(/```/g)?.length ?? 0;
  const fenced = fenceCount === 2
    ? /```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```/i.exec(trimmed)
    : null;
  if (fenced) {
    return {
      text: fenced[1]!,
      markdownFenceUnwrapped: true,
      bareJsonObjectExtracted: false,
      surroundingTextPresent: fenced[0].length !== trimmed.length
    };
  }
  if (fenceCount > 0) {
    return {
      text: trimmed,
      markdownFenceUnwrapped: false,
      bareJsonObjectExtracted: false,
      surroundingTextPresent: false
    };
  }
  const candidates = jsonObjectCandidates(trimmed).filter(isValidJson);
  if (candidates.length !== 1) {
    return {
      text: trimmed,
      markdownFenceUnwrapped: false,
      bareJsonObjectExtracted: false,
      surroundingTextPresent: false
    };
  }
  return {
    text: candidates[0]!,
    markdownFenceUnwrapped: false,
    bareJsonObjectExtracted: true,
    surroundingTextPresent: candidates[0]!.length !== trimmed.length
  };
}

function jsonObjectCandidates(text: string): string[] {
  const candidates: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (start < 0) {
      if (character === '{') {
        start = index;
        depth = 1;
      }
      continue;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        candidates.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return candidates;
}

function isValidJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
