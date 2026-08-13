import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  readCodexVersion,
  runCodex,
  type ModelConfiguration
} from './codex-runner.js';
import {
  evaluateRun,
  renderMarkdownReport,
  sanitizeRun,
  type EvaluatedRun
} from './report.js';
import type { ExperimentCondition, ExperimentTask } from './schema.js';
import { loadTasks } from './task-loader.js';
import { parseTrace } from './trace-parser.js';
import { prepareWorkspace } from './workspace.js';

const execFileAsync = promisify(execFile);
const conditions: ExperimentCondition[] = ['explicit', 'description', 'skill'];
const calibrationTaskIds = ['T1', 'T4', 'T7'] as const;
const defaultTimeoutMs = 120_000;

export const CALIBRATION_LADDER: readonly ModelConfiguration[] = [
  { model: 'gpt-5.6-luna', reasoningEffort: 'low' },
  { model: 'gpt-5.6-luna', reasoningEffort: 'medium' },
  { model: 'gpt-5.6-terra', reasoningEffort: 'medium' }
];

export interface FormalPair {
  task: ExperimentTask;
  condition: ExperimentCondition;
}

export interface CalibrationOutcome {
  status: 'selected' | 'infrastructure-error' | 'failed';
  tierIndex: number;
  selected?: ModelConfiguration;
  attempts: EvaluatedRun[];
}

export type Stage2aCommand =
  | { mode: 'help' }
  | { mode: 'smoke' }
  | { mode: 'calibrate' }
  | { mode: 'report' }
  | { mode: 'experience'; taskId: 'T3' | 'T7'; launch: boolean }
  | {
    mode: 'formal';
    resume: boolean;
    model?: ModelConfiguration['model'];
    reasoningEffort?: ModelConfiguration['reasoningEffort'];
  };

export async function runCalibration(
  execute: (taskId: string, model: ModelConfiguration) => Promise<EvaluatedRun>,
  startTier = 0
): Promise<CalibrationOutcome> {
  if (!Number.isInteger(startTier) || startTier < 0 || startTier >= CALIBRATION_LADDER.length) {
    throw new Error('Invalid calibration tier.');
  }
  const attempts: EvaluatedRun[] = [];
  for (let tierIndex = startTier; tierIndex < CALIBRATION_LADDER.length; tierIndex += 1) {
    const model = CALIBRATION_LADDER[tierIndex]!;
    let tierPassed = true;
    for (const taskId of calibrationTaskIds) {
      const run = await execute(taskId, model);
      attempts.push(run);
      if (run.validity !== 'valid') {
        return { status: 'infrastructure-error', tierIndex, attempts };
      }
      if (!calibrationRunPassed(run)) {
        tierPassed = false;
        break;
      }
    }
    if (tierPassed) return { status: 'selected', tierIndex, selected: model, attempts };
  }
  return { status: 'failed', tierIndex: CALIBRATION_LADDER.length - 1, attempts };
}

export function buildFormalSchedule(tasks: ExperimentTask[]): FormalPair[] {
  return tasks.flatMap(task => conditions.map(condition => ({ task, condition })));
}

export function filterFormalSchedule(
  schedule: FormalPair[],
  existing: EvaluatedRun[],
  resume: boolean
): FormalPair[] {
  const byPair = new Map(existing.map(run => [pairKey(run.taskId, run.condition), run]));
  if (!resume && schedule.some(pair => byPair.has(pairKey(pair.task.id, pair.condition)))) {
    throw new Error('Formal observations already exist; use --resume to fill only missing or infrastructure-invalid pairs.');
  }
  return schedule.filter(pair => {
    const prior = byPair.get(pairKey(pair.task.id, pair.condition));
    return prior === undefined || (resume && prior.validity === 'infrastructure-error');
  });
}

export function assertCalibrationMatch(
  selected: ModelConfiguration,
  requested: ModelConfiguration
): void {
  if (
    selected.model !== requested.model
    || selected.reasoningEffort !== requested.reasoningEffort
  ) {
    throw new Error('Requested model configuration does not match the saved calibration.');
  }
}

export function buildInteractiveArguments(options: {
  workspacePath: string;
  serverEntrypoint: string;
  model: ModelConfiguration;
  prompt: string;
}): string[] {
  const workspacePath = resolve(options.workspacePath);
  const serverEntrypoint = resolve(options.serverEntrypoint);
  const overrides = mcpOverrides(serverEntrypoint, workspacePath, options.model.reasoningEffort);
  return [
    '--model', options.model.model,
    '--sandbox', 'read-only',
    ...overrides.flatMap(override => ['-c', override]),
    '-C', workspacePath,
    options.prompt
  ];
}

export function parseStage2aArgs(argv: string[]): Stage2aCommand {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help')) {
    return { mode: 'help' };
  }
  const mode = argv[0];
  if (mode === 'smoke' || mode === 'calibrate' || mode === 'report') {
    if (argv.length !== 1) throw new Error(`Unknown arguments for ${mode}.`);
    return { mode };
  }
  if (mode === 'experience') {
    let taskId: 'T3' | 'T7' | undefined;
    let launch = false;
    for (let index = 1; index < argv.length; index += 1) {
      const argument = argv[index];
      if (argument === '--launch') {
        if (launch) throw new Error('Duplicate --launch flag.');
        launch = true;
      } else if (argument === '--task') {
        const value = argv[++index];
        if (value !== 'T3' && value !== 'T7') throw new Error('Experience task must be T3 or T7.');
        if (taskId) throw new Error('Duplicate --task flag.');
        taskId = value;
      } else {
        throw new Error(`Unknown experience argument: ${argument ?? ''}`);
      }
    }
    if (!taskId) throw new Error('Experience requires --task T3 or T7.');
    return { mode, taskId, launch };
  }
  if (mode === 'formal') {
    let resume = false;
    let model: ModelConfiguration['model'] | undefined;
    let reasoningEffort: ModelConfiguration['reasoningEffort'] | undefined;
    for (let index = 1; index < argv.length; index += 1) {
      const argument = argv[index];
      if (argument === '--resume') {
        if (resume) throw new Error('Duplicate --resume flag.');
        resume = true;
      } else if (argument === '--model') {
        const value = argv[++index];
        if (value !== 'gpt-5.6-luna' && value !== 'gpt-5.6-terra') throw new Error('Unsupported formal model.');
        if (model) throw new Error('Duplicate --model flag.');
        model = value;
      } else if (argument === '--reasoning') {
        const value = argv[++index];
        if (value !== 'low' && value !== 'medium') throw new Error('Unsupported formal reasoning effort.');
        if (reasoningEffort) throw new Error('Duplicate --reasoning flag.');
        reasoningEffort = value;
      } else {
        throw new Error(`Unknown formal argument: ${argument ?? ''}`);
      }
    }
    if ((model === undefined) !== (reasoningEffort === undefined)) {
      throw new Error('--model and --reasoning must be supplied together.');
    }
    return {
      mode,
      resume,
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {})
    };
  }
  throw new Error(`Unknown mode: ${mode ?? '(missing)'}`);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const command = parseStage2aArgs(argv);
  if (command.mode === 'help') {
    process.stdout.write(helpText);
    return;
  }

  const repositoryRoot = process.cwd();
  const experimentRoot = resolve(repositoryRoot, 'experiments/stage-2a');
  const runRoot = resolve(repositoryRoot, '.experiment-runs/stage-2a');
  const serverEntrypoint = resolve(repositoryRoot, 'dist/src/mcp/server.js');
  const tasks = await loadTasks(experimentRoot);
  await mkdir(runRoot, { recursive: true, mode: 0o700 });

  if (command.mode === 'smoke') {
    const task = requireTask(tasks, 'T1');
    const result = await executeObservation({
      task,
      condition: 'explicit',
      model: CALIBRATION_LADDER[0]!,
      experimentRoot,
      runRoot,
      serverEntrypoint,
      phase: 'smoke'
    });
    process.stdout.write(`${JSON.stringify(sanitizeRun(result), null, 2)}\n`);
    return;
  }

  if (command.mode === 'calibrate') {
    const calibrationPath = resolve(runRoot, 'calibration.json');
    const previous = await readOptionalJson<CalibrationFile>(calibrationPath);
    if (previous?.status === 'selected' && previous.selected) {
      process.stdout.write(`${JSON.stringify({ ...previous, attempts: previous.attempts.map(sanitizeRun) }, null, 2)}\n`);
      return;
    }
    const startTier = previous?.status === 'infrastructure-error' ? previous.tierIndex : 0;
    const outcome = await runCalibration(async (taskId, model) => executeObservation({
      task: requireTask(tasks, taskId),
      condition: 'explicit',
      model,
      experimentRoot,
      runRoot,
      serverEntrypoint,
      phase: 'calibration'
    }), startTier);
    const file: CalibrationFile = {
      ...outcome,
      updatedAt: new Date().toISOString()
    };
    await writeJsonAtomic(calibrationPath, file);
    process.stdout.write(`${JSON.stringify({ ...file, attempts: file.attempts.map(sanitizeRun) }, null, 2)}\n`);
    if (outcome.status !== 'selected') {
      throw new Error(outcome.status === 'infrastructure-error'
        ? 'Calibration stopped on an infrastructure or review failure; fix it and rerun the same tier.'
        : 'No approved calibration tier passed model-behavior checks.');
    }
    return;
  }

  const calibration = await requireSelectedCalibration(resolve(runRoot, 'calibration.json'));
  if (command.mode === 'experience') {
    const task = requireTask(tasks, command.taskId);
    const prepared = await prepareWorkspace({
      task,
      condition: 'explicit',
      experimentRoot,
      runRoot,
      runId: createRunId('experience', task.id, 'explicit')
    });
    const explicit = (await readFile(resolve(experimentRoot, 'prompts/explicit-applicable.txt'), 'utf8')).trimEnd();
    const prompt = `${explicit}\n${task.prompt}`;
    const args = buildInteractiveArguments({
      workspacePath: prepared.path,
      serverEntrypoint,
      model: calibration.selected,
      prompt
    });
    process.stdout.write([
      'Interactive TUI runs are unscored. The TUI does not support exec-only --ephemeral or --ignore-user-config.',
      `Workspace: ${prepared.path}`,
      `Command: ${['codex', ...args].map(shellQuote).join(' ')}`,
      ''
    ].join('\n'));
    if (command.launch) await launchInteractive(args, prepared.path);
    return;
  }

  const formalPath = resolve(runRoot, 'formal-observations.json');
  if (command.mode === 'formal') {
    const requested: ModelConfiguration = command.model && command.reasoningEffort
      ? { model: command.model, reasoningEffort: command.reasoningEffort }
      : calibration.selected;
    assertCalibrationMatch(calibration.selected, requested);
    const existing = await readOptionalJson<EvaluatedRun[]>(formalPath) ?? [];
    const schedule = filterFormalSchedule(buildFormalSchedule(tasks), existing, command.resume);
    let observations = [...existing];
    for (const pair of schedule) {
      const result = await executeObservation({
        task: pair.task,
        condition: pair.condition,
        model: requested,
        experimentRoot,
        runRoot,
        serverEntrypoint,
        phase: 'formal'
      });
      observations = observations.filter(run => pairKey(run.taskId, run.condition) !== pairKey(result.taskId, result.condition));
      observations.push(result);
      observations.sort(compareRuns);
      await writeJsonAtomic(formalPath, observations);
      process.stdout.write(`${result.taskId}/${result.condition}: ${result.validity}, success=${String(result.taskSuccess)}\n`);
      if (result.validity === 'infrastructure-error') {
        throw new Error('Formal run stopped on infrastructure error; fix it and rerun with --resume.');
      }
    }
    return;
  }

  const observations = await readOptionalJson<EvaluatedRun[]>(formalPath) ?? [];
  if (observations.length === 0) throw new Error('No formal observations are available.');
  const [codexVersion, repositoryCommit] = await Promise.all([
    readCodexVersion(),
    readRepositoryCommit(repositoryRoot)
  ]);
  const markdown = renderMarkdownReport(observations, {
    generatedAt: new Date().toISOString(),
    codexVersion,
    repositoryCommit,
    model: calibration.selected
  });
  const reportPath = resolve(runRoot, 'report.zh.md');
  await writeFile(reportPath, markdown, { encoding: 'utf8', mode: 0o600 });
  process.stdout.write(`${markdown}\nLocal report: ${reportPath}\n`);
}

interface CalibrationFile extends CalibrationOutcome {
  updatedAt: string;
}

async function executeObservation(options: {
  task: ExperimentTask;
  condition: ExperimentCondition;
  model: ModelConfiguration;
  experimentRoot: string;
  runRoot: string;
  serverEntrypoint: string;
  phase: string;
}): Promise<EvaluatedRun> {
  const runId = createRunId(options.phase, options.task.id, options.condition);
  const workspace = await prepareWorkspace({
    task: options.task,
    condition: options.condition,
    experimentRoot: options.experimentRoot,
    ...(options.condition === 'skill' ? {
      skillAsset: {
        root: options.experimentRoot,
        relativePath: 'reference-skill/SKILL.md'
      }
    } : {}),
    runRoot: options.runRoot,
    runId
  });
  const raw = await runCodex({
    codexExecutable: 'codex',
    workspace,
    serverEntrypoint: options.serverEntrypoint,
    artifactsDirectory: resolve(options.runRoot, 'artifacts', runId),
    model: options.model,
    timeoutMs: defaultTimeoutMs
  });
  const trace = await parseTrace(raw.stdoutPath);
  return evaluateRun({ task: options.task, condition: options.condition, raw, trace });
}

async function requireSelectedCalibration(path: string): Promise<CalibrationFile & { selected: ModelConfiguration }> {
  const value = await readOptionalJson<CalibrationFile>(path);
  if (!value || value.status !== 'selected' || !value.selected) {
    throw new Error('A successful saved calibration is required.');
  }
  return value as CalibrationFile & { selected: ModelConfiguration };
}

function calibrationRunPassed(run: EvaluatedRun): boolean {
  if (
    run.taskSuccess !== true
    || run.explicitCompliance !== true
    || run.alternativePath !== 'mcp'
  ) return false;
  return run.taskId === 'T7' ? run.recoverySuccess === true : run.firstCallValid === true;
}

function requireTask(tasks: ExperimentTask[], id: string): ExperimentTask {
  const task = tasks.find(candidate => candidate.id === id);
  if (!task) throw new Error(`Task not found: ${id}`);
  return task;
}

function mcpOverrides(serverEntrypoint: string, workspacePath: string, effort: string): string[] {
  const toml = (value: string): string => JSON.stringify(value);
  return [
    `model_reasoning_effort = ${toml(effort)}`,
    `mcp_servers.jq_mcp_server.command = ${toml('node')}`,
    `mcp_servers.jq_mcp_server.args = [${[serverEntrypoint, '--root', workspacePath].map(toml).join(', ')}]`,
    `mcp_servers.jq_mcp_server.default_tools_approval_mode = ${toml('approve')}`,
    'mcp_servers.jq_mcp_server.required = true'
  ];
}

function createRunId(phase: string, taskId: string, condition: string): string {
  const timestamp = new Date().toISOString().replace(/[^0-9A-Za-z]/g, '');
  return `${phase}-${taskId}-${condition}-${timestamp}-${randomBytes(6).toString('hex')}`;
}

function pairKey(taskId: string, condition: ExperimentCondition): string {
  return `${taskId}/${condition}`;
}

function compareRuns(left: EvaluatedRun, right: EvaluatedRun): number {
  const taskOrder = Number(left.taskId.slice(1)) - Number(right.taskId.slice(1));
  return taskOrder || conditions.indexOf(left.condition) - conditions.indexOf(right.condition);
}

async function readOptionalJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}

async function launchInteractive(args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolveLaunch, rejectLaunch) => {
    const child = spawn('codex', args, { cwd, shell: false, stdio: 'inherit', env: process.env });
    child.once('error', rejectLaunch);
    child.once('close', (code, signal) => {
      if (code === 0) resolveLaunch();
      else rejectLaunch(new Error(`Interactive Codex exited with ${code ?? signal ?? 'unknown status'}.`));
    });
  });
}

async function readRepositoryCommit(cwd: string): Promise<string> {
  const result = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' });
  return result.stdout.trim();
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

const helpText = `Stage 2A Codex observation harness

Usage:
  stage2a smoke
  stage2a calibrate
  stage2a experience --task T3|T7 [--launch]
  stage2a formal [--model <model> --reasoning <effort>] [--resume]
  stage2a report

Quota:
  smoke, calibrate, and formal consume model quota.
  experience consumes quota only with --launch; otherwise it only prepares and prints a TUI command.
  report is local-only and does not call a model.
`;

function isEntrypoint(entrypoint: string | undefined): boolean {
  if (!entrypoint) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entrypoint)).href;
  } catch {
    return false;
  }
}

if (isEntrypoint(process.argv[1])) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Stage 2A command failed.';
    console.error(message);
    process.exitCode = 1;
  });
}
