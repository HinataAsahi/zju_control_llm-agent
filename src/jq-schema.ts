import { Buffer } from 'node:buffer';
import * as z from 'zod/v4';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export const MAX_JSON_DEPTH = 128;

interface PendingJsonValue {
  value: unknown;
  depth: number;
  path: (string | number)[];
  exiting?: boolean;
}

interface JsonValidationIssue {
  message: string;
  path: (string | number)[];
}

export const jsonValueSchema = z.unknown().superRefine((value, context) => {
  const issue = findJsonValidationIssue(value);
  if (issue) context.addIssue({ code: 'custom', ...issue });
}) as z.ZodType<JsonValue>;

function findJsonValidationIssue(root: unknown): JsonValidationIssue | undefined {
  const pending: PendingJsonValue[] = [{ value: root, depth: 0, path: [] }];
  const ancestors = new WeakSet<object>();

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;

    if (current.exiting) {
      ancestors.delete(current.value as object);
      continue;
    }
    if (current.depth > MAX_JSON_DEPTH) {
      return {
        message: `JSON nesting must not exceed ${MAX_JSON_DEPTH} levels`,
        path: current.path
      };
    }

    const { value } = current;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') continue;
    if (typeof value === 'number') {
      if (Number.isFinite(value)) continue;
      return { message: 'JSON numbers must be finite', path: current.path };
    }
    if (typeof value !== 'object') {
      return { message: 'Value must be valid JSON', path: current.path };
    }

    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
      return { message: 'Value must be valid JSON', path: current.path };
    }
    if (ancestors.has(value)) {
      return { message: 'JSON values must not contain cycles', path: current.path };
    }

    ancestors.add(value);
    pending.push({ ...current, exiting: true });
    const entries = Array.isArray(value)
      ? value.map((entry, index) => [index, entry] as const)
      : Object.entries(value);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (!entry) continue;
      pending.push({
        value: entry[1],
        depth: current.depth + 1,
        path: [...current.path, entry[0]]
      });
    }
  }

  return undefined;
}

const inlineSourceSchema = z.strictObject({ type: z.literal('inline'), data: jsonValueSchema });
const fileSourceSchema = z.strictObject({ type: z.literal('file'), path: z.string().min(1) });

export const jqQueryInputSchema = z.strictObject({
  filter: z.string().min(1).refine(
    value => Buffer.byteLength(value, 'utf8') <= 4 * 1024,
    'filter must be at most 4 KiB in UTF-8'
  ),
  source: z.discriminatedUnion('type', [inlineSourceSchema, fileSourceSchema])
});

export const jqErrorCodeSchema = z.enum([
  'PATH_NOT_ALLOWED', 'FILE_NOT_FOUND', 'INPUT_TOO_LARGE',
  'JQ_SYNTAX_ERROR', 'JQ_RUNTIME_ERROR', 'TIMEOUT',
  'OUTPUT_LIMIT', 'INTERNAL_ERROR'
]);

export const INTERNAL_ERROR_MESSAGE = 'Internal jq tool error';

export const jqQuerySuccessSchema = z.strictObject({
  ok: z.literal(true), values: z.array(jsonValueSchema), exitCode: z.literal(0)
});
export const jqQueryFailureSchema = z.strictObject({
  ok: z.literal(false),
  error: z.strictObject({ code: jqErrorCodeSchema, message: z.string() }),
  exitCode: z.number().int().nullable()
});
export const jqQueryOutputSchema = z.discriminatedUnion('ok', [jqQuerySuccessSchema, jqQueryFailureSchema]);

export type JqSource = z.infer<typeof inlineSourceSchema> | z.infer<typeof fileSourceSchema>;
export type JqQueryInput = z.infer<typeof jqQueryInputSchema>;
export type JqErrorCode = z.infer<typeof jqErrorCodeSchema>;
export type JqQuerySuccess = z.infer<typeof jqQuerySuccessSchema>;
export type JqQueryFailure = z.infer<typeof jqQueryFailureSchema>;
export type JqQueryOutput = z.infer<typeof jqQueryOutputSchema>;

export class JqToolError extends Error {
  constructor(
    public readonly code: JqErrorCode,
    message: string,
    public readonly exitCode: number | null = null
  ) {
    super(message);
    this.name = 'JqToolError';
  }
}

export function internalJqToolError(exitCode: number | null = null): JqToolError {
  return new JqToolError('INTERNAL_ERROR', INTERNAL_ERROR_MESSAGE, exitCode);
}
