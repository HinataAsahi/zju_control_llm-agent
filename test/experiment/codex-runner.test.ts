import assert from 'node:assert/strict';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import {
  createCodexRunnerForTesting,
  readCodexVersion,
  runCodex,
  type CodexRunRequest,
  type RawCodexRun
} from '../../src/experiment/codex-runner.js';

const fixture = resolve('test/fixtures/fake-codex.mjs');
const fastTimings = { terminationGraceMs: 5, forceSettleMs: 10, versionTimeoutMs: 5 };

type ProcessSpawner = (executable: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
interface TestRunner {
  runCodex(request: CodexRunRequest): Promise<RawCodexRun>;
  readCodexVersion(executable?: string): Promise<string>;
}
interface TestRunnerOverrides {
  spawnProcess?: ProcessSpawner;
  createArtifactToken?: () => string;
  createArtifactStream?: (path: string) => Writable;
  timings?: typeof fastTimings;
}
type FakeChild = ChildProcess & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough };

function fakeChild(kill: (signal?: NodeJS.Signals | number) => boolean = () => true): FakeChild {
  const child = new EventEmitter();
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    kill
  });
  return child as FakeChild;
}

function testRunner(overrides: TestRunnerOverrides = {}): TestRunner {
  return createCodexRunnerForTesting(overrides);
}

function runnerWithChild(
  child: FakeChild,
  overrides: Omit<TestRunnerOverrides, 'spawnProcess'> = {}
): { runner: TestRunner; spawned: Promise<void> } {
  let markSpawned!: () => void;
  const spawned = new Promise<void>(resolveSpawned => { markSpawned = resolveSpawned; });
  const runner = testRunner({
    ...overrides,
    spawnProcess: () => {
      markSpawned();
      return child;
    }
  });
  return { runner, spawned };
}

class DelayedCloseWritable extends Writable {
  private releaseDestroy: (() => void) | undefined;

  override _write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    callback();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.releaseDestroy = () => callback(error);
  }

  releaseClose(): void {
    assert.ok(this.releaseDestroy, 'stream must be destroyed before close is released');
    this.releaseDestroy();
    this.releaseDestroy = undefined;
  }
}

async function setup(t: test.TestContext): Promise<{ request: CodexRunRequest; observationPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'codex-runner-'));
  const workspacePath = join(root, 'workspace');
  const artifactsDirectory = join(root, 'artifacts');
  const schemaPath = join(workspacePath, 'schema.json');
  const serverEntrypoint = join(root, 'server "quoted"\\entrypoint.mjs');
  const observationPath = join(workspacePath, '.fake-codex-observation.json');
  await mkdir(workspacePath);
  await writeFile(schemaPath, '{}');
  await writeFile(serverEntrypoint, '');
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    observationPath,
    request: {
      codexExecutable: process.execPath,
      codexPrefixArgs: [fixture],
      workspace: { path: workspacePath, prompt: 'secret prompt\nwith details', outputSchemaPath: schemaPath },
      serverEntrypoint,
      artifactsDirectory,
      model: { model: 'gpt-5.6-luna', reasoningEffort: 'medium' },
      timeoutMs: 1_000
    }
  };
}

async function readObservation(path: string): Promise<{ argv: string[]; stdin: string; env: NodeJS.ProcessEnv }> {
  return JSON.parse(await readFile(path, 'utf8')) as { argv: string[]; stdin: string; env: NodeJS.ProcessEnv };
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs = 500): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Test deadline exceeded')), timeoutMs);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error('Condition deadline exceeded');
    await new Promise(resolveWait => setTimeout(resolveWait, 5));
  }
}

function setTemporaryEnvironment(t: test.TestContext, values: Record<string, string>): void {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test('integration: passes exact argv, supported auth environment, and prompt while persisting artifacts', async t => {
  const { request, observationPath } = await setup(t);
  setTemporaryEnvironment(t, {
    CODEX_API_KEY: 'temporary-api-key',
    CODEX_ACCESS_TOKEN: 'temporary-access-token',
    CODEX_CA_CERTIFICATE: 'temporary-ca-path',
    UNRELATED_SECRET: 'must-not-be-inherited'
  });

  const result = await runCodex(request);
  const observed = await readObservation(observationPath);

  assert.deepEqual({ exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut }, {
    exitCode: 0, signal: null, timedOut: false
  });
  assert.equal(observed.stdin, request.workspace.prompt);
  assert.equal(observed.argv.includes(request.workspace.prompt), false);
  assert.equal(observed.argv.includes('--search'), false);
  assert.deepEqual(observed.argv.slice(0, 11), [
    'exec', '--json', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check',
    '--sandbox', 'read-only', '--model', 'gpt-5.6-luna', '--output-schema', resolve(request.workspace.outputSchemaPath)
  ]);
  assert.equal(observed.argv.at(-2), '-C');
  assert.equal(observed.argv.at(-1), resolve(request.workspace.path));
  const overrides = observed.argv.filter((_value, index) => observed.argv[index - 1] === '-c');
  assert.deepEqual(overrides, [
    'model_reasoning_effort = "medium"',
    'mcp_servers.jq_mcp_server.command = "node"',
    `mcp_servers.jq_mcp_server.args = [${JSON.stringify(resolve(request.serverEntrypoint))}, "--root", ${JSON.stringify(resolve(request.workspace.path))}]`,
    'mcp_servers.jq_mcp_server.required = true'
  ]);
  assert.equal(isAbsolute(JSON.parse(overrides[2]!.slice(overrides[2]!.indexOf('[')))[0]), true);
  assert.equal(observed.env.CODEX_API_KEY, 'temporary-api-key');
  assert.equal(observed.env.CODEX_ACCESS_TOKEN, 'temporary-access-token');
  assert.equal(observed.env.CODEX_CA_CERTIFICATE, 'temporary-ca-path');
  assert.equal(observed.env.UNRELATED_SECRET, undefined);
  assert.equal(await readFile(result.stdoutPath, 'utf8'), 'fake stdout\n');
  assert.equal(await readFile(result.stderrPath, 'utf8'), 'fake stderr\n');
});

test('integration: preserves artifacts and reports a nonzero Codex exit', async t => {
  const { request } = await setup(t);
  await writeFile(join(request.workspace.path, '.fake-codex-mode'), 'nonzero');
  const result = await runCodex(request);
  assert.deepEqual({ exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut }, {
    exitCode: 7, signal: null, timedOut: false
  });
  assert.equal(await readFile(result.stderrPath, 'utf8'), 'fake stderr\n');
});

test('integration: kills a ready process that ignores SIGTERM and settles without a shell timeout', async t => {
  const { request } = await setup(t);
  await writeFile(join(request.workspace.path, '.fake-codex-mode'), 'hang');

  const result = await withDeadline(runCodex({ ...request, timeoutMs: 400 }), 2_000);

  assert.equal(await readFile(join(request.workspace.path, '.fake-codex-ready'), 'utf8'), 'ready\n');
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, null);
  assert.equal(result.signal, 'SIGKILL');
});

test('uses shell false, resolved cwd, piped stdio, and a narrow environment', async t => {
  const { request } = await setup(t);
  const child = fakeChild();
  let invocation: { executable: string; args: readonly string[]; options: SpawnOptions } | undefined;
  let markSpawned!: () => void;
  const spawned = new Promise<void>(resolveSpawned => { markSpawned = resolveSpawned; });
  const runner = testRunner({
    spawnProcess: (executable, args, options) => {
      invocation = { executable, args, options };
      markSpawned();
      return child;
    }
  });

  const running = runner.runCodex(request);
  await spawned;
  child.stdout.end('out');
  child.stderr.end('err');
  child.emit('close', 0, null);
  await running;

  assert.ok(invocation);
  assert.equal(invocation.executable, process.execPath);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.cwd, resolve(request.workspace.path));
  assert.deepEqual(invocation.options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(invocation.options.env?.UNRELATED_SECRET, undefined);
});

test('dependency-bound runners can overlap without replacing each other', async t => {
  const firstSetup = await setup(t);
  const secondSetup = await setup(t);
  const firstChild = fakeChild();
  const secondChild = fakeChild();
  const first = runnerWithChild(firstChild);
  const second = runnerWithChild(secondChild);

  const firstRun = first.runner.runCodex(firstSetup.request);
  const secondRun = second.runner.runCodex(secondSetup.request);
  await Promise.all([first.spawned, second.spawned]);
  firstChild.stdout.end('first');
  firstChild.stderr.end();
  firstChild.emit('close', 0, null);
  secondChild.stdout.end('second');
  secondChild.stderr.end();
  secondChild.emit('close', 0, null);

  const [firstResult, secondResult] = await Promise.all([firstRun, secondRun]);
  assert.equal(await readFile(firstResult.stdoutPath, 'utf8'), 'first');
  assert.equal(await readFile(secondResult.stdoutPath, 'utf8'), 'second');
});

test('does not resolve until the child is terminal and both artifact streams close', async t => {
  const { request } = await setup(t);
  const child = fakeChild();
  const stdoutDestination = new PassThrough({ autoDestroy: false });
  const stderrDestination = new PassThrough({ autoDestroy: false });
  const destinations = [stdoutDestination, stderrDestination];
  const bound = runnerWithChild(child, { createArtifactStream: () => destinations.shift()! });

  let resolved = false;
  const running = bound.runner.runCodex(request).then(result => { resolved = true; return result; });
  await bound.spawned;
  child.stdout.end('out');
  child.stderr.end('err');
  child.emit('close', 0, null);
  await new Promise(resolveTick => setImmediate(resolveTick));
  assert.equal(resolved, false);

  stdoutDestination.destroy();
  stderrDestination.destroy();
  assert.equal((await withDeadline(running)).exitCode, 0);
});

test('times out through SIGTERM, SIGKILL, and a force-settle watchdog when no close arrives', async t => {
  const { request } = await setup(t);
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const child = fakeChild(signal => { signals.push(signal); return false; });
  const runner = testRunner({ spawnProcess: () => child, timings: fastTimings });

  const result = await withDeadline(runner.runCodex({ ...request, timeoutMs: 5 }));

  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, null);
  assert.equal(result.signal, null);
  assert.equal(child.stdin.destroyed, true);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
  assert.doesNotThrow(() => child.emit('error', new Error('late child error')));
});

test('rejects within the bound but defers artifact cleanup until delayed streams really close', async t => {
  const { request } = await setup(t);
  const child = fakeChild(() => false);
  const stdoutDestination = new DelayedCloseWritable();
  const stderrDestination = new DelayedCloseWritable();
  const destinations = [stdoutDestination, stderrDestination];
  const bound = runnerWithChild(child, {
    createArtifactToken: () => 'delayed-close',
    createArtifactStream: () => destinations.shift()!,
    timings: fastTimings
  });

  const running = bound.runner.runCodex(request);
  await bound.spawned;
  stdoutDestination.emit('error', new Error('artifact stream failed'));
  await assert.rejects(withDeadline(running), /artifact stream failed/);

  assert.deepEqual((await readdir(request.artifactsDirectory)).sort(), [
    'codex-delayed-close.stderr', 'codex-delayed-close.stdout'
  ]);
  stdoutDestination.releaseClose();
  stderrDestination.releaseClose();
  await waitFor(async () => (await readdir(request.artifactsDirectory)).length === 0);
});

test('rejects and removes artifacts when kill throws during timeout termination', async t => {
  const { request } = await setup(t);
  const child = fakeChild(() => { throw new Error('kill failed'); });
  const runner = testRunner({ spawnProcess: () => child, timings: fastTimings });

  await assert.rejects(withDeadline(runner.runCodex({ ...request, timeoutMs: 5 })), /kill failed/);
  assert.deepEqual(await readdir(request.artifactsDirectory), []);
});

test('rejects synchronous and asynchronous spawn failures with bounded cleanup', async t => {
  await t.test('synchronous', async t => {
    const { request } = await setup(t);
    const runner = testRunner({ spawnProcess: () => { throw new Error('sync spawn failure'); } });
    await assert.rejects(runner.runCodex(request), /sync spawn failure/);
    assert.deepEqual(await readdir(request.artifactsDirectory), []);
  });
  await t.test('asynchronous', async t => {
    const { request } = await setup(t);
    const child = fakeChild(() => false);
    const bound = runnerWithChild(child, { timings: fastTimings });
    const running = bound.runner.runCodex(request);
    await bound.spawned;
    child.emit('error', new Error('async spawn failure'));
    await assert.rejects(withDeadline(running), /async spawn failure/);
    assert.deepEqual(await readdir(request.artifactsDirectory), []);
    assert.doesNotThrow(() => child.emit('error', new Error('late child error')));
  });
});

test('handles asynchronous stdin, stdout, and stderr failures through bounded cleanup', async t => {
  for (const streamName of ['stdin', 'stdout', 'stderr'] as const) {
    await t.test(streamName, async t => {
      const { request } = await setup(t);
      const child = fakeChild(() => false);
      const bound = runnerWithChild(child, { timings: fastTimings });
      const running = bound.runner.runCodex(request);
      await bound.spawned;
      child[streamName].emit('error', new Error(`${streamName} broke`));
      await assert.rejects(withDeadline(running), new RegExp(`${streamName} broke`));
      assert.deepEqual(await readdir(request.artifactsDirectory), []);
    });
  }
});

test('rejects synchronous stdin and pipe failures with bounded cleanup', async t => {
  await t.test('stdin', async t => {
    const { request } = await setup(t);
    const child = fakeChild(() => false);
    child.stdin.end = (() => { throw new Error('stdin failed'); }) as typeof child.stdin.end;
    const runner = testRunner({ spawnProcess: () => child, timings: fastTimings });
    await assert.rejects(withDeadline(runner.runCodex(request)), /stdin failed/);
    assert.deepEqual(await readdir(request.artifactsDirectory), []);
  });
  await t.test('pipe', async t => {
    const { request } = await setup(t);
    const child = fakeChild(() => false);
    child.stderr.pipe = (() => { throw new Error('pipe setup failed'); }) as typeof child.stderr.pipe;
    const bound = runnerWithChild(child, { timings: fastTimings });
    const running = bound.runner.runCodex(request);
    await bound.spawned;
    await assert.rejects(withDeadline(running), /pipe setup failed/);
    assert.deepEqual(await readdir(request.artifactsDirectory), []);
  });
});

test('rejects destination stream setup failures and closes a partially created stream', async t => {
  const { request } = await setup(t);
  const firstDestination = new PassThrough();
  let callCount = 0;
  const runner = testRunner({
    createArtifactStream: () => {
      callCount += 1;
      if (callCount === 1) return firstDestination;
      throw new Error('second stream setup failed');
    },
    timings: fastTimings
  });

  await assert.rejects(runner.runCodex(request), /second stream setup failed/);
  assert.equal(firstDestination.destroyed, true);
  assert.deepEqual(await readdir(request.artifactsDirectory), []);
});

test('defers pre-launch artifact cleanup when a partially created stream closes late', async t => {
  const { request } = await setup(t);
  const firstDestination = new DelayedCloseWritable();
  let callCount = 0;
  const runner = testRunner({
    createArtifactToken: () => 'delayed-setup',
    createArtifactStream: () => {
      callCount += 1;
      if (callCount === 1) return firstDestination;
      throw new Error('second stream setup failed');
    },
    timings: fastTimings
  });

  await assert.rejects(withDeadline(runner.runCodex(request)), /second stream setup failed/);
  assert.deepEqual((await readdir(request.artifactsDirectory)).sort(), [
    'codex-delayed-setup.stderr', 'codex-delayed-setup.stdout'
  ]);

  firstDestination.releaseClose();
  await waitFor(async () => (await readdir(request.artifactsDirectory)).length === 0);
});

test('rejects ordinary destination stream errors after streams close and removes artifacts', async t => {
  const { request } = await setup(t);
  const child = fakeChild(() => false);
  const stdoutDestination = new PassThrough();
  const stderrDestination = new PassThrough();
  const destinations = [stdoutDestination, stderrDestination];
  const bound = runnerWithChild(child, {
    createArtifactStream: () => destinations.shift()!,
    timings: fastTimings
  });

  const running = bound.runner.runCodex(request);
  await bound.spawned;
  stdoutDestination.emit('error', new Error('artifact stream failed'));
  await assert.rejects(withDeadline(running), /artifact stream failed/);
  assert.deepEqual(await readdir(request.artifactsDirectory), []);
});

test('refuses a genuine second-artifact collision and removes the partial first artifact', async t => {
  const { request } = await setup(t);
  const runner = testRunner({ createArtifactToken: () => 'collision' });
  await mkdir(request.artifactsDirectory);
  const stderrPath = join(request.artifactsDirectory, 'codex-collision.stderr');
  await writeFile(stderrPath, 'existing');

  await assert.rejects(runner.runCodex(request), { code: 'EEXIST' });
  assert.deepEqual(await readdir(request.artifactsDirectory), ['codex-collision.stderr']);
  assert.equal(await readFile(stderrPath, 'utf8'), 'existing');
});

test('rejects invalid runtime options before creating artifacts', async t => {
  const { request } = await setup(t);
  await assert.rejects(runCodex({ ...request, timeoutMs: 0 }), /timeoutMs/);
  await assert.rejects(runCodex({ ...request, model: { model: 'unsupported' as never, reasoningEffort: 'low' } }), /Unsupported model/);
});

test('reads a plausible Codex version from the executable fixture', async () => {
  assert.equal(await readCodexVersion(fixture), 'codex-cli 1.2.3');
});

test('accepts only installed Codex CLI version forms', async t => {
  for (const output of ['codex-cli 0.146.0', 'codex 0.146.0']) {
    await t.test(output, async () => {
      const child = fakeChild();
      const runner = testRunner({ spawnProcess: () => child });
      const version = runner.readCodexVersion('codex');
      child.stdout.end(output);
      child.stderr.end();
      child.emit('close', 0, null);
      assert.equal(await version, output);
    });
  }
});

test('rejects empty, unrelated, and prose-like version output containing Codex', async t => {
  for (const output of ['', 'node v24.0.0', 'Codex is installed', 'found codex-cli 0.146.0 on PATH', 'codex latest']) {
    await t.test(JSON.stringify(output), async () => {
      const child = fakeChild();
      const runner = testRunner({ spawnProcess: () => child });
      const version = runner.readCodexVersion('codex');
      child.stdout.end(output);
      child.stderr.end();
      child.emit('close', 0, null);
      await assert.rejects(version, /valid Codex version/);
    });
  }
});

test('version lookup uses shell false, ignored stdin, piped output, and the narrow environment', async () => {
  const child = fakeChild();
  let invocation: { executable: string; args: readonly string[]; options: SpawnOptions } | undefined;
  const runner = testRunner({
    spawnProcess: (executable, args, options) => {
      invocation = { executable, args, options };
      return child;
    }
  });
  const version = runner.readCodexVersion('codex-test');
  child.stdout.end('codex-cli 9.8.7');
  child.stderr.end();
  child.emit('close', 0, null);
  await version;

  assert.ok(invocation);
  assert.equal(invocation.executable, 'codex-test');
  assert.deepEqual(invocation.args, ['--version']);
  assert.equal(invocation.options.shell, false);
  assert.deepEqual(invocation.options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(invocation.options.env?.UNRELATED_SECRET, undefined);
});

test('version lookup rejects nonzero exits with bounded stderr context', async () => {
  const child = fakeChild();
  const runner = testRunner({ spawnProcess: () => child });
  const version = runner.readCodexVersion('codex');
  child.stderr.end('bad version');
  child.stdout.end();
  child.emit('close', 9, null);
  await assert.rejects(version, /exited with 9: bad version/);
});

test('version lookup bounds combined stdout and stderr and force settles', async () => {
  const child = fakeChild(() => false);
  const runner = testRunner({ spawnProcess: () => child, timings: fastTimings });
  const version = runner.readCodexVersion('codex');
  child.stdout.write(Buffer.alloc(4_097));
  child.stderr.write(Buffer.alloc(4_096));
  await assert.rejects(withDeadline(version), /exceeded 8192 bytes/);
});

test('version lookup times out through bounded graceful and forced termination', async () => {
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const child = fakeChild(signal => { signals.push(signal); return false; });
  const runner = testRunner({ spawnProcess: () => child, timings: fastTimings });

  await assert.rejects(withDeadline(runner.readCodexVersion('codex')), /timed out/);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.doesNotThrow(() => child.emit('error', new Error('late version error')));
});

test('version lookup catches signal-delivery exceptions and still force settles', async () => {
  const child = fakeChild(() => { throw new Error('version kill failed'); });
  const runner = testRunner({ spawnProcess: () => child, timings: fastTimings });

  await assert.rejects(withDeadline(runner.readCodexVersion('codex')), /timed out/);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
});
