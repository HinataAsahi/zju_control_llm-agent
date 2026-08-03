import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import type { Writable } from 'node:stream';
import test from 'node:test';
import {
  readCodexVersion,
  runCodex,
  setCodexArtifactTokenForTesting,
  setCodexRunnerSpawnForTesting,
  setCodexRunnerTimingsForTesting,
  setCodexWriteStreamFactoryForTesting,
  type CodexRunRequest
} from '../../src/experiment/codex-runner.js';

const fixture = resolve('test/fixtures/fake-codex.mjs');

type FakeChild = ChildProcess & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
};

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

function useFastTimings(t: test.TestContext): void {
  t.after(setCodexRunnerTimingsForTesting({ terminationGraceMs: 5, forceSettleMs: 10, versionTimeoutMs: 5 }));
}

function installChild(t: test.TestContext, child: FakeChild): Promise<void> {
  let markSpawned!: () => void;
  const spawned = new Promise<void>(resolveSpawned => { markSpawned = resolveSpawned; });
  t.after(setCodexRunnerSpawnForTesting((() => {
    markSpawned();
    return child;
  }) as typeof spawn));
  return spawned;
}

test('integration: passes exact argv and prompt while streaming persistent artifacts', async t => {
  const { request, observationPath } = await setup(t);
  const previousUnrelated = process.env.UNRELATED_SECRET;
  process.env.UNRELATED_SECRET = 'must-not-be-inherited';
  t.after(() => {
    if (previousUnrelated === undefined) delete process.env.UNRELATED_SECRET;
    else process.env.UNRELATED_SECRET = previousUnrelated;
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
  assert.equal(observed.env.UNRELATED_SECRET, undefined);
  assert.ok(observed.env.PATH);
  assert.ok(observed.env.HOME ?? observed.env.USERPROFILE);
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

test('uses shell false, resolved cwd, piped stdio, and a narrow environment', async t => {
  const { request } = await setup(t);
  const child = fakeChild();
  let invocation: { executable: string; args: readonly string[]; options: SpawnOptions } | undefined;
  let markSpawned!: () => void;
  const spawned = new Promise<void>(resolveSpawned => { markSpawned = resolveSpawned; });
  t.after(setCodexRunnerSpawnForTesting((executable: string, args: readonly string[], options: SpawnOptions) => {
    invocation = { executable, args, options };
    markSpawned();
    return child;
  }));

  const running = runCodex(request);
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

test('does not resolve until the child is terminal and both artifact streams close', async t => {
  const { request } = await setup(t);
  const child = fakeChild();
  const stdoutDestination = new PassThrough({ autoDestroy: false });
  const stderrDestination = new PassThrough({ autoDestroy: false });
  const destinations = [stdoutDestination, stderrDestination];
  const spawned = installChild(t, child);
  t.after(setCodexWriteStreamFactoryForTesting((() => destinations.shift()!) as (path: string) => Writable));

  let resolved = false;
  const running = runCodex(request).then(result => { resolved = true; return result; });
  await spawned;
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
  t.after(setCodexRunnerSpawnForTesting((() => child) as typeof spawn));
  useFastTimings(t);

  const result = await withDeadline(runCodex({ ...request, timeoutMs: 5 }));

  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, null);
  assert.equal(result.signal, null);
  assert.equal(child.stdin.destroyed, true);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
  assert.doesNotThrow(() => child.emit('error', new Error('late child error')));
  assert.doesNotThrow(() => child.stdout.emit('error', new Error('late stream error')));
});

test('rejects and removes artifacts when kill throws during timeout termination', async t => {
  const { request } = await setup(t);
  const child = fakeChild(() => { throw new Error('kill failed'); });
  t.after(setCodexRunnerSpawnForTesting((() => child) as typeof spawn));
  useFastTimings(t);

  await assert.rejects(withDeadline(runCodex({ ...request, timeoutMs: 5 })), /kill failed/);
  assert.deepEqual(await readdir(request.artifactsDirectory), []);
});

test('rejects synchronous spawn failures and removes both reserved artifacts', async t => {
  const { request } = await setup(t);
  t.after(setCodexRunnerSpawnForTesting((() => { throw new Error('sync spawn failure'); }) as typeof spawn));

  await assert.rejects(runCodex(request), /sync spawn failure/);
  assert.deepEqual(await readdir(request.artifactsDirectory), []);
});

test('rejects asynchronous spawn failures without waiting for close and guards late events', async t => {
  const { request } = await setup(t);
  const child = fakeChild(() => false);
  const spawned = installChild(t, child);
  useFastTimings(t);

  const running = runCodex(request);
  await spawned;
  child.emit('error', new Error('async spawn failure'));
  await assert.rejects(withDeadline(running), /async spawn failure/);
  assert.deepEqual(await readdir(request.artifactsDirectory), []);
  assert.doesNotThrow(() => child.emit('error', new Error('late child error')));
});

test('rejects source stream errors, destroys all resources, and removes artifacts', async t => {
  const { request } = await setup(t);
  const child = fakeChild(() => false);
  const spawned = installChild(t, child);
  useFastTimings(t);

  const running = runCodex(request);
  await spawned;
  child.stdout.emit('error', new Error('stdout failed'));
  await assert.rejects(withDeadline(running), /stdout failed/);

  assert.equal(child.stdin.destroyed, true);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
  assert.deepEqual(await readdir(request.artifactsDirectory), []);
});

test('handles asynchronous stdin, stdout, and stderr failures through the same bounded cleanup path', async t => {
  for (const streamName of ['stdin', 'stdout', 'stderr'] as const) {
    await t.test(streamName, async t => {
      const { request } = await setup(t);
      const child = fakeChild(() => false);
      const spawned = installChild(t, child);
      useFastTimings(t);

      const running = runCodex(request);
      await spawned;
      child[streamName].emit('error', new Error(`${streamName} broke`));
      await assert.rejects(withDeadline(running), new RegExp(`${streamName} broke`));
      assert.deepEqual(await readdir(request.artifactsDirectory), []);
    });
  }
});

test('rejects synchronous stdin failures and removes artifacts', async t => {
  const { request } = await setup(t);
  const child = fakeChild(() => false);
  child.stdin.end = (() => { throw new Error('stdin failed'); }) as typeof child.stdin.end;
  t.after(setCodexRunnerSpawnForTesting((() => child) as typeof spawn));
  useFastTimings(t);

  await assert.rejects(withDeadline(runCodex(request)), /stdin failed/);
  assert.deepEqual(await readdir(request.artifactsDirectory), []);
});

test('rejects synchronous pipe failures and removes artifacts', async t => {
  const { request } = await setup(t);
  const child = fakeChild(() => false);
  child.stderr.pipe = (() => { throw new Error('pipe setup failed'); }) as typeof child.stderr.pipe;
  const spawned = installChild(t, child);
  useFastTimings(t);

  const running = runCodex(request);
  await spawned;
  await assert.rejects(withDeadline(running), /pipe setup failed/);
  assert.deepEqual(await readdir(request.artifactsDirectory), []);
});

test('rejects destination stream setup failures and removes reserved artifacts', async t => {
  const { request } = await setup(t);
  t.after(setCodexWriteStreamFactoryForTesting((() => { throw new Error('stream setup failed'); }) as (path: string) => Writable));

  await assert.rejects(runCodex(request), /stream setup failed/);
  assert.deepEqual(await readdir(request.artifactsDirectory), []);
});

test('closes the first destination when setup of the second destination fails', async t => {
  const { request } = await setup(t);
  const firstDestination = new PassThrough();
  let callCount = 0;
  t.after(setCodexWriteStreamFactoryForTesting((() => {
    callCount += 1;
    if (callCount === 1) return firstDestination;
    throw new Error('second stream setup failed');
  }) as (path: string) => Writable));

  await assert.rejects(runCodex(request), /second stream setup failed/);
  assert.equal(firstDestination.destroyed, true);
  assert.deepEqual(await readdir(request.artifactsDirectory), []);
});

test('rejects destination stream errors and deterministically destroys the child', async t => {
  const { request } = await setup(t);
  const child = fakeChild(() => false);
  const stdoutDestination = new PassThrough();
  const stderrDestination = new PassThrough();
  const destinations = [stdoutDestination, stderrDestination];
  const spawned = installChild(t, child);
  t.after(setCodexWriteStreamFactoryForTesting((() => destinations.shift()!) as (path: string) => Writable));
  useFastTimings(t);

  const running = runCodex(request);
  await spawned;
  stdoutDestination.emit('error', new Error('artifact stream failed'));
  await assert.rejects(withDeadline(running), /artifact stream failed/);
  assert.deepEqual(await readdir(request.artifactsDirectory), []);
});

test('refuses a genuine second-artifact collision and removes the partial first artifact', async t => {
  const { request } = await setup(t);
  t.after(setCodexArtifactTokenForTesting(() => 'collision'));
  await mkdir(request.artifactsDirectory);
  const stderrPath = join(request.artifactsDirectory, 'codex-collision.stderr');
  await writeFile(stderrPath, 'existing');

  await assert.rejects(runCodex(request), { code: 'EEXIST' });

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

test('version lookup uses shell false, ignored stdin, piped output, and the narrow environment', async t => {
  const child = fakeChild();
  let invocation: { executable: string; args: readonly string[]; options: SpawnOptions } | undefined;
  t.after(setCodexRunnerSpawnForTesting((executable: string, args: readonly string[], options: SpawnOptions) => {
    invocation = { executable, args, options };
    return child;
  }));
  const version = readCodexVersion('codex-test');
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

test('version lookup requires nonempty output identifying Codex', async t => {
  for (const output of ['', 'node v24.0.0']) {
    await t.test(JSON.stringify(output), async t => {
      const child = fakeChild();
      t.after(setCodexRunnerSpawnForTesting((() => child) as typeof spawn));
      const version = readCodexVersion('codex');
      child.stdout.end(output);
      child.stderr.end();
      child.emit('close', 0, null);
      await assert.rejects(version, /valid Codex version/);
    });
  }
});

test('version lookup rejects nonzero exits with bounded stderr context', async t => {
  const child = fakeChild();
  t.after(setCodexRunnerSpawnForTesting((() => child) as typeof spawn));
  const version = readCodexVersion('codex');
  child.stderr.end('bad version');
  child.stdout.end();
  child.emit('close', 9, null);
  await assert.rejects(version, /exited with 9: bad version/);
});

test('version lookup bounds combined stdout and stderr and force settles', async t => {
  const child = fakeChild(() => false);
  t.after(setCodexRunnerSpawnForTesting((() => child) as typeof spawn));
  useFastTimings(t);
  const version = readCodexVersion('codex');
  child.stdout.write(Buffer.alloc(4_097));
  child.stderr.write(Buffer.alloc(4_096));
  await assert.rejects(withDeadline(version), /exceeded 8192 bytes/);
});

test('version lookup times out through bounded graceful and forced termination', async t => {
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const child = fakeChild(signal => { signals.push(signal); return false; });
  t.after(setCodexRunnerSpawnForTesting((() => child) as typeof spawn));
  useFastTimings(t);

  await assert.rejects(withDeadline(readCodexVersion('codex')), /timed out/);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.doesNotThrow(() => child.emit('error', new Error('late version error')));
});

test('version lookup catches signal-delivery exceptions and still force settles', async t => {
  const child = fakeChild(() => { throw new Error('version kill failed'); });
  t.after(setCodexRunnerSpawnForTesting((() => child) as typeof spawn));
  useFastTimings(t);

  await assert.rejects(withDeadline(readCodexVersion('codex')), /timed out/);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
});
