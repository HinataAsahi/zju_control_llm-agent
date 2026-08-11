import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  writeStage2bRecord,
  type Stage2bRecord
} from '../../src/experiment/stage2b-record.js';

function record(runId = 'stage2b-T1-explicit-test'): Stage2bRecord {
  return {
    version: 1,
    runId,
    startedAt: '2026-08-10T00:00:00.000Z',
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    thinking: 'none',
    taskId: 'T1',
    condition: 'explicit',
    status: 'completed',
    taskSuccess: true,
    limits: {
      maxTurns: 5,
      maxToolCalls: 4,
      requestTimeoutMs: 60_000,
      totalTimeoutMs: 120_000
    },
    turns: 2,
    toolCalls: 1,
    toolEvents: [{
      type: 'function_call',
      callId: 'call-1',
      name: 'jq_query',
      arguments: '{"filter":"length"}'
    }, {
      type: 'function_call_output',
      callId: 'call-1',
      output: '{"ok":true,"values":[3]}'
    }],
    finalAnswer: { status: 'completed', answer: 3, explanation: 'Counted values.' },
    usage: {
      inputTokens: 10,
      cachedInputTokens: 2,
      outputTokens: 4,
      reasoningOutputTokens: 0,
      totalTokens: 14
    },
    durationMs: 100
  };
}

test('writes a local record atomically with restrictive permissions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'stage2b-record-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const path = await writeStage2bRecord(root, record());

  assert.equal(path, join(root, '.experiment-runs/stage-2b/stage2b-T1-explicit-test/record.json'));
  assert.equal((await lstat(join(root, '.experiment-runs'))).mode & 0o777, 0o700);
  assert.equal((await lstat(join(root, '.experiment-runs/stage-2b'))).mode & 0o777, 0o700);
  assert.equal((await lstat(join(root, '.experiment-runs/stage-2b/stage2b-T1-explicit-test'))).mode & 0o777, 0o700);
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), record());
  assert.deepEqual(await readdir(join(root, '.experiment-runs/stage-2b/stage2b-T1-explicit-test')), ['record.json']);
});

test('accepts every Stage 2B representative task ID', async t => {
  const root = await mkdtemp(join(tmpdir(), 'stage2b-record-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  for (const taskId of ['T1', 'T2', 'T6', 'T7'] as const) {
    const value: Stage2bRecord = {
      ...record(`stage2b-${taskId}-explicit-test`),
      taskId
    };
    const path = await writeStage2bRecord(root, value);
    assert.equal((JSON.parse(await readFile(path, 'utf8')) as Stage2bRecord).taskId, taskId);
  }
});

test('atomically replaces the same record without leaving temporary files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'stage2b-record-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeStage2bRecord(root, record());
  const replacement = { ...record(), durationMs: 200 };

  const path = await writeStage2bRecord(root, replacement);

  assert.equal((JSON.parse(await readFile(path, 'utf8')) as Stage2bRecord).durationMs, 200);
  assert.deepEqual(await readdir(join(root, '.experiment-runs/stage-2b/stage2b-T1-explicit-test')), ['record.json']);
});

test('rejects unsafe run IDs and sensitive record content', async t => {
  const root = await mkdtemp(join(tmpdir(), 'stage2b-record-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(writeStage2bRecord(root, record('../escape')), /run ID/i);
  await assert.rejects(writeStage2bRecord(root, {
    ...record(),
    toolEvents: [{
      type: 'function_call_output',
      callId: 'call-1',
      output: 'Authorization: Bearer sk-secretvalue123'
    }]
  }), /sensitive/i);
  await assert.rejects(writeStage2bRecord(root, {
    ...record(),
    toolEvents: [{
      type: 'function_call_output',
      callId: 'call-1',
      output: '/home/example/private.json'
    }]
  }), /absolute path/i);
});
