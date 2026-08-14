import assert from 'node:assert/strict';
import test from 'node:test';
import { collectCliEvidence } from '../../src/generation/collector.js';
import { artifactHash } from '../../src/generation/hash.js';
import { createApprovalRecord, verifyApprovalRecord } from '../../src/generation/approval.js';
import { materializeToolBundle } from '../../src/generation/materializer.js';
import { parseToolProfile } from '../../src/generation/profile.js';
import { renderProfileReview } from '../../src/generation/review.js';
import { parseCliIr } from '../../src/generation/schema.js';

async function fixture() {
  const evidence = await collectCliEvidence({
    cliName: 'jq',
    executable: 'jq',
    collectedAt: new Date('2026-08-14T00:00:00.000Z'),
    runCommand: async (_executable, args) => args[0] === '--version'
      ? { stdout: 'jq-1.8.2\n', stderr: '', exitCode: 0 }
      : {
        stdout: [
          'Usage: jq [options] <jq filter> [file...]',
          '  -n, --null-input      use null as input;',
          '  -c, --compact-output  compact output;',
          '  --                      terminates argument processing;'
        ].join('\n'),
        stderr: '',
        exitCode: 0
      }
  });
  const ir = parseCliIr({
    schemaVersion: 1,
    cliName: 'jq',
    version: '1.8.2',
    evidenceHash: evidence.evidenceHash,
    summary: 'Process JSON input with filters.',
    usageForms: [{
      text: 'jq [options] <jq filter> [file...]',
      evidence: [{ sourceId: 'help', startLine: 1, endLine: 1 }]
    }],
    positionals: [{
      id: 'filter', name: 'jq filter', cardinality: 'one', inferredType: 'string',
      confidence: 'high', uncertainty: null,
      evidence: [{ sourceId: 'help', startLine: 1, endLine: 1 }]
    }],
    options: [
      {
        id: 'null-input', names: ['-n', '--null-input'], takesValue: false,
        valueName: null, inferredType: 'boolean', repeatable: 'unknown',
        description: 'Use null as input.', confidence: 'high', uncertainty: null,
        constraints: [], evidence: [{ sourceId: 'help', startLine: 2, endLine: 2 }]
      },
      {
        id: 'compact-output', names: ['-c', '--compact-output'], takesValue: false,
        valueName: null, inferredType: 'boolean', repeatable: 'unknown',
        description: 'Compact output.', confidence: 'high', uncertainty: null,
        constraints: [], evidence: [{ sourceId: 'help', startLine: 3, endLine: 3 }]
      },
      {
        id: 'end-options', names: ['--'], takesValue: false,
        valueName: null, inferredType: 'boolean', repeatable: 'no',
        description: 'Terminate argument processing.', confidence: 'high', uncertainty: null,
        constraints: [], evidence: [{ sourceId: 'help', startLine: 4, endLine: 4 }]
      }
    ]
  }, evidence);
  return { evidence, ir };
}

function validProfile(irHash: string) {
  return {
    schemaVersion: 1,
    cliName: 'jq',
    irHash,
    tool: {
      name: 'jq_query_generated',
      description: 'Run an approved jq filter against bounded JSON input.'
    },
    capabilityDecisions: [
      {
        kind: 'positional', capabilityId: 'filter', disposition: 'allow', risk: 'medium',
        reason: 'The filter is the core query expression.'
      },
      {
        kind: 'option', capabilityId: 'null-input', disposition: 'deny', risk: 'low',
        reason: 'The wrapper always supplies JSON input.'
      },
      {
        kind: 'option', capabilityId: 'compact-output', disposition: 'allow', risk: 'low',
        reason: 'Compact JSON lines are deterministic to parse.'
      },
      {
        kind: 'option', capabilityId: 'end-options', disposition: 'allow', risk: 'low',
        reason: 'It prevents filters beginning with a dash from becoming options.'
      }
    ],
    inputFields: [
      {
        name: 'filter', description: 'jq filter to execute.', required: true,
        shape: { type: 'string', minLength: 1, maxUtf8Bytes: 4096 }
      },
      {
        name: 'source', description: 'Inline JSON or an allowed JSON file.', required: true,
        shape: { type: 'json-source', allowInline: true, allowFile: true }
      }
    ],
    bindings: {
      fixedOptions: ['compact-output'],
      endOfOptionsCapabilityId: 'end-options',
      argv: [{ field: 'filter', capabilityId: 'filter', position: 0 }],
      stdin: { field: 'source', encoding: 'json' }
    },
    output: { type: 'json-lines' },
    limits: { timeoutMs: 5000, inputBytes: 1048576, outputBytes: 1048576 }
  };
}

test('requires an explicit decision for every CLI capability', async () => {
  const { ir } = await fixture();
  const incomplete = validProfile(artifactHash(ir));
  incomplete.capabilityDecisions.pop();

  assert.throws(
    () => parseToolProfile(incomplete, ir),
    /Missing decision for option end-options/
  );
});

test('rejects denied capabilities and unknown fields in execution bindings', async () => {
  const { ir } = await fixture();
  const denied = validProfile(artifactHash(ir));
  denied.capabilityDecisions[2]!.disposition = 'deny';
  assert.throws(
    () => parseToolProfile(denied, ir),
    /Fixed option compact-output is not allowed/
  );

  const arbitraryCommand = {
    ...validProfile(artifactHash(ir)),
    bindings: { ...validProfile(artifactHash(ir)).bindings, shellCommand: 'jq "$FILTER"' }
  };
  assert.throws(() => parseToolProfile(arbitraryCommand, ir), /Unrecognized key/);
});

test('rejects duplicate bindings and exposed fields that execution would ignore', async () => {
  const { ir } = await fixture();
  const duplicateOption = validProfile(artifactHash(ir));
  duplicateOption.bindings.fixedOptions.push('compact-output');
  assert.throws(() => parseToolProfile(duplicateOption, ir), /Fixed option compact-output is duplicated/);

  const ignoredField = validProfile(artifactHash(ir));
  ignoredField.inputFields.push({
    name: 'ignored', description: 'Would never reach the CLI.', required: true,
    shape: { type: 'string', minLength: 1, maxUtf8Bytes: 32 }
  });
  assert.throws(() => parseToolProfile(ignoredField, ir), /Input field ignored has no execution binding/);
});

test('materializes a deterministic schema and declarative execution spec', async () => {
  const { ir } = await fixture();
  const profile = parseToolProfile(validProfile(artifactHash(ir)), ir);
  const first = materializeToolBundle(ir, profile);
  const second = materializeToolBundle(ir, profile);

  assert.deepEqual(first, second);
  assert.deepEqual(first.inputSchema.required, ['filter', 'source']);
  assert.equal(first.inputSchema.additionalProperties, false);
  assert.deepEqual(first.execution.fixedArgv, ['--compact-output', '--']);
  assert.equal(first.execution.executable, undefined);
  assert.equal(first.execution.shell, false);
});

test('binds approval to evidence, IR, and profile hashes', async () => {
  const { evidence, ir } = await fixture();
  const profile = parseToolProfile(validProfile(artifactHash(ir)), ir);
  const approval = createApprovalRecord({
    evidence,
    ir,
    profile,
    approvedAt: new Date('2026-08-14T01:00:00.000Z')
  });

  assert.equal(verifyApprovalRecord(approval, evidence, ir, profile), true);
  assert.equal(verifyApprovalRecord(
    approval,
    evidence,
    ir,
    { ...profile, tool: { ...profile.tool, description: 'Changed.' } }
  ), false);
});

test('renders evidence and profile decisions into a readable review report', async () => {
  const { evidence, ir } = await fixture();
  const profile = parseToolProfile(validProfile(artifactHash(ir)), ir);
  const report = renderProfileReview(evidence, ir, profile);

  assert.match(report, /# jq MCP 生成审阅报告/);
  assert.match(report, /`--compact-output`/);
  assert.match(report, /允许/);
  assert.match(report, /帮助文本第 3 行/);
  assert.match(report, /compact output/);
  assert.match(report, /jq_query_generated/);
});
