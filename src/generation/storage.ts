import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const ARTIFACT_NAME = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export async function writeGenerationJson(
  repositoryRoot: string,
  name: string,
  value: unknown
): Promise<string> {
  return writeGenerationText(repositoryRoot, name, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeGenerationText(
  repositoryRoot: string,
  name: string,
  value: string
): Promise<string> {
  validateArtifactName(name);
  validateNoCredentials(value);
  const root = await ensureGenerationRoot(repositoryRoot);
  const destination = join(root, name);
  const temporary = join(root, `.${name}-${randomBytes(8).toString('hex')}.tmp`);
  let created = false;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    created = true;
    try {
      await handle.writeFile(value, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, destination);
    created = false;
    await chmod(destination, 0o600);
    return destination;
  } finally {
    if (created) await unlink(temporary).catch(() => undefined);
  }
}

export async function readGenerationJson(repositoryRoot: string, name: string): Promise<unknown> {
  const text = await readGenerationText(repositoryRoot, name);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Generation artifact ${name} is not valid JSON.`);
  }
}

export async function readGenerationText(repositoryRoot: string, name: string): Promise<string> {
  validateArtifactName(name);
  const root = await ensureGenerationRoot(repositoryRoot);
  const path = join(root, name);
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`Unsafe generation artifact: ${name}`);
  }
  return readFile(path, 'utf8');
}

export function generationArtifactPath(repositoryRoot: string, name: string): string {
  validateArtifactName(name);
  return join(resolve(repositoryRoot), '.generation-runs', 'stage-3', 'jq', name);
}

async function ensureGenerationRoot(repositoryRoot: string): Promise<string> {
  const paths = [
    join(resolve(repositoryRoot), '.generation-runs'),
    join(resolve(repositoryRoot), '.generation-runs', 'stage-3'),
    join(resolve(repositoryRoot), '.generation-runs', 'stage-3', 'jq')
  ];
  for (const path of paths) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`Unsafe generation storage directory: ${path}`);
    }
    await chmod(path, 0o700);
  }
  return paths[2]!;
}

function validateArtifactName(name: string): void {
  if (!ARTIFACT_NAME.test(name) || name === '.' || name === '..') {
    throw new Error(`Unsafe generation artifact name: ${name}`);
  }
}

function validateNoCredentials(value: string): void {
  if (
    /DEEPSEEK_API_KEY/i.test(value)
    || /Authorization\s*[:=]/i.test(value)
    || /Bearer\s+[A-Za-z0-9._-]+/i.test(value)
    || /\bsk-[A-Za-z0-9_-]{12,}\b/.test(value)
  ) {
    throw new Error('Generation artifact contains sensitive credential material.');
  }
}
