import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectCliEvidence,
  parseCliEvidence,
  type CommandResult
} from '../../src/generation/collector.js';

test('collects only version and help with bounded fixed commands', async () => {
  const calls: { executable: string; args: readonly string[] }[] = [];
  const results: CommandResult[] = [
    { stdout: 'jq-1.8.2\n', stderr: '', exitCode: 0 },
    { stdout: 'jq help\n', stderr: '', exitCode: 0 }
  ];

  const evidence = await collectCliEvidence({
    cliName: 'jq',
    executable: '/usr/bin/jq',
    collectedAt: new Date('2026-08-14T00:00:00.000Z'),
    runCommand: async (executable, args) => {
      calls.push({ executable, args });
      const result = results.shift();
      assert.ok(result);
      return result;
    }
  });

  assert.deepEqual(calls, [
    { executable: '/usr/bin/jq', args: ['--version'] },
    { executable: '/usr/bin/jq', args: ['--help'] }
  ]);
  assert.equal(evidence.schemaVersion, 1);
  assert.equal(evidence.cli.name, 'jq');
  assert.equal(evidence.cli.version, '1.8.2');
  assert.equal(evidence.collectedAt, '2026-08-14T00:00:00.000Z');
  assert.deepEqual(evidence.sources.map(source => source.id), ['version', 'help']);
  assert.match(evidence.sources[1]?.sha256 ?? '', /^[a-f0-9]{64}$/);
  assert.match(evidence.evidenceHash, /^[a-f0-9]{64}$/);
});

test('rejects a failed evidence command with bounded diagnostics', async () => {
  await assert.rejects(
    collectCliEvidence({
      cliName: 'jq',
      executable: 'jq',
      runCommand: async (_executable, args) => args[0] === '--version'
        ? { stdout: 'jq-1.8.2\n', stderr: '', exitCode: 0 }
        : { stdout: '', stderr: 'private path /tmp/example', exitCode: 2 }
    }),
    /Unable to collect jq help: command exited with code 2\./
  );
});

test('rejects version output that does not identify the requested CLI', async () => {
  await assert.rejects(
    collectCliEvidence({
      cliName: 'jq',
      executable: 'jq',
      runCommand: async (_executable, args) => args[0] === '--version'
        ? { stdout: 'not-jq latest\n', stderr: '', exitCode: 0 }
        : { stdout: 'help\n', stderr: '', exitCode: 0 }
    }),
    /Unable to identify jq version\./
  );
});

test('rejects tampered persisted evidence', async () => {
  const evidence = await collectCliEvidence({
    cliName: 'jq', executable: 'jq',
    runCommand: async (_executable, args) => args[0] === '--version'
      ? { stdout: 'jq-1.8.2\n', stderr: '', exitCode: 0 }
      : { stdout: 'help\n', stderr: '', exitCode: 0 }
  });
  const tampered = JSON.parse(JSON.stringify(evidence)) as Record<string, unknown>;
  const sources = tampered.sources as Record<string, unknown>[];
  sources[1]!.stdout = 'changed help\n';

  assert.throws(() => parseCliEvidence(tampered), /Evidence source help hash does not match its content/);
});
