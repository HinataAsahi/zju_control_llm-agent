import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, posix, relative, resolve, sep } from 'node:path';
import type { ExperimentCondition, ExperimentTask } from './schema.js';

export interface PreparedWorkspace {
  path: string;
  prompt: string;
  outputSchemaPath: string;
}

export interface PrepareWorkspaceOptions {
  task: ExperimentTask;
  condition: ExperimentCondition;
  experimentRoot: string;
  taskRoot?: string;
  skillAsset?: {
    root: string;
    relativePath: string;
  };
  runRoot: string;
  runId: string;
}

const fixturePrefix = 'fixtures/';
const workspaceReservations = new Set<string>();

export async function prepareWorkspace(options: PrepareWorkspaceOptions): Promise<PreparedWorkspace> {
  validateRunId(options.runId);

  const resolvedRunRoot = resolve(options.runRoot);
  const workspacePath = join(resolvedRunRoot, 'workspaces', options.runId);
  reserveWorkspace(workspacePath);

  try {
    return await prepareReservedWorkspace(options, resolvedRunRoot, workspacePath);
  } finally {
    workspaceReservations.delete(workspacePath);
  }
}

async function prepareReservedWorkspace(
  options: PrepareWorkspaceOptions,
  resolvedRunRoot: string,
  workspacePath: string
): Promise<PreparedWorkspace> {
  const experimentRoot = resolve(options.experimentRoot);
  const taskRoot = resolve(options.taskRoot ?? options.experimentRoot);
  await validateDirectory(experimentRoot, 'experiment root');
  await validateDirectory(taskRoot, 'task root');

  const workspacesDirectory = await prepareWorkspacesDirectory(resolvedRunRoot);
  await assertPathDoesNotExist(workspacePath);

  let temporaryPath: string | undefined;
  try {
    temporaryPath = await mkdtemp(join(workspacesDirectory, `.${options.runId}-`));
    await chmod(temporaryPath, 0o700);

    for (const inputFile of options.task.inputFiles) {
      validateFixturePath(inputFile);
      const sourcePath = resolve(taskRoot, 'tasks', inputFile);
      const destinationPath = join(temporaryPath, ...inputFile.slice(fixturePrefix.length).split('/'));
      await copyRegularFile(taskRoot, sourcePath, destinationPath);
    }

    if (options.skillAsset) {
      validateRelativeAssetPath(options.skillAsset.relativePath);
      const skillRoot = resolve(options.skillAsset.root);
      await copyRegularFile(
        skillRoot,
        join(skillRoot, ...options.skillAsset.relativePath.split('/')),
        join(temporaryPath, '.agents', 'skills', 'jq-query', 'SKILL.md')
      );
    }

    const temporarySchemaPath = join(temporaryPath, 'final-answer.schema.json');
    await copyRegularFile(
      experimentRoot,
      join(experimentRoot, 'schemas', 'final-answer.schema.json'),
      temporarySchemaPath
    );

    const promptParts = [await readRegularText(experimentRoot, join(experimentRoot, 'prompts', 'common.txt'))];
    if (options.condition === 'explicit') {
      const explicitPrompt = options.task.kind === 'negative' ? 'explicit-negative.txt' : 'explicit-applicable.txt';
      promptParts.push(await readRegularText(experimentRoot, join(experimentRoot, 'prompts', explicitPrompt)));
    }
    promptParts.push(options.task.prompt);
    const prompt = promptParts.map(normalizePromptText).join('\n');

    await assertPathDoesNotExist(workspacePath);
    await rename(temporaryPath, workspacePath);
    temporaryPath = undefined;

    return {
      path: workspacePath,
      prompt,
      outputSchemaPath: join(workspacePath, 'final-answer.schema.json')
    };
  } catch (error) {
    if (temporaryPath !== undefined) {
      try {
        await rm(temporaryPath, { recursive: true, force: true });
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Workspace preparation and cleanup both failed');
      }
    }
    throw error;
  }
}

async function prepareWorkspacesDirectory(runRoot: string): Promise<string> {
  await ensureSafeDirectoryChain(runRoot);
  const workspacesDirectory = join(runRoot, 'workspaces');
  await ensureSafeDirectoryComponent(workspacesDirectory);
  return workspacesDirectory;
}

async function ensureSafeDirectoryChain(path: string): Promise<void> {
  const absolutePath = resolve(path);
  const root = parse(absolutePath).root;
  await validateDirectory(root, 'destination path');

  let currentPath = root;
  const remainder = relative(root, absolutePath);
  if (remainder.length === 0) return;

  for (const component of remainder.split(sep)) {
    currentPath = join(currentPath, component);
    await ensureSafeDirectoryComponent(currentPath);
  }
}

async function ensureSafeDirectoryComponent(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  await validateDirectory(path, 'destination path');
}

async function validateDirectory(path: string, label: string): Promise<void> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Unsafe ${label} directory: ${path}`);
  }
}

async function assertPathDoesNotExist(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }

  throw workspaceExistsError(path);
}

async function copyRegularFile(experimentRoot: string, sourcePath: string, destinationPath: string): Promise<void> {
  const contents = await readRegularFile(experimentRoot, sourcePath);
  await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 });
  await writeFile(destinationPath, contents, { flag: 'wx', mode: 0o600 });
}

async function readRegularText(experimentRoot: string, sourcePath: string): Promise<string> {
  return (await readRegularFile(experimentRoot, sourcePath)).toString('utf8');
}

async function readRegularFile(experimentRoot: string, sourcePath: string): Promise<Buffer> {
  await validateSourcePath(experimentRoot, sourcePath);
  const pathStats = await lstat(sourcePath, { bigint: true });
  if (pathStats.isSymbolicLink() || !pathStats.isFile()) {
    throw new Error(`Source must be a regular non-symlink file: ${sourcePath}`);
  }

  const noFollow = Reflect.get(constants, 'O_NOFOLLOW');
  const flags = constants.O_RDONLY | (typeof noFollow === 'number' ? noFollow : 0);
  const handle = await open(sourcePath, flags);
  try {
    const openedStats = await handle.stat({ bigint: true });
    if (
      !openedStats.isFile() ||
      openedStats.dev !== pathStats.dev ||
      openedStats.ino !== pathStats.ino
    ) {
      throw new Error(`Source changed while being opened: ${sourcePath}`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function validateSourcePath(experimentRoot: string, sourcePath: string): Promise<void> {
  const relativeSourcePath = relative(experimentRoot, sourcePath);
  if (
    relativeSourcePath.length === 0 ||
    isAbsolute(relativeSourcePath) ||
    relativeSourcePath === '..' ||
    relativeSourcePath.startsWith(`..${sep}`)
  ) {
    throw new Error(`Source must be below the experiment root: ${sourcePath}`);
  }

  await validateDirectory(experimentRoot, 'experiment root');
  let currentPath = experimentRoot;
  const components = relativeSourcePath.split(sep);
  for (const component of components.slice(0, -1)) {
    currentPath = join(currentPath, component);
    await validateDirectory(currentPath, 'source path');
  }
}

function reserveWorkspace(workspacePath: string): void {
  if (workspaceReservations.has(workspacePath)) throw workspaceExistsError(workspacePath);
  workspaceReservations.add(workspacePath);
}

function workspaceExistsError(workspacePath: string): NodeJS.ErrnoException {
  const error = new Error(`Workspace already exists: ${workspacePath}`) as NodeJS.ErrnoException;
  error.code = 'EEXIST';
  return error;
}

function validateRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId) || runId === '.' || runId === '..') {
    throw new Error(`unsafe run ID: ${runId}`);
  }
}

function validateFixturePath(inputFile: string): void {
  if (
    isAbsolute(inputFile) ||
    inputFile.includes('\\') ||
    !inputFile.startsWith(fixturePrefix) ||
    posix.normalize(inputFile) !== inputFile ||
    inputFile.slice(fixturePrefix.length).length === 0
  ) {
    throw new Error(`unsafe fixture path: ${inputFile}`);
  }
}

function validateRelativeAssetPath(path: string): void {
  if (
    isAbsolute(path) ||
    path.includes('\\') ||
    posix.normalize(path) !== path ||
    path.length === 0 ||
    path === '..' ||
    path.startsWith('../')
  ) {
    throw new Error(`unsafe relative asset path: ${path}`);
  }
}

function normalizePromptText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\n+$/g, '');
}
