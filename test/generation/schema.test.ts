import assert from 'node:assert/strict';
import test from 'node:test';
import { collectCliEvidence } from '../../src/generation/collector.js';
import { parseCliIr } from '../../src/generation/schema.js';

async function evidence() {
  return collectCliEvidence({
    cliName: 'jq',
    executable: 'jq',
    collectedAt: new Date('2026-08-14T00:00:00.000Z'),
    runCommand: async (_executable, args) => args[0] === '--version'
      ? { stdout: 'jq-1.8.2\n', stderr: '', exitCode: 0 }
      : {
        stdout: [
          'Usage: jq [options] <jq filter> [file...]',
          '  -n, --null-input  use null as input;',
          '      --indent n    use n spaces (max 7 spaces);'
        ].join('\n'),
        stderr: '',
        exitCode: 0
      }
  });
}

function validIr(evidenceHash: string) {
  return {
    schemaVersion: 1,
    cliName: 'jq',
    version: '1.8.2',
    evidenceHash,
    summary: 'Process JSON input with filters.',
    usageForms: [{
      text: 'jq [options] <jq filter> [file...]',
      evidence: [{ sourceId: 'help', startLine: 1, endLine: 1 }]
    }],
    positionals: [{
      id: 'filter',
      name: 'jq filter',
      cardinality: 'one',
      inferredType: 'string',
      confidence: 'high',
      uncertainty: null,
      evidence: [{ sourceId: 'help', startLine: 1, endLine: 1 }]
    }],
    options: [{
      id: 'null-input',
      names: ['-n', '--null-input'],
      takesValue: false,
      valueName: null,
      inferredType: 'boolean',
      repeatable: 'unknown',
      description: 'Use null as input.',
      confidence: 'high',
      uncertainty: null,
      constraints: [],
      evidence: [{ sourceId: 'help', startLine: 2, endLine: 2 }]
    }]
  };
}

test('accepts a strict CLI IR whose claims reference frozen evidence lines', async () => {
  const source = await evidence();
  const parsed = parseCliIr(validIr(source.evidenceHash), source);

  assert.equal(parsed.options[0]?.names[1], '--null-input');
  assert.equal(parsed.evidenceHash, source.evidenceHash);
});

test('rejects fabricated evidence ranges and changed evidence hashes', async () => {
  const source = await evidence();
  const invalidRange = validIr(source.evidenceHash);
  invalidRange.options[0]!.evidence[0]!.startLine = 20;
  invalidRange.options[0]!.evidence[0]!.endLine = 20;

  assert.throws(() => parseCliIr(invalidRange, source), /Evidence line range is outside source help/);
  assert.throws(
    () => parseCliIr(validIr('0'.repeat(64)), source),
    /IR evidenceHash does not match collected evidence/
  );
});

test('rejects duplicate option aliases and unknown fields', async () => {
  const source = await evidence();
  const duplicate = validIr(source.evidenceHash);
  duplicate.options.push({
    ...duplicate.options[0]!,
    id: 'other-null-input',
    names: ['--null-input']
  });
  assert.throws(() => parseCliIr(duplicate, source), /Option alias --null-input is duplicated/);

  assert.throws(
    () => parseCliIr({ ...validIr(source.evidenceHash), invented: true }, source),
    /Unrecognized key/
  );
});

test('rejects capability ids shared by an option and positional', async () => {
  const source = await evidence();
  const duplicate = validIr(source.evidenceHash);
  duplicate.options[0]!.id = 'filter';

  assert.throws(() => parseCliIr(duplicate, source), /Capability id filter is duplicated/);
});
