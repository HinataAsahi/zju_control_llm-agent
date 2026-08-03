import { createWriteStream } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import type { PreparedWorkspace } from './workspace.js';

export interface ModelConfiguration {
  model: 'gpt-5.6-luna' | 'gpt-5.6-terra';
  reasoningEffort: 'low' | 'medium';
}

export interface CodexRunRequest {
  codexExecutable: string;
  codexPrefixArgs?: string[];
  workspace: PreparedWorkspace;
  serverEntrypoint: string;
  artifactsDirectory: string;
  model: ModelConfiguration;
  timeoutMs: number;
}

export interface RawCodexRun {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  stdoutPath: string;
  stderrPath: string;
  timedOut: boolean;
}

const supportedModels = new Set<ModelConfiguration['model']>(['gpt-5.6-luna', 'gpt-5.6-terra']);
const supportedReasoningEfforts = new Set<ModelConfiguration['reasoningEffort']>(['low', 'medium']);
const terminationGraceMs = 250;
const versionTimeoutMs = 3_000;
const maximumVersionBytes = 8_192;

export async function runCodex(request: CodexRunRequest): Promise<RawCodexRun> {
  validateRequest(request);
  const workspacePath = resolve(request.workspace.path);
  const schemaPath = resolve(request.workspace.outputSchemaPath);
  const serverEntrypoint = resolve(request.serverEntrypoint);
  const artifactsDirectory = resolve(request.artifactsDirectory);
  await mkdir(artifactsDirectory, { recursive: true, mode: 0o700 });

  const runToken = randomUUID();
  const stdoutPath = `${artifactsDirectory}/codex-${runToken}.stdout`;
  const stderrPath = `${artifactsDirectory}/codex-${runToken}.stderr`;
  const [stdoutHandle, stderrHandle] = await Promise.all([
    open(stdoutPath, 'wx', 0o600),
    open(stderrPath, 'wx', 0o600)
  ]);
  const stdout = createWriteStream('', { fd: stdoutHandle.fd, autoClose: true });
  const stderr = createWriteStream('', { fd: stderrHandle.fd, autoClose: true });

  const args = buildArguments(request, workspacePath, schemaPath, serverEntrypoint);
  const startedAt = Date.now();
  return await new Promise<RawCodexRun>((resolveRun, rejectRun) => {
    let settled = false;
    let timedOut = false;
    let graceTimer: NodeJS.Timeout | undefined;
    let closed: { exitCode: number | null; signal: NodeJS.Signals | null } | undefined;
    let stdoutFinished = false;
    let stderrFinished = false;
    const child = spawn(request.codexExecutable, args, {
      cwd: workspacePath,
      env: codexEnvironment(),
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      if (!child.kill('SIGTERM')) settle(undefined, null, null);
      graceTimer = setTimeout(() => {
        if (!child.kill('SIGKILL')) settle(undefined, null, null);
      }, terminationGraceMs);
    }, request.timeoutMs);
    timeoutTimer.unref();

    const settle = (error?: Error, exitCode: number | null = null, signal: NodeJS.Signals | null = null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (graceTimer) clearTimeout(graceTimer);
      if (error) {
        child.kill('SIGKILL');
        rejectRun(error);
        return;
      }
      resolveRun({
        exitCode,
        signal,
        durationMs: Date.now() - startedAt,
        stdoutPath,
        stderrPath,
        timedOut
      });
    };
    const settleWhenDrained = (): void => {
      if (closed && stdoutFinished && stderrFinished) settle(undefined, closed.exitCode, closed.signal);
    };
    child.stdout.pipe(stdout);
    child.stderr.pipe(stderr);
    child.stdout.once('error', error => settle(new Error(`Codex stdout stream failed: ${error.message}`)));
    child.stderr.once('error', error => settle(new Error(`Codex stderr stream failed: ${error.message}`)));
    stdout.once('error', error => settle(new Error(`Codex stdout artifact failed: ${error.message}`)));
    stderr.once('error', error => settle(new Error(`Codex stderr artifact failed: ${error.message}`)));
    child.once('error', error => settle(new Error(`Unable to launch Codex: ${error.message}`)));
    child.once('close', (exitCode, signal) => {
      closed = { exitCode, signal };
      settleWhenDrained();
    });
    stdout.once('finish', () => { stdoutFinished = true; settleWhenDrained(); });
    stderr.once('finish', () => { stderrFinished = true; settleWhenDrained(); });
    child.stdin.once('error', error => settle(new Error(`Codex stdin failed: ${error.message}`)));
    child.stdin.end(request.workspace.prompt);
  });
}

export async function readCodexVersion(executable = 'codex'): Promise<string> {
  return await new Promise<string>((resolveVersion, rejectVersion) => {
    let settled = false;
    let output = '';
    let stderr = '';
    let outputBytes = 0;
    const child = spawn(executable, ['--version'], { env: codexEnvironment(), shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), terminationGraceMs).unref();
      settle(new Error(`Codex version command timed out after ${versionTimeoutMs}ms`));
    }, versionTimeoutMs);
    timer.unref();
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectVersion(error);
      else resolveVersion(output.trim());
    };
    const append = (chunk: Buffer, target: 'stdout' | 'stderr'): void => {
      outputBytes += chunk.length;
      if (outputBytes > maximumVersionBytes) {
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), terminationGraceMs).unref();
        settle(new Error('Codex version output exceeded 8192 bytes'));
        return;
      }
      if (target === 'stdout') output += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
    };
    child.stdout.on('data', chunk => append(chunk as Buffer, 'stdout'));
    child.stderr.on('data', chunk => append(chunk as Buffer, 'stderr'));
    child.once('error', error => settle(new Error(`Unable to read Codex version: ${error.message}`)));
    child.once('close', code => {
      if (code === 0) settle();
      else settle(new Error(`Codex version command exited with ${code ?? 'no exit code'}: ${stderr.trim()}`));
    });
  });
}

function buildArguments(request: CodexRunRequest, workspacePath: string, schemaPath: string, serverEntrypoint: string): string[] {
  const overrides = [
    `model_reasoning_effort = ${tomlString(request.model.reasoningEffort)}`,
    `mcp_servers.jq_mcp_server.command = ${tomlString('node')}`,
    `mcp_servers.jq_mcp_server.args = [${[serverEntrypoint, '--root', workspacePath].map(tomlString).join(', ')}]`,
    'mcp_servers.jq_mcp_server.required = true'
  ];
  return [
    ...(request.codexPrefixArgs ?? []),
    'exec', '--json', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check',
    '--sandbox', 'read-only', '--model', request.model.model, '--output-schema', schemaPath,
    ...overrides.flatMap(override => ['-c', override]), '-C', workspacePath
  ];
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function validateRequest(request: CodexRunRequest): void {
  if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) throw new Error('timeoutMs must be a positive finite number');
  if (!supportedModels.has(request.model.model)) throw new Error(`Unsupported model: ${request.model.model}`);
  if (!supportedReasoningEfforts.has(request.model.reasoningEffort)) throw new Error(`Unsupported reasoning effort: ${request.model.reasoningEffort}`);
}

function codexEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    'PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
    'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'CODEX_HOME', 'OPENAI_API_KEY', 'HTTPS_PROXY', 'HTTP_PROXY',
    'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'TMPDIR', 'TEMP', 'TMP', 'USER', 'LOGNAME', 'LANG', 'LC_ALL',
    'SYSTEMROOT', 'COMSPEC', 'PATHEXT'
  ];
  return Object.fromEntries(allowed.flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]])) as NodeJS.ProcessEnv;
}
