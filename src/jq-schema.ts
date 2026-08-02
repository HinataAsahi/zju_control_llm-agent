import { Buffer } from 'node:buffer';
import * as z from 'zod/v4';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number(), z.string(),
  z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema)
]));

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
