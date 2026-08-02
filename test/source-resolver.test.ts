import assert from 'node:assert/strict';
import type { PathLike } from 'node:fs';
import { appendFile, mkdir, mkdtemp, open, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AppConfig } from '../src/config.js';
import { JqToolError } from '../src/jq-schema.js';
import { resolveSource } from '../src/source-resolver.js';

const limits = { inputLimitBytes: 1024, outputLimitBytes: 1024, timeoutMs: 5000 };

interface ResolverFileSystem {
  realpath(path: PathLike): Promise<string>;
  open(path: PathLike, flags: number): Promise<FileHandle>;
}

const resolveWithFileSystem = resolveSource as unknown as (
  source: Parameters<typeof resolveSource>[0],
  config: Parameters<typeof resolveSource>[1],
  fileSystem: ResolverFileSystem
) => Promise<string>;

async function setup(t: test.TestContext): Promise<{ root: string; outside: string; config: AppConfig }> {
  const directory = await mkdtemp(join(tmpdir(), 'jq-source-'));
  const root = join(directory, 'root');
  const outside = join(directory, 'outside.json');
  await mkdir(root);
  await writeFile(outside, '{"outside":true}\n');
  await writeFile(join(root, 'users.json'), '{"users":["Alice"]}\n');
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { root, outside, config: { root, jqExecutable: 'jq', limits } };
}

function expectsCode(code: JqToolError['code']): (error: unknown) => boolean {
  return (error: unknown) => error instanceof JqToolError && error.code === code;
}

test('resolves inline JSON and files below the root', async (t) => {
  const { config } = await setup(t);

  assert.equal(await resolveSource(
    { type: 'inline', data: { users: ['Alice'] } }, config
  ), '{"users":["Alice"]}');
  assert.equal(await resolveSource(
    { type: 'file', path: 'users.json' }, config
  ), '{"users":["Alice"]}\n');
});

test('rejects paths that escape the configured root', async (t) => {
  const { root, outside, config } = await setup(t);
  await symlink(outside, join(root, 'outside-link.json'));
  await writeFile(join(root, 'directory'), '');

  await assert.rejects(resolveSource({ type: 'file', path: '../outside.json' }, config), expectsCode('PATH_NOT_ALLOWED'));
  await assert.rejects(resolveSource({ type: 'file', path: outside }, config), expectsCode('PATH_NOT_ALLOWED'));
  await assert.rejects(resolveSource({ type: 'file', path: 'outside-link.json' }, config), expectsCode('PATH_NOT_ALLOWED'));
});

test('rejects final-component symlinks even when they remain below the root', async (t) => {
  const { root, config } = await setup(t);
  await symlink(join(root, 'users.json'), join(root, 'users-link.json'));

  await assert.rejects(
    resolveSource({ type: 'file', path: 'users-link.json' }, config),
    expectsCode('PATH_NOT_ALLOWED')
  );
});

test('rejects a checked file replaced by an outside symlink before open', async (t) => {
  const { root, outside, config } = await setup(t);
  const candidate = join(root, 'users.json');
  const replacingFileSystem: ResolverFileSystem = {
    realpath,
    open: async (path, flags) => {
      await rm(candidate);
      await symlink(outside, candidate);
      return open(path, flags);
    }
  };

  await assert.rejects(
    resolveWithFileSystem({ type: 'file', path: 'users.json' }, config, replacingFileSystem),
    expectsCode('PATH_NOT_ALLOWED')
  );
});

test('maps missing files and non-file sources to safe errors', async (t) => {
  const { root, config } = await setup(t);
  const directory = join(root, 'directory');
  await mkdir(directory);

  await assert.rejects(resolveSource({ type: 'file', path: 'missing.json' }, config), expectsCode('FILE_NOT_FOUND'));
  await assert.rejects(resolveSource({ type: 'file', path: 'directory' }, config), expectsCode('PATH_NOT_ALLOWED'));
});

test('enforces input byte limits for inline and file input', async (t) => {
  const { root, config } = await setup(t);
  const limitedConfig = { ...config, limits: { ...config.limits, inputLimitBytes: 10 } };
  await writeFile(join(root, 'large.json'), '12345678901');

  await assert.rejects(
    resolveSource({ type: 'inline', data: { value: '12345' } }, limitedConfig),
    expectsCode('INPUT_TOO_LARGE')
  );
  await assert.rejects(resolveSource({ type: 'file', path: 'large.json' }, limitedConfig), expectsCode('INPUT_TOO_LARGE'));
});

test('bounds the handle read when a file grows after stat and closes the handle', async (t) => {
  const { root, config } = await setup(t);
  const candidate = join(root, 'growing.json');
  const limitedConfig = { ...config, limits: { ...config.limits, inputLimitBytes: 10 } };
  await writeFile(candidate, '1234567890');
  let readBufferBytes: number | undefined;
  let handleClosed = false;
  const growingFileSystem: ResolverFileSystem = {
    realpath,
    open: async (path, flags) => {
      const handle = await open(path, flags);
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'stat') {
            return async () => {
              const stats = await target.stat();
              await appendFile(candidate, '1');
              return stats;
            };
          }
          if (property === 'read') {
            return async (buffer: Buffer, offset: number, length: number, position: number) => {
              readBufferBytes = buffer.byteLength;
              return target.read(buffer, offset, length, position);
            };
          }
          if (property === 'close') {
            return async () => {
              handleClosed = true;
              await target.close();
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
    }
  };

  await assert.rejects(
    resolveWithFileSystem({ type: 'file', path: 'growing.json' }, limitedConfig, growingFileSystem),
    expectsCode('INPUT_TOO_LARGE')
  );
  assert.equal(readBufferBytes, 11);
  assert.equal(handleClosed, true);
});
