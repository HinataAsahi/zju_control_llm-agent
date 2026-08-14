import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import type { GeneratedToolBundle } from '../../src/generation/materializer.js';
import { executeGeneratedTool, setGeneratedSpawnForTesting } from '../../src/generation/executor.js';

function bundle(overrides: Partial<GeneratedToolBundle['execution']['limits']> = {}): GeneratedToolBundle {
  return {
    schemaVersion: 1,
    tool: { name: 'jq_query_generated', description: 'Query JSON.' },
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', minLength: 1, maxLength: 4096 },
        source: {
          oneOf: [
            {
              type: 'object', properties: { type: { const: 'inline' }, data: {} },
              required: ['type', 'data'], additionalProperties: false
            },
            {
              type: 'object', properties: { type: { const: 'file' }, path: { type: 'string', minLength: 1 } },
              required: ['type', 'path'], additionalProperties: false
            }
          ]
        }
      },
      required: ['filter', 'source'],
      additionalProperties: false
    },
    execution: {
      schemaVersion: 1,
      cliName: 'jq',
      cliVersion: '1.8.2',
      irHash: '1'.repeat(64),
      profileHash: '2'.repeat(64),
      shell: false,
      fixedArgv: ['--compact-output', '--'],
      argv: [{ field: 'filter', capabilityId: 'filter', position: 0 }],
      stdin: { field: 'source', encoding: 'json' },
      output: { type: 'json-lines' },
      limits: { timeoutMs: 5000, inputBytes: 1024 * 1024, outputBytes: 1024 * 1024, ...overrides }
    }
  };
}

test('executes an approved inline JSON binding through jq', async () => {
  const result = await executeGeneratedTool({
    bundle: bundle(),
    executable: 'jq',
    root: process.cwd(),
    input: { filter: '.users | length', source: { type: 'inline', data: { users: [1, 2, 3] } } }
  });

  assert.deepEqual(result, { ok: true, values: [3], exitCode: 0 });
});

test('uses exact declarative argv, shell false, and a narrow environment', async (t) => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: () => true
  }) as unknown as ChildProcessWithoutNullStreams & {
    stdin: PassThrough; stdout: PassThrough; stderr: PassThrough
  };
  let invocation: { executable: string; args: readonly string[]; options: Parameters<typeof spawn>[2] } | undefined;
  t.after(setGeneratedSpawnForTesting((executable, args, options) => {
    invocation = { executable, args, options };
    return child;
  }));

  const execution = executeGeneratedTool({
    bundle: bundle(), executable: '/usr/bin/jq', root: process.cwd(),
    input: { filter: '.name', source: { type: 'inline', data: { name: 'Ada' } } }
  });
  for (let attempt = 0; attempt < 20 && !invocation; attempt += 1) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.ok(invocation);
  child.stdout.end('"Ada"\n');
  child.emit('close', 0);
  assert.deepEqual(await execution, { ok: true, values: ['Ada'], exitCode: 0 });

  assert.equal(invocation.executable, '/usr/bin/jq');
  assert.deepEqual(invocation.args, ['--compact-output', '--', '.name']);
  assert.equal(invocation.options?.shell, false);
  assert.deepEqual(Object.keys(invocation.options?.env ?? {}).sort(), ['LANG', 'LC_ALL', 'PATH']);
});

test('rejects unknown input fields and oversized UTF-8 arguments before spawning', async (t) => {
  let spawned = false;
  t.after(setGeneratedSpawnForTesting(() => {
    spawned = true;
    throw new Error('must not spawn');
  }));

  assert.deepEqual(await executeGeneratedTool({
    bundle: bundle(), executable: 'jq', root: process.cwd(),
    input: { filter: '.', source: { type: 'inline', data: null }, extra: true }
  }), {
    ok: false, error: { code: 'INVALID_INPUT', message: 'Generated tool input is invalid.' }, exitCode: null
  });
  assert.deepEqual(await executeGeneratedTool({
    bundle: {
      ...bundle(),
      inputSchema: {
        ...bundle().inputSchema,
        properties: {
          ...bundle().inputSchema.properties,
          filter: { type: 'string', minLength: 1, maxLength: 4 }
        }
      }
    }, executable: 'jq', root: process.cwd(),
    input: { filter: '你好', source: { type: 'inline', data: null } }
  }), {
    ok: false, error: { code: 'INVALID_INPUT', message: 'Generated tool input is invalid.' }, exitCode: null
  });
  assert.equal(spawned, false);
});

test('enforces the generated JSON source variants before file access', async (t) => {
  let spawned = false;
  t.after(setGeneratedSpawnForTesting(() => {
    spawned = true;
    throw new Error('must not spawn');
  }));
  const inlineOnly = bundle();
  inlineOnly.inputSchema.properties.source = {
    oneOf: [{
      type: 'object', properties: { type: { const: 'inline' }, data: {} },
      required: ['type', 'data'], additionalProperties: false
    }]
  };

  assert.deepEqual(await executeGeneratedTool({
    bundle: inlineOnly, executable: 'jq', root: process.cwd(),
    input: { filter: '.', source: { type: 'file', path: 'data.json' } }
  }), {
    ok: false, error: { code: 'INVALID_INPUT', message: 'Generated tool input is invalid.' }, exitCode: null
  });
  assert.equal(spawned, false);
});

test('maps nonzero exits, timeouts, and output overflow to stable errors', async () => {
  assert.deepEqual(await executeGeneratedTool({
    bundle: bundle(), executable: 'jq', root: process.cwd(),
    input: { filter: 'if', source: { type: 'inline', data: null } }
  }), {
    ok: false, error: { code: 'CLI_EXIT', message: 'Generated CLI execution failed.' }, exitCode: 3
  });

  assert.deepEqual(await executeGeneratedTool({
    bundle: bundle({ timeoutMs: 100 }), executable: 'jq', root: process.cwd(),
    input: { filter: 'def forever: forever; forever', source: { type: 'inline', data: null } }
  }), {
    ok: false, error: { code: 'TIMEOUT', message: 'Generated CLI execution timed out.' }, exitCode: null
  });

  assert.deepEqual(await executeGeneratedTool({
    bundle: bundle({ outputBytes: 8 }), executable: 'jq', root: process.cwd(),
    input: { filter: 'range(0; 100)', source: { type: 'inline', data: null } }
  }), {
    ok: false, error: { code: 'OUTPUT_LIMIT', message: 'Generated CLI output exceeded its limit.' }, exitCode: null
  });
});
