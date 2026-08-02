import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeJq, setSpawnForTesting, verifyJqExecutable } from '../src/jq-executor.js';
import type { Limits } from '../src/config.js';
import { JqToolError } from '../src/jq-schema.js';

function limits(overrides: Partial<Limits> = {}): Limits {
  return {
    inputLimitBytes: 1024 * 1024,
    outputLimitBytes: 1024 * 1024,
    timeoutMs: 5000,
    ...overrides
  };
}

function expectsCode(code: JqToolError['code']): (error: unknown) => boolean {
  return (error: unknown) => error instanceof JqToolError && error.code === code;
}

async function createExecutable(t: test.TestContext, source: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'jq-executor-'));
  const executable = join(directory, 'fake-jq');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(executable, `#!/bin/sh\n${source}`);
  await chmod(executable, 0o700);
  return executable;
}

type FakeChild = ReturnType<typeof spawn> & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
};

function childWhoseKillEmitsError(): FakeChild {
  const child = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  Object.assign(child, {
    stdin,
    stdout,
    stderr,
    kill: (): boolean => {
      child.emit('error', new Error('signal delivery failed'));
      return false;
    }
  });
  return child as FakeChild;
}

test('executes jq and parses compact output values', async () => {
  assert.deepEqual(await executeJq({
    executable: 'jq', filter: '.users[]', input: '{"users":["Alice","Bob"]}', limits: limits()
  }), { ok: true, values: ['Alice', 'Bob'], exitCode: 0 });
});

test('returns no values when jq emits no output', async () => {
  const result = await executeJq({
    executable: 'jq', filter: 'empty', input: 'null', limits: limits()
  });

  assert.deepEqual(result.values, []);
});

test('maps jq filter syntax errors', async () => {
  await assert.rejects(
    executeJq({ executable: 'jq', filter: 'if', input: 'null', limits: limits() }),
    expectsCode('JQ_SYNTAX_ERROR')
  );
});

test('maps jq filter runtime errors', async () => {
  await assert.rejects(
    executeJq({ executable: 'jq', filter: 'error("boom")', input: 'null', limits: limits() }),
    expectsCode('JQ_RUNTIME_ERROR')
  );
});

test('maps invalid JSON input to jq runtime errors', async () => {
  await assert.rejects(
    executeJq({ executable: 'jq', filter: '.', input: '{', limits: limits() }),
    expectsCode('JQ_RUNTIME_ERROR')
  );
});

test('kills jq when it exceeds the timeout', async () => {
  await assert.rejects(
    executeJq({
      executable: 'jq', filter: 'def forever: forever; forever', input: 'null',
      limits: limits({ timeoutMs: 50 })
    }),
    expectsCode('TIMEOUT')
  );
});

test('kills jq when combined output exceeds its byte cap', async () => {
  await assert.rejects(
    executeJq({
      executable: 'jq', filter: 'range(0; 10000)', input: 'null',
      limits: limits({ outputLimitBytes: 128 })
    }),
    expectsCode('OUTPUT_LIMIT')
  );
});

test('allows output exactly at the configured byte cap', async () => {
  assert.deepEqual(await executeJq({
    executable: 'jq', filter: '.', input: 'null', limits: limits({ outputLimitBytes: 5 })
  }), { ok: true, values: [null], exitCode: 0 });
});

test('accounts for stderr in jq output limits', async () => {
  await assert.rejects(
    executeJq({
      executable: 'jq', filter: '., error("x")', input: 'null',
      limits: limits({ outputLimitBytes: 5 })
    }),
    expectsCode('OUTPUT_LIMIT')
  );
});

test('handles kill errors after stream failures without uncaught events', async (t) => {
  const child = childWhoseKillEmitsError();
  t.after(setSpawnForTesting((() => child) as typeof spawn));

  const execution = executeJq({ executable: 'jq', filter: '.', input: 'null', limits: limits() });
  const rejection = assert.rejects(execution, (error: unknown) => error instanceof JqToolError
    && error.code === 'INTERNAL_ERROR'
    && error.message === 'Internal jq tool error');

  assert.doesNotThrow(() => child.stdout.emit('error', new Error('stream failed')));
  await rejection;
});

test('verifies jq executables by version', async () => {
  await assert.match(await verifyJqExecutable('jq'), /^jq-/);
});

test('terminates executable verification when combined output exceeds 1 MiB', async (t) => {
  const executable = await createExecutable(
    t,
    "while :; do printf '%65536s' ''; printf '%65536s' '' >&2; done"
  );

  await assert.rejects(
    verifyJqExecutable(executable),
    (error: unknown) => error instanceof JqToolError
      && error.code === 'INTERNAL_ERROR'
      && error.message === 'Internal jq tool error'
  );
});

test('maps a missing jq executable to an internal error', async () => {
  await assert.rejects(
    verifyJqExecutable('jq-does-not-exist'),
    (error: unknown) => error instanceof JqToolError
      && error.code === 'INTERNAL_ERROR'
      && error.message === 'Internal jq tool error'
  );
});
