import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeJq, setSpawnForTesting, verifyJqExecutable } from '../src/jq-executor.js';
import type { SpawnOptions } from 'node:child_process';
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

function childWhoseKillReturnsFalse(): FakeChild {
  const child = new EventEmitter();
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: (): boolean => false
  });
  return child as FakeChild;
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs = 500): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error('Test deadline exceeded.')), timeoutMs);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function assertRestrictedSpawnOptions(options: SpawnOptions, stdio: ['pipe' | 'ignore', 'pipe', 'pipe']): void {
  assert.equal(options.shell, false);
  assert.deepEqual(options.stdio, stdio);
  assert.deepEqual(Object.keys(options.env ?? {}).sort(), ['LANG', 'LC_ALL', 'PATH']);
  assert.equal(options.env?.LANG, 'C.UTF-8');
  assert.equal(options.env?.LC_ALL, 'C.UTF-8');
  assert.equal(typeof options.env?.PATH, 'string');
  assert.equal(options.env?.JQ_TEST_CREDENTIAL, undefined);
}

test('executes jq and parses compact output values', async () => {
  assert.deepEqual(await executeJq({
    executable: 'jq', filter: '.users[]', input: '{"users":["Alice","Bob"]}', limits: limits()
  }), { ok: true, values: ['Alice', 'Bob'], exitCode: 0 });
});

test('spawns jq execution with fixed arguments and a restricted environment', async (t) => {
  const child = childWhoseKillReturnsFalse();
  let invocation: { executable: string; args: readonly string[]; options: SpawnOptions } | undefined;
  const previousCredential = process.env.JQ_TEST_CREDENTIAL;
  process.env.JQ_TEST_CREDENTIAL = 'must-not-be-inherited';
  t.after(() => {
    if (previousCredential === undefined) delete process.env.JQ_TEST_CREDENTIAL;
    else process.env.JQ_TEST_CREDENTIAL = previousCredential;
  });
  t.after(setSpawnForTesting((executable, args, options) => {
    invocation = { executable, args, options };
    return child;
  }));

  const execution = executeJq({
    executable: 'jq-test-binary', filter: '.users', input: '{}', limits: limits()
  });
  child.stdout.write('null\n');
  child.emit('close', 0);
  await execution;

  assert.ok(invocation);
  assert.equal(invocation.executable, 'jq-test-binary');
  assert.deepEqual(invocation.args, ['--compact-output', '--', '.users']);
  assertRestrictedSpawnOptions(invocation.options, ['pipe', 'pipe', 'pipe']);
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

test('preserves jq syntax classification when jq closes large stdin early', async () => {
  const inputLimitBytes = 1024 * 1024;
  const input = `${' '.repeat(inputLimitBytes - 4)}null`;

  await assert.rejects(
    executeJq({ executable: 'jq', filter: 'if', input, limits: limits({ inputLimitBytes }) }),
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

test('preserves jq runtime classification when malformed large stdin closes early', async () => {
  const inputLimitBytes = 1024 * 1024;
  const input = `{]${' '.repeat(inputLimitBytes - 2)}`;

  await assert.rejects(
    executeJq({ executable: 'jq', filter: '.', input, limits: limits({ inputLimitBytes }) }),
    expectsCode('JQ_RUNTIME_ERROR')
  );
});

test('defers a synchronous stdin EPIPE to jq close classification', async (t) => {
  const child = childWhoseKillReturnsFalse();
  child.stdin.end = (() => {
    const error = new Error('pipe closed') as NodeJS.ErrnoException;
    error.code = 'EPIPE';
    throw error;
  }) as typeof child.stdin.end;
  t.after(setSpawnForTesting((() => child) as typeof spawn));

  const execution = executeJq({ executable: 'jq', filter: 'if', input: 'null', limits: limits() });
  child.emit('close', 3);

  await assert.rejects(execution, expectsCode('JQ_SYNTAX_ERROR'));
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

test('redacts non-EPIPE stdin failures', async (t) => {
  const child = childWhoseKillReturnsFalse();
  t.after(setSpawnForTesting((() => child) as typeof spawn));

  const execution = executeJq({ executable: 'jq', filter: '.', input: 'null', limits: limits() });
  child.stdin.emit('error', new Error('sensitive stdin failure'));

  await assert.rejects(
    withDeadline(execution),
    (error: unknown) => error instanceof JqToolError
      && error.code === 'INTERNAL_ERROR'
      && error.message === 'Internal jq tool error'
  );
});

test('settles a timed-out execution when kill returns false and no event follows', async (t) => {
  const child = childWhoseKillReturnsFalse();
  t.after(setSpawnForTesting((() => child) as typeof spawn));

  await assert.rejects(
    withDeadline(executeJq({
      executable: 'jq', filter: '.', input: 'null', limits: limits({ timeoutMs: 10 })
    })),
    expectsCode('TIMEOUT')
  );
});

test('settles output overflow when kill returns false and no event follows', async (t) => {
  const child = childWhoseKillReturnsFalse();
  t.after(setSpawnForTesting((() => child) as typeof spawn));

  const execution = executeJq({
    executable: 'jq', filter: '.', input: 'null', limits: limits({ outputLimitBytes: 8 })
  });
  child.stdout.write(Buffer.alloc(9));

  await assert.rejects(withDeadline(execution), expectsCode('OUTPUT_LIMIT'));
  assert.equal(child.stdin.destroyed, true);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
  assert.doesNotThrow(() => child.emit('error', new Error('late child error')));
  assert.doesNotThrow(() => child.stdout.emit('error', new Error('late stdout error')));
  child.emit('close', null);
  assert.equal(child.listenerCount('error'), 0);
  assert.equal(child.stdout.listenerCount('error'), 0);
  assert.equal(child.stderr.listenerCount('error'), 0);
});

test('verifies jq executables by version', async () => {
  await assert.match(await verifyJqExecutable('jq'), /^jq-/);
});

test('spawns jq verification with fixed arguments and a restricted environment', async (t) => {
  const child = childWhoseKillReturnsFalse();
  let invocation: { executable: string; args: readonly string[]; options: SpawnOptions } | undefined;
  const previousCredential = process.env.JQ_TEST_CREDENTIAL;
  process.env.JQ_TEST_CREDENTIAL = 'must-not-be-inherited';
  t.after(() => {
    if (previousCredential === undefined) delete process.env.JQ_TEST_CREDENTIAL;
    else process.env.JQ_TEST_CREDENTIAL = previousCredential;
  });
  t.after(setSpawnForTesting((executable, args, options) => {
    invocation = { executable, args, options };
    return child;
  }));

  const verification = verifyJqExecutable('jq-test-binary');
  child.stdout.write('jq-1.8.2\n');
  child.emit('close', 0);
  await verification;

  assert.ok(invocation);
  assert.equal(invocation.executable, 'jq-test-binary');
  assert.deepEqual(invocation.args, ['--version']);
  assertRestrictedSpawnOptions(invocation.options, ['ignore', 'pipe', 'pipe']);
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

test('settles executable verification when kill returns false and no event follows', async (t) => {
  const child = childWhoseKillReturnsFalse();
  t.after(setSpawnForTesting((() => child) as typeof spawn));

  const verification = verifyJqExecutable('jq');
  child.stdout.write(Buffer.alloc(1024 * 1024 + 1));

  await assert.rejects(
    withDeadline(verification),
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
