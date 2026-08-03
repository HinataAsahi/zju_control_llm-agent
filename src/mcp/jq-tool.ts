import type { AppConfig } from './config.js';
import { executeJq } from './jq-executor.js';
import {
  INTERNAL_ERROR_MESSAGE,
  JqToolError,
  type JqQueryFailure,
  type JqQueryInput,
  type JqQueryOutput
} from './jq-schema.js';
import { resolveSource } from './source-resolver.js';

export interface JqToolDependencies {
  resolveSource: typeof resolveSource;
  executeJq: typeof executeJq;
}

function formatToolResult(output: JqQueryOutput, isError: boolean) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(output) }],
    structuredContent: output,
    ...(isError ? { isError: true as const } : {})
  };
}

export function createJqToolHandler(
  config: AppConfig,
  dependencies: JqToolDependencies = { resolveSource, executeJq }
) {
  return async (input: JqQueryInput) => {
    try {
      const jsonInput = await dependencies.resolveSource(input.source, config);
      const output = await dependencies.executeJq({
        executable: config.jqExecutable,
        filter: input.filter,
        input: jsonInput,
        limits: config.limits
      });
      return formatToolResult(output, false);
    } catch (error) {
      const output: JqQueryFailure = error instanceof JqToolError
        ? {
          ok: false,
          error: {
            code: error.code,
            message: error.code === 'INTERNAL_ERROR' ? INTERNAL_ERROR_MESSAGE : error.message
          },
          exitCode: error.exitCode
        }
        : { ok: false, error: { code: 'INTERNAL_ERROR', message: INTERNAL_ERROR_MESSAGE }, exitCode: null };
      return formatToolResult(output, true);
    }
  };
}
