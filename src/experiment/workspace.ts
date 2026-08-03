import { chmod, copyFile, mkdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, posix, resolve } from 'node:path';
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

  const workspacePath = join(options.runRoot, 'workspaces', options.runId);
  await mkdir(join(options.runRoot, 'workspaces'), { recursive: true, mode: 0o700 });
  await mkdir(workspacePath, { mode: 0o700 });
  await chmod(workspacePath, 0o700);

  for (const inputFile of options.task.inputFiles) {
    validateFixturePath(inputFile);
    const sourcePath = resolve(options.experimentRoot, 'tasks', inputFile);
    const destinationPath = join(workspacePath, ...inputFile.split('/'));
    await mkdir(join(destinationPath, '..'), { recursive: true });
    await copyFile(sourcePath, destinationPath);
  }

  if (options.condition === 'skill') {
    const skillPath = join(workspacePath, '.agents', 'skills', 'jq-query', 'SKILL.md');
    await mkdir(join(workspacePath, '.agents', 'skills', 'jq-query'), { recursive: true });
    await copyFile(join(options.experimentRoot, 'reference-skill', 'SKILL.md'), skillPath);
  }

  const outputSchemaPath = join(workspacePath, 'final-answer.schema.json');
  await copyFile(join(options.experimentRoot, 'schemas', 'final-answer.schema.json'), outputSchemaPath);

  const promptFiles = [join(options.experimentRoot, 'prompts', 'common.txt')];
  if (options.condition === 'explicit') {
    promptFiles.push(join(options.experimentRoot, 'prompts', options.task.id === 'T8' ? 'explicit-negative.txt' : 'explicit-applicable.txt'));
  }
  promptFiles.push('task');

  const promptParts = await Promise.all(promptFiles.map(async filename => {
    if (filename === 'task') return normalizePromptText(options.task.prompt);
    return normalizePromptText(await readFile(filename, 'utf8'));
  }));

  return { path: workspacePath, prompt: promptParts.join('\n'), outputSchemaPath };
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
