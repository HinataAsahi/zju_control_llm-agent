import { lstat, readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, posix } from 'node:path';
import { experimentTaskSchema, type ExperimentTask } from './schema.js';

const taskFilenamePattern = /^T.*\.json$/;
const fixturePrefix = 'fixtures/';

export async function loadTasks(experimentRoot: string): Promise<ExperimentTask[]> {
  const tasksDirectory = join(experimentRoot, 'tasks');
  const taskEntries = await readdir(tasksDirectory, { withFileTypes: true });
  const taskFiles = taskEntries
    .filter(entry => entry.isFile() && taskFilenamePattern.test(entry.name))
    .map(entry => entry.name)
    .sort();

  const tasks = await Promise.all(taskFiles.map(async filename => {
    const contents = await readFile(join(tasksDirectory, filename), 'utf8');
    return experimentTaskSchema.parse(JSON.parse(contents));
  }));

  const ids = new Set<string>();
  for (const task of tasks) {
    if (ids.has(task.id)) throw new Error(`Duplicate task ID: ${task.id}`);
    ids.add(task.id);

    const files = new Set<string>();
    for (const inputFile of task.inputFiles) {
      validateFixturePath(inputFile);
      if (files.has(inputFile)) throw new Error(`Duplicate fixture path: ${inputFile}`);
      files.add(inputFile);

      const fixture = join(tasksDirectory, inputFile);
      const stats = await lstat(fixture);
      if (!stats.isFile()) throw new Error(`Fixture must be a regular file: ${inputFile}`);
    }
  }

  return tasks.sort((left, right) => Number(left.id.slice(1)) - Number(right.id.slice(1)));
}

function validateFixturePath(path: string): void {
  if (
    isAbsolute(path) ||
    path.includes('\\') ||
    !path.startsWith(fixturePrefix) ||
    posix.normalize(path) !== path ||
    path.slice(fixturePrefix.length).length === 0
  ) {
    throw new Error(`Fixture path must be a normalized relative path below tasks/fixtures: ${path}`);
  }
}
