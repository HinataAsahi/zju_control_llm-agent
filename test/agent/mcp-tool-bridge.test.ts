import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { McpToolBridge } from '../../src/agent/mcp-tool-bridge.js';

async function withBridge(
  t: test.TestContext,
  run: (bridge: McpToolBridge, root: string) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'agent-mcp-bridge-'));
  await writeFile(join(root, 'users.json'), '{"users":["Alice","Bob","Chen"]}\n');
  const bridge = await McpToolBridge.connect({
    serverEntrypoint: resolve('dist/src/mcp/server.js'),
    root
  });
  t.after(async () => {
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  });
  await run(bridge, root);
}

test('discovers jq_query and preserves its JSON input schema', async t => {
  await withBridge(t, async bridge => {
    const tools = await bridge.listTools(new AbortController().signal);

    assert.deepEqual(tools.map(tool => tool.name), ['jq_query']);
    assert.match(tools[0]?.description ?? '', /jq/i);
    assert.match(JSON.stringify(tools[0]?.parameters), /inline/);
    assert.match(JSON.stringify(tools[0]?.parameters), /file/);
  });
});

test('calls jq through MCP and serializes structured content', async t => {
  await withBridge(t, async bridge => {
    const output = await bridge.callTool('jq_query', {
      filter: '.users | length',
      source: { type: 'file', path: 'users.json' }
    }, new AbortController().signal);

    assert.deepEqual(JSON.parse(output), { ok: true, values: [3], exitCode: 0 });
  });
});

test('keeps jq domain failures as model-visible tool output', async t => {
  await withBridge(t, async bridge => {
    const output = await bridge.callTool('jq_query', {
      filter: 'if',
      source: { type: 'file', path: 'users.json' }
    }, new AbortController().signal);
    const parsed = JSON.parse(output) as { ok: boolean; error: { code: string } };

    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.code, 'JQ_SYNTAX_ERROR');
  });
});

test('rejects a missing server entrypoint before spawning', async () => {
  await assert.rejects(
    McpToolBridge.connect({
      serverEntrypoint: resolve('dist/src/mcp/missing-server.js'),
      root: resolve('.')
    }),
    /entrypoint/i
  );
});

test('close is idempotent', async t => {
  await withBridge(t, async bridge => {
    await bridge.close();
    await bridge.close();
  });
});
