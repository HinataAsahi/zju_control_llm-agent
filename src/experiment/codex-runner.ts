import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { join, resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';
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

type ProcessSpawner = (executable: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
type WriteStreamFactory = (path: string) => Writable;
interface RunnerTimings {
  terminationGraceMs: number;
  forceSettleMs: number;
  versionTimeoutMs: number;
}
interface CodexRunnerDependencies {
  spawnProcess: ProcessSpawner;
  createArtifactToken: () => string;
  createArtifactStream: WriteStreamFactory;
  timings: RunnerTimings;
}
interface CodexRunner {
  runCodex(request: CodexRunRequest): Promise<RawCodexRun>;
  readCodexVersion(executable?: string): Promise<string>;
}

const supportedModels = new Set<ModelConfiguration['model']>(['gpt-5.6-luna', 'gpt-5.6-terra']);
const supportedReasoningEfforts = new Set<ModelConfiguration['reasoningEffort']>(['low', 'medium']);
const maximumVersionBytes = 8_192;
const defaultTimings: RunnerTimings = {
  terminationGraceMs: 250,
  forceSettleMs: 250,
  versionTimeoutMs: 3_000
};
const defaultDependencies: CodexRunnerDependencies = {
  spawnProcess: spawn,
  createArtifactToken: randomUUID,
  createArtifactStream: path => createWriteStream(path, { flags: 'r+', mode: 0o600 }),
  timings: defaultTimings
};

function createCodexRunner(dependencies: CodexRunnerDependencies): CodexRunner {
  return {
    runCodex: request => runCodexWithDependencies(request, dependencies),
    readCodexVersion: executable => readCodexVersionWithDependencies(executable ?? 'codex', dependencies)
  };
}

export function createCodexRunnerForTesting(overrides: Partial<CodexRunnerDependencies> = {}): CodexRunner {
  return createCodexRunner({
    ...defaultDependencies,
    ...overrides,
    timings: { ...defaultTimings, ...overrides.timings }
  });
}

const defaultRunner = createCodexRunner(defaultDependencies);

export async function runCodex(request: CodexRunRequest): Promise<RawCodexRun> {
  return await defaultRunner.runCodex(request);
}

async function runCodexWithDependencies(
  request: CodexRunRequest,
  dependencies: CodexRunnerDependencies
): Promise<RawCodexRun> {
  validateRequest(request);
  const workspacePath = resolve(request.workspace.path);
  const schemaPath = resolve(request.workspace.outputSchemaPath);
  const serverEntrypoint = resolve(request.serverEntrypoint);
  const artifactsDirectory = resolve(request.artifactsDirectory);
  const paths = await reserveArtifacts(artifactsDirectory, dependencies.createArtifactToken());

  let stdoutArtifact: Writable | undefined;
  let stderrArtifact: Writable | undefined;
  try {
    stdoutArtifact = dependencies.createArtifactStream(paths.stdoutPath);
    stderrArtifact = dependencies.createArtifactStream(paths.stderrPath);
  } catch (error) {
    const streams = [stdoutArtifact, stderrArtifact].filter((stream): stream is Writable => stream !== undefined);
    const streamsClosed = await closeWritableStreams(streams, dependencies.timings.forceSettleMs);
    if (streamsClosed) await removeArtifacts(paths);
    else deferArtifactCleanup(paths, streams);
    throw contextualError('Unable to create Codex artifact streams', error);
  }

  return await executeCodex(
    request,
    buildArguments(request, workspacePath, schemaPath, serverEntrypoint),
    workspacePath,
    paths,
    stdoutArtifact,
    stderrArtifact,
    dependencies
  );
}

async function executeCodex(
  request: CodexRunRequest,
  args: string[],
  workspacePath: string,
  paths: ArtifactPaths,
  stdoutArtifact: Writable,
  stderrArtifact: Writable,
  dependencies: CodexRunnerDependencies
): Promise<RawCodexRun> {
  const startedAt = Date.now();
  return await new Promise<RawCodexRun>((resolveRun, rejectRun) => {
    let child: ChildProcess | undefined;
    let settled = false;
    let finalizing = false;
    let timedOut = false;
    let terminalError: Error | undefined;
    let childTerminal = false;
    let closeObserved = false;
    let forcedTerminal = false;
    let exitCode: number | null = null;
    let signal: NodeJS.Signals | null = null;
    let stdoutClosed = false;
    let stderrClosed = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;
    let forceTimer: NodeJS.Timeout | undefined;
    let closeTimer: NodeJS.Timeout | undefined;

    const clearTimers = (): void => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (graceTimer) clearTimeout(graceTimer);
      if (forceTimer) clearTimeout(forceTimer);
      if (closeTimer) clearTimeout(closeTimer);
      timeoutTimer = graceTimer = forceTimer = closeTimer = undefined;
    };

    const destroyOwnedResources = (): void => {
      if (child) {
        destroyStream(child.stdin);
        destroyStream(child.stdout);
        destroyStream(child.stderr);
      }
      destroyStream(stdoutArtifact);
      destroyStream(stderrArtifact);
    };

    const finish = async (): Promise<void> => {
      if (finalizing || settled || !childTerminal || !stdoutClosed || !stderrClosed) return;
      finalizing = true;
      clearTimers();
      cleanupListeners();
      if (child && forcedTerminal && !closeObserved) guardLateErrors(child, [stdoutArtifact, stderrArtifact]);
      try {
        if (terminalError) {
          await removeArtifacts(paths);
          settled = true;
          rejectRun(terminalError);
          return;
        }
        settled = true;
        resolveRun({
          exitCode,
          signal,
          durationMs: Date.now() - startedAt,
          stdoutPath: paths.stdoutPath,
          stderrPath: paths.stderrPath,
          timedOut
        });
      } catch (error) {
        settled = true;
        rejectRun(contextualError('Unable to clean failed Codex artifacts', error));
      }
    };

    const rejectBeforeArtifactClose = (): void => {
      if (finalizing || settled) return;
      finalizing = true;
      clearTimers();
      cleanupListeners();
      deferArtifactCleanup(paths, [stdoutArtifact, stderrArtifact]);
      if (child && forcedTerminal && !closeObserved) guardLateErrors(child, [stdoutArtifact, stderrArtifact]);
      settled = true;
      rejectRun(terminalError ?? new Error('Codex artifact streams did not close'));
    };

    const scheduleCloseWatchdog = (): void => {
      if (settled || finalizing || closeTimer) return;
      closeTimer = setTimeout(() => {
        closeTimer = undefined;
        if (!stdoutClosed || !stderrClosed) {
          terminalError ??= new Error('Codex artifact streams did not close');
          destroyOwnedResources();
          stdoutClosed ||= streamIsClosed(stdoutArtifact);
          stderrClosed ||= streamIsClosed(stderrArtifact);
          if (!stdoutClosed || !stderrClosed) {
            rejectBeforeArtifactClose();
            return;
          }
        }
        void finish();
      }, dependencies.timings.forceSettleMs);
    };

    const forceTerminalState = (): void => {
      if (settled || finalizing) return;
      forceTimer = undefined;
      forcedTerminal = true;
      childTerminal = true;
      exitCode = child?.exitCode ?? null;
      signal = child?.signalCode ?? null;
      destroyOwnedResources();
      stdoutClosed ||= streamIsClosed(stdoutArtifact);
      stderrClosed ||= streamIsClosed(stderrArtifact);
      scheduleCloseWatchdog();
      void finish();
    };

    const scheduleForceSettlement = (): void => {
      if (settled || finalizing || forceTimer) return;
      forceTimer = setTimeout(forceTerminalState, dependencies.timings.forceSettleMs);
    };

    const killChild = (requestedSignal: NodeJS.Signals): void => {
      if (!child || settled || finalizing) return;
      try {
        child.kill(requestedSignal);
      } catch (error) {
        terminalError ??= contextualError(`Unable to send ${requestedSignal} to Codex`, error);
      }
    };

    const fail = (error: unknown, context: string): void => {
      if (settled || finalizing) return;
      terminalError ??= contextualError(context, error);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (graceTimer) clearTimeout(graceTimer);
      timeoutTimer = graceTimer = undefined;
      killChild('SIGKILL');
      scheduleForceSettlement();
      destroyStream(child?.stdin);
    };

    const onTimeout = (): void => {
      if (settled || finalizing || childTerminal) return;
      timedOut = true;
      timeoutTimer = undefined;
      killChild('SIGTERM');
      if (terminalError) {
        killChild('SIGKILL');
        scheduleForceSettlement();
        return;
      }
      if (settled || finalizing || childTerminal) return;
      graceTimer = setTimeout(() => {
        graceTimer = undefined;
        if (settled || finalizing || childTerminal) return;
        killChild('SIGKILL');
        scheduleForceSettlement();
      }, dependencies.timings.terminationGraceMs);
    };

    const onChildError = (error: Error): void => fail(error, 'Unable to launch Codex');
    const onStdinError = (error: Error): void => fail(error, 'Codex stdin failed');
    const onStdoutError = (error: Error): void => fail(error, 'Codex stdout stream failed');
    const onStderrError = (error: Error): void => fail(error, 'Codex stderr stream failed');
    const onStdoutArtifactError = (error: Error): void => fail(error, 'Codex stdout artifact failed');
    const onStderrArtifactError = (error: Error): void => fail(error, 'Codex stderr artifact failed');
    const onStdoutArtifactClose = (): void => { stdoutClosed = true; void finish(); };
    const onStderrArtifactClose = (): void => { stderrClosed = true; void finish(); };
    const onClose = (code: number | null, closeSignal: NodeJS.Signals | null): void => {
      closeObserved = true;
      childTerminal = true;
      exitCode = code;
      signal = closeSignal;
      if (graceTimer) clearTimeout(graceTimer);
      if (forceTimer) clearTimeout(forceTimer);
      graceTimer = forceTimer = undefined;
      scheduleCloseWatchdog();
      void finish();
    };

    const cleanupListeners = (): void => {
      if (child) {
        child.removeListener('error', onChildError);
        child.removeListener('close', onClose);
        child.stdin?.removeListener('error', onStdinError);
        child.stdout?.removeListener('error', onStdoutError);
        child.stderr?.removeListener('error', onStderrError);
      }
      stdoutArtifact.removeListener('error', onStdoutArtifactError);
      stderrArtifact.removeListener('error', onStderrArtifactError);
      stdoutArtifact.removeListener('close', onStdoutArtifactClose);
      stderrArtifact.removeListener('close', onStderrArtifactClose);
    };

    stdoutArtifact.on('error', onStdoutArtifactError);
    stderrArtifact.on('error', onStderrArtifactError);
    stdoutArtifact.once('close', onStdoutArtifactClose);
    stderrArtifact.once('close', onStderrArtifactClose);

    try {
      child = dependencies.spawnProcess(request.codexExecutable, args, {
        cwd: workspacePath,
        env: codexEnvironment(),
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (error) {
      terminalError = contextualError('Unable to launch Codex', error);
      childTerminal = true;
      destroyOwnedResources();
      scheduleCloseWatchdog();
      void finish();
      return;
    }

    if (!child.stdin || !child.stdout || !child.stderr) {
      fail(new Error('Codex process did not provide piped stdio'), 'Unable to launch Codex');
      return;
    }

    child.on('error', onChildError);
    child.once('close', onClose);
    child.stdin.on('error', onStdinError);
    child.stdout.on('error', onStdoutError);
    child.stderr.on('error', onStderrError);
    try {
      child.stdout.pipe(stdoutArtifact);
      child.stderr.pipe(stderrArtifact);
      timeoutTimer = setTimeout(onTimeout, request.timeoutMs);
      child.stdin.end(request.workspace.prompt);
    } catch (error) {
      fail(error, 'Unable to connect Codex process streams');
    }
  });
}

export async function readCodexVersion(executable = 'codex'): Promise<string> {
  return await defaultRunner.readCodexVersion(executable);
}

async function readCodexVersionWithDependencies(
  executable: string,
  dependencies: CodexRunnerDependencies
): Promise<string> {
  return await new Promise<string>((resolveVersion, rejectVersion) => {
    let child: ChildProcess;
    let settled = false;
    let outputBytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let terminalError: Error | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;
    let forceTimer: NodeJS.Timeout | undefined;

    const clearTimers = (): void => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (graceTimer) clearTimeout(graceTimer);
      if (forceTimer) clearTimeout(forceTimer);
      timeoutTimer = graceTimer = forceTimer = undefined;
    };

    const cleanup = (): void => {
      child.removeListener('error', onChildError);
      child.removeListener('close', onClose);
      child.stdout?.removeListener('data', onStdoutData);
      child.stderr?.removeListener('data', onStderrData);
      child.stdout?.removeListener('error', onStreamError);
      child.stderr?.removeListener('error', onStreamError);
    };

    const settle = (error?: Error, version?: string, forced = false): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      cleanup();
      if (forced) guardLateErrors(child);
      if (error) rejectVersion(error);
      else resolveVersion(version!);
    };

    const scheduleForceSettlement = (): void => {
      if (settled || forceTimer) return;
      forceTimer = setTimeout(() => {
        destroyStream(child.stdout);
        destroyStream(child.stderr);
        settle(terminalError ?? new Error('Codex version command did not terminate'), undefined, true);
      }, dependencies.timings.forceSettleMs);
    };

    const killChild = (requestedSignal: NodeJS.Signals): void => {
      if (settled) return;
      try {
        child.kill(requestedSignal);
      } catch (error) {
        terminalError ??= contextualError(`Unable to send ${requestedSignal} to Codex version command`, error);
      }
    };

    const terminateImmediately = (error: Error): void => {
      if (settled || terminalError) return;
      terminalError = error;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (graceTimer) clearTimeout(graceTimer);
      timeoutTimer = graceTimer = undefined;
      killChild('SIGKILL');
      scheduleForceSettlement();
    };

    const collect = (target: Buffer[]) => (chunk: Buffer): void => {
      if (settled || terminalError) return;
      outputBytes += chunk.length;
      if (outputBytes > maximumVersionBytes) {
        terminateImmediately(new Error('Codex version output exceeded 8192 bytes'));
        return;
      }
      target.push(chunk);
    };
    const onStdoutData = collect(stdout);
    const onStderrData = collect(stderr);
    const onStreamError = (error: Error): void => terminateImmediately(contextualError('Codex version stream failed', error));
    const onChildError = (error: Error): void => terminateImmediately(contextualError('Unable to read Codex version', error));
    const onClose = (code: number | null): void => {
      if (terminalError) {
        settle(terminalError);
        return;
      }
      const output = Buffer.concat(stdout).toString('utf8').trim();
      const errorOutput = Buffer.concat(stderr).toString('utf8').trim();
      if (code !== 0) {
        settle(new Error(`Codex version command exited with ${code ?? 'no exit code'}${errorOutput ? `: ${errorOutput}` : ''}`));
        return;
      }
      if (!/^(?:codex-cli|codex) \d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(output)) {
        settle(new Error('Codex version command did not return a valid Codex version'));
        return;
      }
      settle(undefined, output);
    };

    try {
      child = dependencies.spawnProcess(executable, ['--version'], {
        env: codexEnvironment(),
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      rejectVersion(contextualError('Unable to read Codex version', error));
      return;
    }

    if (!child.stdout || !child.stderr) {
      settle(new Error('Codex version process did not provide piped output'));
      return;
    }
    child.on('error', onChildError);
    child.once('close', onClose);
    child.stdout.on('data', onStdoutData);
    child.stderr.on('data', onStderrData);
    child.stdout.on('error', onStreamError);
    child.stderr.on('error', onStreamError);
    timeoutTimer = setTimeout(() => {
      timeoutTimer = undefined;
      terminalError = new Error(`Codex version command timed out after ${dependencies.timings.versionTimeoutMs}ms`);
      killChild('SIGTERM');
      if (settled) return;
      graceTimer = setTimeout(() => {
        graceTimer = undefined;
        if (settled) return;
        killChild('SIGKILL');
        scheduleForceSettlement();
      }, dependencies.timings.terminationGraceMs);
    }, dependencies.timings.versionTimeoutMs);
  });
}

interface ArtifactPaths {
  stdoutPath: string;
  stderrPath: string;
}

async function reserveArtifacts(artifactsDirectory: string, token: string): Promise<ArtifactPaths> {
  await mkdir(artifactsDirectory, { recursive: true, mode: 0o700 });
  const paths = {
    stdoutPath: join(artifactsDirectory, `codex-${token}.stdout`),
    stderrPath: join(artifactsDirectory, `codex-${token}.stderr`)
  };
  const created: string[] = [];
  try {
    for (const path of [paths.stdoutPath, paths.stderrPath]) {
      const handle = await open(path, 'wx', 0o600);
      created.push(path);
      try {
        await handle.close();
      } catch (error) {
        await handle.close().catch(() => {});
        throw error;
      }
    }
    return paths;
  } catch (error) {
    await removePaths(created);
    throw error;
  }
}

async function removeArtifacts(paths: ArtifactPaths): Promise<void> {
  await removePaths([paths.stdoutPath, paths.stderrPath]);
}

async function removePaths(paths: string[]): Promise<void> {
  const results = await Promise.allSettled(paths.map(path => unlink(path)));
  const failure = results.find(result => result.status === 'rejected' && !isErrno(result.reason, 'ENOENT'));
  if (failure?.status === 'rejected') throw failure.reason;
}

function deferArtifactCleanup(paths: ArtifactPaths, streams: Writable[]): void {
  const ignoreError = (_error: Error): void => {};
  let cleanupStarted = false;
  const removeGuards = (): void => {
    for (const stream of streams) {
      stream.removeListener('error', ignoreError);
      stream.removeListener('close', attemptCleanup);
    }
  };
  const attemptCleanup = (): void => {
    if (cleanupStarted || !streams.every(streamIsClosed)) return;
    cleanupStarted = true;
    void (async () => {
      try {
        await removeArtifacts(paths);
      } catch {
        // Cleanup is best effort after the caller has already received the bounded failure.
      } finally {
        removeGuards();
      }
    })();
  };

  for (const stream of streams) {
    stream.on('error', ignoreError);
    if (!streamIsClosed(stream)) stream.once('close', attemptCleanup);
  }
  attemptCleanup();
}

async function closeWritableStreams(streams: Writable[], forceSettleMs: number): Promise<boolean> {
  await Promise.all(streams.map(async stream => {
    if (streamIsClosed(stream)) return;
    await new Promise<void>(resolveClose => {
      const timer = setTimeout(resolveClose, forceSettleMs);
      const ignoreError = (_error: Error): void => {};
      stream.on('error', ignoreError);
      stream.once('close', () => {
        clearTimeout(timer);
        stream.removeListener('error', ignoreError);
        resolveClose();
      });
      destroyStream(stream);
    });
  }));
  return streams.every(streamIsClosed);
}

function guardLateErrors(child: ChildProcess, additionalStreams: Writable[] = []): void {
  const ignoreError = (_error: Error): void => {};
  const streams: Array<Readable | Writable> = [
    child.stdin,
    child.stdout,
    child.stderr,
    ...additionalStreams
  ].filter((stream): stream is Readable | Writable => stream !== null);
  child.on('error', ignoreError);
  for (const stream of streams) stream.on('error', ignoreError);
  child.once('close', () => {
    child.removeListener('error', ignoreError);
    for (const stream of streams) stream.removeListener('error', ignoreError);
  });
  for (const stream of streams) destroyStream(stream);
}

function destroyStream(stream: Readable | Writable | null | undefined): void {
  if (!stream || stream.destroyed) return;
  try {
    stream.destroy();
  } catch {
    // The force-settle watchdog remains responsible for settlement.
  }
}

function streamIsClosed(stream: Writable): boolean {
  return stream.closed;
}

function contextualError(context: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`${context}: ${detail}`, { cause: error });
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
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
    'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'CODEX_HOME', 'OPENAI_API_KEY', 'CODEX_API_KEY',
    'CODEX_ACCESS_TOKEN', 'CODEX_CA_CERTIFICATE', 'HTTPS_PROXY', 'HTTP_PROXY',
    'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'TMPDIR', 'TEMP', 'TMP', 'USER', 'LOGNAME', 'LANG', 'LC_ALL',
    'SYSTEMROOT', 'COMSPEC', 'PATHEXT'
  ];
  return Object.fromEntries(allowed.flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]])) as NodeJS.ProcessEnv;
}
