import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import type { ChildProcess, ChildProcessWithoutNullStreams, SpawnOptions } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import type { Limits } from './config.js';
import { internalJqToolError, JqToolError } from './jq-schema.js';
import type { JqQuerySuccess, JsonValue } from './jq-schema.js';

export interface ExecuteJqRequest {
  executable: string;
  filter: string;
  input: string;
  limits: Limits;
}

type TerminalReason = 'timeout' | 'output-limit';
type ExecuteTerminal = TerminalReason | JqToolError;
type ProcessSpawner = (executable: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
const verificationOutputLimitBytes = 1024 * 1024;
const terminationWatchdogMs = 100;
let processSpawner: ProcessSpawner = spawn;

export function setSpawnForTesting(spawner: ProcessSpawner): () => void {
  const previousSpawner = processSpawner;
  processSpawner = spawner;
  return () => {
    processSpawner = previousSpawner;
  };
}

const jqEnvironment = {
  PATH: process.env.PATH ?? '',
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8'
};

function errorMessage(stderr: Buffer[], fallback: string): string {
  const message = Buffer.concat(stderr).toString('utf8').trim();
  return (message || fallback).slice(0, 1000);
}

function internalError(): JqToolError {
  return internalJqToolError();
}

function guardLateErrorsAndDestroyStdio(child: ChildProcess): void {
  const ignoreError = (_error: Error): void => {};
  const streams: Array<Readable | Writable> = [];
  if (child.stdin) streams.push(child.stdin);
  if (child.stdout) streams.push(child.stdout);
  if (child.stderr) streams.push(child.stderr);

  child.on('error', ignoreError);
  for (const stream of streams) stream.on('error', ignoreError);

  const releaseGuards = (): void => {
    child.removeListener('error', ignoreError);
    child.removeListener('close', releaseGuards);
    for (const stream of streams) stream.removeListener('error', ignoreError);
  };
  child.once('close', releaseGuards);

  for (const stream of streams) {
    try {
      if (!stream.destroyed) stream.destroy();
    } catch {
      // Error guards remain until child close if a custom stream cannot be destroyed.
    }
  }
}

export async function executeJq(request: ExecuteJqRequest): Promise<JqQuerySuccess> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let terminal: ExecuteTerminal | undefined;
    let killRequested = false;
    let timeout: NodeJS.Timeout | undefined;
    let terminationWatchdog: NodeJS.Timeout | undefined;
    let cleanup = (): void => {};
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;

    const settle = (result: JqQuerySuccess | JqToolError, forced = false): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (terminationWatchdog) clearTimeout(terminationWatchdog);
      cleanup();
      if (forced) guardLateErrorsAndDestroyStdio(child);
      if (result instanceof JqToolError) reject(result);
      else resolve(result);
    };

    let child: ChildProcessWithoutNullStreams;
    try {
      child = processSpawner(request.executable, ['--compact-output', '--', request.filter], {
        shell: false,
        env: jqEnvironment,
        stdio: ['pipe', 'pipe', 'pipe']
      }) as ChildProcessWithoutNullStreams;
    } catch (error) {
      settle(internalError());
      return;
    }

    const terminalResult = (code: number | null): JqToolError => {
      if (terminal instanceof JqToolError) return terminal;
      if (terminal === 'timeout') return new JqToolError('TIMEOUT', 'jq execution timed out.', code);
      return new JqToolError('OUTPUT_LIMIT', 'jq output exceeded the configured limit.', code);
    };

    const requestTermination = (): void => {
      if (killRequested) return;
      killRequested = true;
      terminationWatchdog = setTimeout(() => {
        settle(terminalResult(null), true);
      }, terminationWatchdogMs);
      try {
        if (child.kill('SIGKILL') === false) return;
      } catch (error) {
        onChildError(error instanceof Error ? error : new Error('Unable to terminate jq.'));
      }
    };

    const stop = (reason: ExecuteTerminal): void => {
      if (settled || terminal) return;
      terminal = reason;
      requestTermination();
    };

    const collect = (chunks: Buffer[]) => (chunk: Buffer): void => {
      if (terminal) return;
      outputBytes += chunk.length;
      if (outputBytes > request.limits.outputLimitBytes) {
        stop('output-limit');
        return;
      }
      chunks.push(chunk);
    };

    const failFromStream = (_error: Error): void => stop(internalError());

    const onChildError = (error: Error): void => {
      if (!terminal) terminal = internalError();
      settle(terminalResult(null), killRequested);
    };
    const onStdoutData = collect(stdout);
    const onStderrData = collect(stderr);
    const onStdinError = (error: NodeJS.ErrnoException): void => {
      if (error.code === 'EPIPE') return;
      failFromStream(error);
    };
    const onClose = (code: number | null): void => {
      if (terminal) {
        settle(terminalResult(code));
        return;
      }
      if (code === 3) {
        settle(new JqToolError('JQ_SYNTAX_ERROR', errorMessage(stderr, 'jq filter syntax error.'), code));
        return;
      }
      if (code !== 0) {
        settle(new JqToolError('JQ_RUNTIME_ERROR', errorMessage(stderr, 'jq execution failed.'), code));
        return;
      }

      try {
        const values = Buffer.concat(stdout)
          .toString('utf8')
          .split('\n')
          .filter(line => line.length > 0)
          .map(line => JSON.parse(line) as JsonValue);
        settle({ ok: true, values, exitCode: 0 });
      } catch (error) {
        settle(internalError());
      }
    };

    cleanup = (): void => {
      child.removeListener('error', onChildError);
      child.stdout.removeListener('data', onStdoutData);
      child.stderr.removeListener('data', onStderrData);
      child.stdout.removeListener('error', failFromStream);
      child.stderr.removeListener('error', failFromStream);
      child.stdin.removeListener('error', onStdinError);
      child.removeListener('close', onClose);
    };
    child.once('error', onChildError);
    child.stdout.on('data', onStdoutData);
    child.stderr.on('data', onStderrData);
    child.stdout.once('error', failFromStream);
    child.stderr.once('error', failFromStream);
    child.stdin.once('error', onStdinError);
    child.once('close', onClose);

    timeout = setTimeout(() => stop('timeout'), request.limits.timeoutMs);
    try {
      child.stdin.end(request.input);
    } catch (error) {
      if (isErrno(error, 'EPIPE')) return;
      failFromStream(error instanceof Error ? error : new Error('Unable to write jq input.'));
    }
  });
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

export async function verifyJqExecutable(executable: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let terminationWatchdog: NodeJS.Timeout | undefined;
    let cleanup = (): void => {};
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let terminalError: JqToolError | undefined;

    const settle = (result: string | JqToolError, forced = false): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (terminationWatchdog) clearTimeout(terminationWatchdog);
      cleanup();
      if (forced) guardLateErrorsAndDestroyStdio(child);
      if (result instanceof JqToolError) reject(result);
      else resolve(result);
    };

    let child: ChildProcessWithoutNullStreams;
    try {
      child = processSpawner(executable, ['--version'], {
        shell: false,
        env: jqEnvironment,
        stdio: ['ignore', 'pipe', 'pipe']
      }) as ChildProcessWithoutNullStreams;
    } catch (error) {
      settle(internalError());
      return;
    }

    let killRequested = false;
    const requestTermination = (): void => {
      if (killRequested) return;
      killRequested = true;
      terminationWatchdog = setTimeout(() => {
        settle(terminalError ?? internalError(), true);
      }, terminationWatchdogMs);
      try {
        if (child.kill('SIGKILL') === false) return;
      } catch (error) {
        onChildError(error instanceof Error ? error : new Error('Unable to terminate jq.'));
      }
    };

    const stop = (error: JqToolError): void => {
      if (settled || terminalError) return;
      terminalError = error;
      requestTermination();
    };

    const collect = (chunks: Buffer[]) => (chunk: Buffer): void => {
      if (terminalError) return;
      outputBytes += chunk.length;
      if (outputBytes > verificationOutputLimitBytes) {
        stop(internalJqToolError());
        return;
      }
      chunks.push(chunk);
    };

    const fail = (error: unknown): void => {
      if (terminalError) return;
      stop(internalError());
    };

    const onChildError = (error: Error): void => {
      if (!terminalError) terminalError = internalError();
      settle(terminalError, killRequested);
    };

    const onStdoutData = collect(stdout);
    const onStderrData = collect(stderr);
    const onClose = (code: number | null): void => {
      if (terminalError) {
        settle(terminalError);
        return;
      }
      const version = Buffer.concat(stdout).toString('utf8').trim();
      if (code === 0 && version.startsWith('jq-')) {
        settle(version);
        return;
      }
      settle(internalJqToolError(code));
    };

    cleanup = (): void => {
      child.removeListener('error', onChildError);
      child.stdout.removeListener('data', onStdoutData);
      child.stderr.removeListener('data', onStderrData);
      child.stdout.removeListener('error', fail);
      child.stderr.removeListener('error', fail);
      child.removeListener('close', onClose);
    };
    child.once('error', onChildError);
    child.stdout.on('data', onStdoutData);
    child.stderr.on('data', onStderrData);
    child.stdout.once('error', fail);
    child.stderr.once('error', fail);
    child.once('close', onClose);

    timeout = setTimeout(() => {
      stop(internalJqToolError());
    }, 2000);
  });
}
