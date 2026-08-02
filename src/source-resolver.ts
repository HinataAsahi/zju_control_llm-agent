import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { Buffer } from 'node:buffer';
import type { AppConfig } from './config.js';
import { JqToolError, type JqSource } from './jq-schema.js';

export async function resolveSource(
  source: JqSource,
  config: Pick<AppConfig, 'root' | 'limits'>
): Promise<string> {
  if (source.type === 'inline') {
    const input = JSON.stringify(source.data);
    if (Buffer.byteLength(input, 'utf8') > config.limits.inputLimitBytes) {
      throw new JqToolError('INPUT_TOO_LARGE', 'Inline input exceeds the size limit.');
    }
    return input;
  }

  const userPath = source.path;
  if (isAbsolute(userPath) || isOutsideRoot(config.root, resolve(config.root, userPath))) {
    throw pathNotAllowed(userPath);
  }

  let target: string;
  try {
    target = await realpath(resolve(config.root, userPath));
  } catch (error: unknown) {
    if (isErrno(error, 'ENOENT')) throw new JqToolError('FILE_NOT_FOUND', `File not found: ${userPath}`);
    throw pathNotAllowed(userPath);
  }
  if (isOutsideRoot(config.root, target)) throw pathNotAllowed(userPath);

  let targetStats;
  try {
    targetStats = await stat(target);
  } catch (error: unknown) {
    if (isErrno(error, 'ENOENT')) throw new JqToolError('FILE_NOT_FOUND', `File not found: ${userPath}`);
    throw pathNotAllowed(userPath);
  }
  if (!targetStats.isFile()) throw pathNotAllowed(userPath);
  if (targetStats.size > config.limits.inputLimitBytes) {
    throw new JqToolError('INPUT_TOO_LARGE', `Input exceeds the size limit: ${userPath}`);
  }

  let input: string;
  try {
    input = await readFile(target, 'utf8');
  } catch (error: unknown) {
    if (isErrno(error, 'ENOENT')) throw new JqToolError('FILE_NOT_FOUND', `File not found: ${userPath}`);
    throw pathNotAllowed(userPath);
  }
  if (Buffer.byteLength(input, 'utf8') > config.limits.inputLimitBytes) {
    throw new JqToolError('INPUT_TOO_LARGE', `Input exceeds the size limit: ${userPath}`);
  }
  return input;
}

function isOutsideRoot(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath);
}

function pathNotAllowed(userPath: string): JqToolError {
  return new JqToolError('PATH_NOT_ALLOWED', `Path not allowed: ${userPath}`);
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
