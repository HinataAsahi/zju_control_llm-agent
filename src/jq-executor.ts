import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import type { Limits } from './config.js';
import { JqToolError } from './jq-schema.js';
import type { JqQuerySuccess, JsonValue } from './jq-schema.js';

export interface ExecuteJqRequest {
  executable: string;
  filter: string;
  input: string;
  limits: Limits;
}

type TerminalReason = 'timeout' | 'output-limit';
const verificationOutputLimitBytes = 1024 * 1024;

const jqEnvironment = {
  PATH: process.env.PATH ?? '',
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8'
};

function errorMessage(stderr: Buffer[], fallback: string): string {
  const message = Buffer.concat(stderr).toString('utf8').trim();
  return (message || fallback).slice(0, 1000);
}

function internalError(error: unknown): JqToolError {
  const message = error instanceof Error ? error.message : 'Unable to execute jq.';
  return new JqToolError('INTERNAL_ERROR', message);
}

export async function executeJq(request: ExecuteJqRequest): Promise<JqQuerySuccess> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let terminalReason: TerminalReason | undefined;
    let timeout: NodeJS.Timeout | undefined;
    let cleanup = (): void => {};
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;

    const settle = (result: JqQuerySuccess | JqToolError): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      cleanup();
      if (result instanceof JqToolError) reject(result);
      else resolve(result);
    };

    let child;
    try {
      child = spawn(request.executable, ['--compact-output', '--', request.filter], {
        shell: false,
        env: jqEnvironment,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (error) {
      settle(internalError(error));
      return;
    }

    const stop = (reason: TerminalReason): void => {
      if (settled || terminalReason) return;
      terminalReason = reason;
      child.kill('SIGKILL');
    };

    const collect = (chunks: Buffer[]) => (chunk: Buffer): void => {
      if (terminalReason) return;
      outputBytes += chunk.length;
      if (outputBytes > request.limits.outputLimitBytes) {
        stop('output-limit');
        return;
      }
      chunks.push(chunk);
    };

    const failFromStream = (error: Error): void => {
      if (terminalReason) return;
      settle(internalError(error));
      child.kill('SIGKILL');
    };

    const onChildError = (error: Error): void => failFromStream(error);
    const onStdoutData = collect(stdout);
    const onStderrData = collect(stderr);
    const onStdinError = (error: NodeJS.ErrnoException): void => {
      if (terminalReason && error.code === 'EPIPE') return;
      failFromStream(error);
    };
    const onClose = (code: number | null): void => {
      if (terminalReason === 'timeout') {
        settle(new JqToolError('TIMEOUT', 'jq execution timed out.', code));
        return;
      }
      if (terminalReason === 'output-limit') {
        settle(new JqToolError('OUTPUT_LIMIT', 'jq output exceeded the configured limit.', code));
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
        settle(internalError(error));
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
      failFromStream(error instanceof Error ? error : new Error('Unable to write jq input.'));
    }
  });
}

export async function verifyJqExecutable(executable: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let cleanup = (): void => {};
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let terminalError: JqToolError | undefined;

    const settle = (result: string | JqToolError): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      cleanup();
      if (result instanceof JqToolError) reject(result);
      else resolve(result);
    };

    let child;
    try {
      child = spawn(executable, ['--version'], {
        shell: false,
        env: jqEnvironment,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      settle(internalError(error));
      return;
    }

    const stop = (error: JqToolError): void => {
      if (settled || terminalError) return;
      terminalError = error;
      child.kill('SIGKILL');
    };

    const collect = (chunks: Buffer[]) => (chunk: Buffer): void => {
      if (terminalError) return;
      outputBytes += chunk.length;
      if (outputBytes > verificationOutputLimitBytes) {
        stop(new JqToolError('INTERNAL_ERROR', 'jq executable verification output exceeded 1 MiB.'));
        return;
      }
      chunks.push(chunk);
    };

    const fail = (error: unknown): void => {
      if (terminalError) return;
      settle(internalError(error));
      child.kill('SIGKILL');
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
      settle(new JqToolError(
        'INTERNAL_ERROR',
        errorMessage(stderr, 'Unable to verify jq executable.'),
        code
      ));
    };

    cleanup = (): void => {
      child.removeListener('error', fail);
      child.stdout.removeListener('data', onStdoutData);
      child.stderr.removeListener('data', onStderrData);
      child.stdout.removeListener('error', fail);
      child.stderr.removeListener('error', fail);
      child.removeListener('close', onClose);
    };
    child.once('error', fail);
    child.stdout.on('data', onStdoutData);
    child.stderr.on('data', onStderrData);
    child.stdout.once('error', fail);
    child.stderr.once('error', fail);
    child.once('close', onClose);

    timeout = setTimeout(() => {
      stop(new JqToolError('INTERNAL_ERROR', 'jq executable verification timed out.'));
    }, 2000);
  });
}
