import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { Buffer } from 'node:buffer';
import type { AppConfig } from './config.js';
import { JqToolError, type JqSource } from './jq-schema.js';

interface ResolverFileSystem {
  realpath(path: string): Promise<string>;
  open(path: string, flags: number): Promise<FileHandle>;
}

const nodeFileSystem: ResolverFileSystem = { realpath, open };
const readNoFollowFlags = constants.O_RDONLY
  | (typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0);

export async function resolveSource(
  source: JqSource,
  config: Pick<AppConfig, 'root' | 'limits'>,
  fileSystem: ResolverFileSystem = nodeFileSystem
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

  const candidate = resolve(config.root, userPath);
  let target: string;
  try {
    target = await fileSystem.realpath(candidate);
  } catch (error: unknown) {
    if (isErrno(error, 'ENOENT')) throw new JqToolError('FILE_NOT_FOUND', `File not found: ${userPath}`);
    throw pathNotAllowed(userPath);
  }
  if (isOutsideRoot(config.root, target)) throw pathNotAllowed(userPath);

  let handle: FileHandle;
  try {
    handle = await fileSystem.open(candidate, readNoFollowFlags);
  } catch (error: unknown) {
    if (isErrno(error, 'ENOENT')) throw new JqToolError('FILE_NOT_FOUND', `File not found: ${userPath}`);
    throw pathNotAllowed(userPath);
  }

  try {
    const targetStats = await handle.stat();
    if (!targetStats.isFile()) throw pathNotAllowed(userPath);
    if (targetStats.size > config.limits.inputLimitBytes) {
      throw new JqToolError('INPUT_TOO_LARGE', `Input exceeds the size limit: ${userPath}`);
    }

    const input = Buffer.allocUnsafe(config.limits.inputLimitBytes + 1);
    let inputBytes = 0;
    while (inputBytes < input.byteLength) {
      const { bytesRead } = await handle.read(
        input,
        inputBytes,
        input.byteLength - inputBytes,
        inputBytes
      );
      if (bytesRead === 0) break;
      inputBytes += bytesRead;
    }
    if (inputBytes > config.limits.inputLimitBytes) {
      throw new JqToolError('INPUT_TOO_LARGE', `Input exceeds the size limit: ${userPath}`);
    }
    const decodedInput = input.subarray(0, inputBytes).toString('utf8');
    if (Buffer.byteLength(decodedInput, 'utf8') > config.limits.inputLimitBytes) {
      throw new JqToolError('INPUT_TOO_LARGE', `Input exceeds the size limit: ${userPath}`);
    }
    return decodedInput;
  } catch (error: unknown) {
    if (error instanceof JqToolError) throw error;
    if (isErrno(error, 'ENOENT')) throw new JqToolError('FILE_NOT_FOUND', `File not found: ${userPath}`);
    throw pathNotAllowed(userPath);
  } finally {
    try {
      await handle.close();
    } catch {
      // The read result or mapped error remains authoritative after close was attempted.
    }
  }
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
