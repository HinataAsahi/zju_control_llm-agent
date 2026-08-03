import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, resolve } from 'node:path';
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
  runRoot: string;
  runId: string;
}

const fixturePrefix = 'fixtures/';

export async function prepareWorkspace(options: PrepareWorkspaceOptions): Promise<PreparedWorkspace> {
  validateRunId(options.runId);

  const workspacesDirectory = await prepareWorkspacesDirectory(options.runRoot);
  const workspacePath = join(workspacesDirectory, options.runId);
  await assertPathDoesNotExist(workspacePath);

  let temporaryPath: string | undefined;
  try {
    temporaryPath = await mkdtemp(join(workspacesDirectory, `.${options.runId}-`));
    await chmod(temporaryPath, 0o700);

    for (const inputFile of options.task.inputFiles) {
      validateFixturePath(inputFile);
      const sourcePath = resolve(options.experimentRoot, 'tasks', inputFile);
      const destinationPath = join(temporaryPath, ...inputFile.split('/'));
      await copyRegularFile(sourcePath, destinationPath);
    }

    if (options.condition === 'skill') {
      await copyRegularFile(
        join(options.experimentRoot, 'reference-skill', 'SKILL.md'),
        join(temporaryPath, '.agents', 'skills', 'jq-query', 'SKILL.md')
      );
    }

    const temporarySchemaPath = join(temporaryPath, 'final-answer.schema.json');
    await copyRegularFile(
      join(options.experimentRoot, 'schemas', 'final-answer.schema.json'),
      temporarySchemaPath
    );

    const promptParts = [await readRegularText(join(options.experimentRoot, 'prompts', 'common.txt'))];
    if (options.condition === 'explicit') {
      const explicitPrompt = options.task.id === 'T8' ? 'explicit-negative.txt' : 'explicit-applicable.txt';
      promptParts.push(await readRegularText(join(options.experimentRoot, 'prompts', explicitPrompt)));
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
  await mkdir(runRoot, { recursive: true, mode: 0o700 });
  const workspacesDirectory = join(runRoot, 'workspaces');

  try {
    await mkdir(workspacesDirectory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }

  const stats = await lstat(workspacesDirectory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Unsafe workspaces directory: ${workspacesDirectory}`);
  }
  return workspacesDirectory;
}

async function assertPathDoesNotExist(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }

  const error = new Error(`Workspace already exists: ${path}`) as NodeJS.ErrnoException;
  error.code = 'EEXIST';
  throw error;
}

async function copyRegularFile(sourcePath: string, destinationPath: string): Promise<void> {
  const contents = await readRegularFile(sourcePath);
  await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 });
  await writeFile(destinationPath, contents, { flag: 'wx', mode: 0o600 });
}

async function readRegularText(sourcePath: string): Promise<string> {
  return (await readRegularFile(sourcePath)).toString('utf8');
}

async function readRegularFile(sourcePath: string): Promise<Buffer> {
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

function normalizePromptText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\n+$/g, '');
}
