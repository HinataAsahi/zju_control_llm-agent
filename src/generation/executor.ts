import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams, SpawnOptions } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { jsonValueSchema, JqToolError, type JqSource, type JsonValue } from '../mcp/jq-schema.js';
import { resolveSource } from '../mcp/source-resolver.js';
import type { GeneratedToolBundle } from './materializer.js';

export type GeneratedSpawnFunction = (
  executable: string,
  args: readonly string[],
  options: SpawnOptions
) => ChildProcessWithoutNullStreams;

let spawnProcess: GeneratedSpawnFunction = spawn as GeneratedSpawnFunction;

export type GeneratedExecutionErrorCode =
  | 'INVALID_INPUT'
  | 'PATH_NOT_ALLOWED'
  | 'FILE_NOT_FOUND'
  | 'INPUT_TOO_LARGE'
  | 'CLI_EXIT'
  | 'TIMEOUT'
  | 'OUTPUT_LIMIT'
  | 'INVALID_OUTPUT'
  | 'INTERNAL_ERROR';

export type GeneratedExecutionOutput =
  | { ok: true; values: JsonValue[]; exitCode: 0 }
  | {
      ok: false;
      error: { code: GeneratedExecutionErrorCode; message: string };
      exitCode: number | null;
    };

export interface ExecuteGeneratedToolOptions {
  bundle: GeneratedToolBundle;
  executable: string;
  root: string;
  input: unknown;
}

export function setGeneratedSpawnForTesting(replacement: GeneratedSpawnFunction): () => void {
  const previous = spawnProcess;
  spawnProcess = replacement;
  return () => { spawnProcess = previous; };
}

export async function executeGeneratedTool(
  options: ExecuteGeneratedToolOptions
): Promise<GeneratedExecutionOutput> {
  try {
    const input = validateInput(options.input, options.bundle);
    const executable = options.executable.trim();
    if (!executable) return failure('INTERNAL_ERROR', null);
    const root = await canonicalDirectory(options.root);
    const sourceValue = input[options.bundle.execution.stdin.field];
    const source = parseJsonSource(sourceValue);
    const stdin = await resolveSource(source, {
      root,
      limits: {
        inputLimitBytes: options.bundle.execution.limits.inputBytes,
        outputLimitBytes: options.bundle.execution.limits.outputBytes,
        timeoutMs: options.bundle.execution.limits.timeoutMs
      }
    });
    const args = [...options.bundle.execution.fixedArgv];
    for (const binding of [...options.bundle.execution.argv].sort((left, right) => left.position - right.position)) {
      const value = input[binding.field];
      if (typeof value !== 'string') throw new InvalidGeneratedInputError();
      args.push(value);
    }
    return await runProcess(executable, args, stdin, options.bundle.execution.limits);
  } catch (error) {
    if (error instanceof InvalidGeneratedInputError) return failure('INVALID_INPUT', null);
    if (error instanceof JqToolError) {
      if (error.code === 'PATH_NOT_ALLOWED') return failure('PATH_NOT_ALLOWED', error.exitCode);
      if (error.code === 'FILE_NOT_FOUND') return failure('FILE_NOT_FOUND', error.exitCode);
      if (error.code === 'INPUT_TOO_LARGE') return failure('INPUT_TOO_LARGE', error.exitCode);
    }
    return failure('INTERNAL_ERROR', null);
  }
}

function validateInput(value: unknown, bundle: GeneratedToolBundle): Record<string, unknown> {
  if (!isRecord(value)) throw new InvalidGeneratedInputError();
  const properties = bundle.inputSchema.properties;
  if (Object.keys(value).some(key => !(key in properties))) throw new InvalidGeneratedInputError();
  for (const field of bundle.inputSchema.required) {
    if (!(field in value)) throw new InvalidGeneratedInputError();
  }
  for (const [field, schema] of Object.entries(properties)) {
    if (!(field in value)) continue;
    const fieldValue = value[field];
    if (schema.type === 'string') {
      if (typeof fieldValue !== 'string') throw new InvalidGeneratedInputError();
      const minLength = integerProperty(schema, 'minLength');
      const maxLength = integerProperty(schema, 'maxLength');
      if (fieldValue.length < minLength || Buffer.byteLength(fieldValue, 'utf8') > maxLength) {
        throw new InvalidGeneratedInputError();
      }
      continue;
    }
    if (Array.isArray(schema.oneOf)) {
      const source = parseJsonSource(fieldValue);
      if (!allowedSourceTypes(schema).has(source.type)) throw new InvalidGeneratedInputError();
      continue;
    }
    throw new InvalidGeneratedInputError();
  }
  return value;
}

function allowedSourceTypes(schema: Record<string, unknown>): Set<'inline' | 'file'> {
  const result = new Set<'inline' | 'file'>();
  if (!Array.isArray(schema.oneOf)) return result;
  for (const variant of schema.oneOf) {
    if (!isRecord(variant) || !isRecord(variant.properties)) continue;
    const typeSchema = variant.properties.type;
    if (!isRecord(typeSchema)) continue;
    if (typeSchema.const === 'inline' || typeSchema.const === 'file') result.add(typeSchema.const);
  }
  return result;
}

function integerProperty(value: Record<string, unknown>, key: string): number {
  const property = value[key];
  if (!Number.isSafeInteger(property) || (property as number) < 0) throw new InvalidGeneratedInputError();
  return property as number;
}

function parseJsonSource(value: unknown): JqSource {
  if (!isRecord(value) || typeof value.type !== 'string') throw new InvalidGeneratedInputError();
  if (value.type === 'inline') {
    if (Object.keys(value).some(key => key !== 'type' && key !== 'data') || !('data' in value)) {
      throw new InvalidGeneratedInputError();
    }
    const result = jsonValueSchema.safeParse(value.data);
    if (!result.success) throw new InvalidGeneratedInputError();
    return { type: 'inline', data: result.data };
  }
  if (value.type === 'file') {
    if (
      Object.keys(value).some(key => key !== 'type' && key !== 'path')
      || typeof value.path !== 'string'
      || value.path.length === 0
    ) {
      throw new InvalidGeneratedInputError();
    }
    return { type: 'file', path: value.path };
  }
  throw new InvalidGeneratedInputError();
}

async function canonicalDirectory(path: string): Promise<string> {
  const canonical = await realpath(path);
  const metadata = await stat(canonical);
  if (!metadata.isDirectory()) throw new Error('Generated tool root is unavailable.');
  return canonical;
}

async function runProcess(
  executable: string,
  args: readonly string[],
  input: string,
  limits: GeneratedToolBundle['execution']['limits']
): Promise<GeneratedExecutionOutput> {
  return new Promise(resolve => {
    let settled = false;
    let outputBytes = 0;
    let termination: 'timeout' | 'output' | undefined;
    const stdout: Buffer[] = [];
    const child = spawnProcess(executable, args, {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: restrictedEnvironment()
    });
    let forceSettle: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => terminate('timeout'), limits.timeoutMs);

    function finish(result: GeneratedExecutionOutput): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceSettle) clearTimeout(forceSettle);
      resolve(result);
    }

    function terminate(reason: 'timeout' | 'output'): void {
      if (settled || termination) return;
      termination = reason;
      try { child.kill('SIGKILL'); } catch { /* The stable termination result remains authoritative. */ }
      forceSettle = setTimeout(() => finish(reason === 'timeout'
        ? failure('TIMEOUT', null)
        : failure('OUTPUT_LIMIT', null)), 100);
    }

    function capture(target: Buffer[] | undefined, chunk: Buffer | string): void {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += buffer.byteLength;
      if (outputBytes > limits.outputBytes) {
        terminate('output');
      } else if (target) {
        target.push(buffer);
      }
    }

    child.stdout.on('data', chunk => capture(stdout, chunk));
    child.stderr.on('data', chunk => capture(undefined, chunk));
    child.stdout.once('error', () => finish(failure('INTERNAL_ERROR', null)));
    child.stderr.once('error', () => finish(failure('INTERNAL_ERROR', null)));
    child.stdin.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') finish(failure('INTERNAL_ERROR', null));
    });
    child.once('error', () => finish(failure('INTERNAL_ERROR', null)));
    child.once('close', code => {
      if (termination === 'timeout') return finish(failure('TIMEOUT', null));
      if (termination === 'output') return finish(failure('OUTPUT_LIMIT', null));
      if (code !== 0) return finish(failure('CLI_EXIT', code));
      try {
        const values = parseJsonLines(Buffer.concat(stdout).toString('utf8'));
        finish({ ok: true, values, exitCode: 0 });
      } catch {
        finish(failure('INVALID_OUTPUT', 0));
      }
    });
    try {
      child.stdin.end(input);
    } catch (error) {
      if (!isErrno(error, 'EPIPE')) finish(failure('INTERNAL_ERROR', null));
    }
  });
}

function parseJsonLines(output: string): JsonValue[] {
  const values: JsonValue[] = [];
  for (const line of output.split('\n')) {
    if (!line) continue;
    const parsed: unknown = JSON.parse(line);
    const result = jsonValueSchema.safeParse(parsed);
    if (!result.success) throw new Error('Invalid JSON output.');
    values.push(result.data);
  }
  return values;
}

function failure(code: GeneratedExecutionErrorCode, exitCode: number | null): GeneratedExecutionOutput {
  const messages: Record<GeneratedExecutionErrorCode, string> = {
    INVALID_INPUT: 'Generated tool input is invalid.',
    PATH_NOT_ALLOWED: 'Generated tool path is not allowed.',
    FILE_NOT_FOUND: 'Generated tool input file was not found.',
    INPUT_TOO_LARGE: 'Generated tool input exceeded its limit.',
    CLI_EXIT: 'Generated CLI execution failed.',
    TIMEOUT: 'Generated CLI execution timed out.',
    OUTPUT_LIMIT: 'Generated CLI output exceeded its limit.',
    INVALID_OUTPUT: 'Generated CLI returned invalid structured output.',
    INTERNAL_ERROR: 'Generated tool encountered an internal error.'
  };
  return { ok: false, error: { code, message: messages[code] }, exitCode };
}

function restrictedEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8'
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

class InvalidGeneratedInputError extends Error {}
