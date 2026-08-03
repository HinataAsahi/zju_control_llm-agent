import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import test from 'node:test';
import { readCodexVersion, runCodex, type CodexRunRequest } from '../../src/experiment/codex-runner.js';

const fixture = resolve('test/fixtures/fake-codex.mjs');

async function setup(t: test.TestContext): Promise<{ root: string; request: CodexRunRequest; observationPath: string }> {
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
    root,
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

test('launches Codex with fixed arguments, TOML overrides, stdin prompt, and a narrow environment', async t => {
  const { request, observationPath } = await setup(t);
  const previousUnrelated = process.env.UNRELATED_SECRET;
  process.env.UNRELATED_SECRET = 'must-not-be-inherited';
  t.after(() => {
    if (previousUnrelated === undefined) delete process.env.UNRELATED_SECRET;
    else process.env.UNRELATED_SECRET = previousUnrelated;
  });

  const result = await runCodex(request);
  const observed = await readObservation(observationPath);

  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
  assert.equal(result.timedOut, false);
  assert.equal(observed.stdin, request.workspace.prompt);
  assert.equal(observed.argv.includes(request.workspace.prompt), false);
  assert.equal(observed.argv.includes('--search'), false);
  assert.deepEqual(observed.argv.slice(0, 11), [
    'exec', '--json', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check',
    '--sandbox', 'read-only', '--model', 'gpt-5.6-luna', '--output-schema', resolve(request.workspace.outputSchemaPath)
  ]);
  assert.equal(observed.argv.at(-2), '-C');
  assert.equal(observed.argv.at(-1), resolve(request.workspace.path));
  const overrides = observed.argv.filter((value, index) => observed.argv[index - 1] === '-c');
  assert.deepEqual(overrides, [
    'model_reasoning_effort = "medium"',
    `mcp_servers.jq_mcp_server.command = "node"`,
    `mcp_servers.jq_mcp_server.args = [${JSON.stringify(resolve(request.serverEntrypoint))}, "--root", ${JSON.stringify(resolve(request.workspace.path))}]`,
    'mcp_servers.jq_mcp_server.required = true'
  ]);
  assert.equal(isAbsolute(JSON.parse(overrides[2]!.slice(overrides[2]!.indexOf('[')))[0]), true);
  assert.equal(observed.env.UNRELATED_SECRET, undefined);
  assert.ok(observed.env.PATH);
  assert.ok(observed.env.HOME ?? observed.env.USERPROFILE);
  assert.equal(await readFile(result.stdoutPath, 'utf8'), 'fake stdout\n');
  assert.equal(await readFile(result.stderrPath, 'utf8'), 'fake stderr\n');
  assert.equal(result.stdoutPath.startsWith(`${resolve(request.artifactsDirectory)}/`), true);
  assert.equal(result.stderrPath.startsWith(`${resolve(request.artifactsDirectory)}/`), true);
});

test('persists output and reports a nonzero exit without rejecting', async t => {
  const { request } = await setup(t);
  await writeFile(join(request.workspace.path, '.fake-codex-mode'), 'nonzero');
  const result = await runCodex(request);
  assert.equal(result.exitCode, 7);
  assert.equal(result.signal, null);
  assert.equal(result.timedOut, false);
  assert.equal(await readFile(result.stderrPath, 'utf8'), 'fake stderr\n');
});

test('times out, force kills an uncooperative process, and settles with recorded signal', async t => {
  const { request } = await setup(t);
  await writeFile(join(request.workspace.path, '.fake-codex-mode'), 'hang');
  const result = await runCodex({ ...request, timeoutMs: 50 });
  assert.equal(result.exitCode, null);
  assert.equal(result.signal, 'SIGKILL');
  assert.equal(result.timedOut, true);
});

test('refuses an artifact directory collision and rejects invalid runtime options', async t => {
  const { request } = await setup(t);
  await writeFile(request.artifactsDirectory, 'not a directory');
  await assert.rejects(runCodex({ ...request, timeoutMs: 0 }), /timeoutMs/);
  await assert.rejects(runCodex({ ...request, model: { model: 'unsupported' as never, reasoningEffort: 'low' } }), /Unsupported model/);
});

test('reads the executable version with bounded output', async () => {
  assert.equal(await readCodexVersion(process.execPath), process.version);
});
