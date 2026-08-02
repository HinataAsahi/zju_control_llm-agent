import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

async function withClient(
  t: test.TestContext,
  run: (client: Client) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'jq-mcp-server-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'users.json'), '{"users":["Alice","Bob"]}\n');

  const client = new Client(
    { name: 'jq-mcp-test-client', version: '1.0.0' },
    { versionNegotiation: { mode: 'legacy' } }
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('dist/src/server.js'), '--root', root]
  });

  try {
    await client.connect(transport);
    await run(client);
  } finally {
    await client.close();
  }
}

async function runProcess(args: string[]): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}> {
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8')
      });
    });
  });
}

test('runs startup validation through a symlinked entrypoint', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'jq-mcp-server-link-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entrypoint = join(directory, 'server-link.js');
  await symlink(resolve('dist/src/server.js'), entrypoint);

  const result = await runProcess([entrypoint]);

  assert.equal(result.code, 1);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'Expected --root <path>.\n');
});

test('advertises exactly the jq_query tool', async (t) => {
  await withClient(t, async (client) => {
    const result = await client.listTools();
    assert.deepEqual(result.tools.map(tool => tool.name), ['jq_query']);
  });
});

test('advertises the discriminated jq input schema', async (t) => {
  await withClient(t, async (client) => {
    const result = await client.listTools();
    const schema = JSON.stringify(result.tools[0]?.inputSchema);
    assert.match(schema, /inline/);
    assert.match(schema, /file/);
    assert.match(schema, /oneOf|anyOf/);
  });
});

test('runs jq for inline JSON through MCP stdio', async (t) => {
  await withClient(t, async (client) => {
    const result = await client.callTool({
      name: 'jq_query',
      arguments: {
        filter: '.users | length',
        source: { type: 'inline', data: { users: ['Alice', 'Bob'] } }
      }
    });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, { ok: true, values: [2], exitCode: 0 });
  });
});

test('runs jq for allowed file JSON through MCP stdio', async (t) => {
  await withClient(t, async (client) => {
    const result = await client.callTool({
      name: 'jq_query',
      arguments: {
        filter: '.users[0]',
        source: { type: 'file', path: 'users.json' }
      }
    });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, { ok: true, values: ['Alice'], exitCode: 0 });
  });
});

test('rejects malformed jq input through SDK validation', async (t) => {
  await withClient(t, async (client) => {
    const result = await client.callTool({
      name: 'jq_query',
      arguments: {
        filter: '.',
        source: { type: 'file', data: {} }
      }
    });
    assert.equal(result.isError, true);
  });
});

test('returns PATH_NOT_ALLOWED for traversal file input', async (t) => {
  await withClient(t, async (client) => {
    const result = await client.callTool({
      name: 'jq_query',
      arguments: {
        filter: '.',
        source: { type: 'file', path: '../outside.json' }
      }
    });
    assert.equal(result.isError, true);
    assert.deepEqual(result.structuredContent, {
      ok: false,
      error: { code: 'PATH_NOT_ALLOWED', message: 'Path not allowed: ../outside.json' },
      exitCode: null
    });
  });
});
