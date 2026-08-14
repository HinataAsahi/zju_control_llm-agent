import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ModelTurnClient, ModelTurnRequest, ModelUsage } from '../../src/agent/model-client.js';
import { collectCliEvidence } from '../../src/generation/collector.js';
import { artifactHash } from '../../src/generation/hash.js';
import { runGenerationCommand } from '../../src/generation/main.js';
import { generationArtifactPath, readGenerationJson } from '../../src/generation/storage.js';

const usage: ModelUsage = {
  inputTokens: 10, cachedInputTokens: 2, outputTokens: 5,
  reasoningOutputTokens: 0, totalTokens: 15
};

test('runs the staged jq pipeline through review, approval, Skill, and verification', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'generation-main-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = await collectCliEvidence({
    cliName: 'jq', executable: 'jq', collectedAt: new Date('2026-08-14T00:00:00.000Z'),
    runCommand: async (_executable, args) => args[0] === '--version'
      ? { stdout: 'jq-1.8.2\n', stderr: '', exitCode: 0 }
      : {
        stdout: [
          'Usage: jq [options] <jq filter>',
          '  -c, --compact-output  compact output;',
          '  --                      terminates argument processing;'
        ].join('\n'),
        stderr: '', exitCode: 0
      }
  });
  const ir = {
    schemaVersion: 1,
    cliName: 'jq', version: '1.8.2', evidenceHash: evidence.evidenceHash,
    summary: 'Process JSON input with filters.',
    usageForms: [{ text: 'jq [options] <jq filter>', evidence: [{ sourceId: 'help', startLine: 1, endLine: 1 }] }],
    positionals: [{
      id: 'filter', name: 'jq filter', cardinality: 'one', inferredType: 'string',
      confidence: 'high', uncertainty: null,
      evidence: [{ sourceId: 'help', startLine: 1, endLine: 1 }]
    }],
    options: [
      {
        id: 'compact-output', names: ['-c', '--compact-output'], takesValue: false,
        valueName: null, inferredType: 'boolean', repeatable: 'unknown',
        description: 'Compact output.', confidence: 'high', uncertainty: null,
        constraints: [], evidence: [{ sourceId: 'help', startLine: 2, endLine: 2 }]
      },
      {
        id: 'end-options', names: ['--'], takesValue: false, valueName: null,
        inferredType: 'boolean', repeatable: 'no', description: 'End options.',
        confidence: 'high', uncertainty: null, constraints: [],
        evidence: [{ sourceId: 'help', startLine: 3, endLine: 3 }]
      }
    ]
  };
  const profile = {
    schemaVersion: 1,
    cliName: 'jq', irHash: artifactHash(ir),
    tool: { name: 'jq_query_generated', description: 'Run a bounded jq query.' },
    capabilityDecisions: [
      { kind: 'positional', capabilityId: 'filter', disposition: 'allow', risk: 'medium', reason: 'Core query.' },
      { kind: 'option', capabilityId: 'compact-output', disposition: 'allow', risk: 'low', reason: 'Parseable output.' },
      { kind: 'option', capabilityId: 'end-options', disposition: 'allow', risk: 'low', reason: 'Safe argv boundary.' }
    ],
    inputFields: [
      { name: 'filter', description: 'jq filter.', required: true, shape: { type: 'string', minLength: 1, maxUtf8Bytes: 4096 } },
      { name: 'source', description: 'JSON source.', required: true, shape: { type: 'json-source', allowInline: true, allowFile: true } }
    ],
    bindings: {
      fixedOptions: ['compact-output'], endOfOptionsCapabilityId: 'end-options',
      argv: [{ field: 'filter', capabilityId: 'filter', position: 0 }],
      stdin: { field: 'source', encoding: 'json' }
    },
    output: { type: 'json-lines' },
    limits: { timeoutMs: 5000, inputBytes: 1048576, outputBytes: 1048576 }
  };
  const skill = {
    schemaVersion: 1,
    profileHash: artifactHash(profile),
    skillMarkdown: [
      '---',
      'name: jq-query-generated',
      'description: Use jq_query_generated for deterministic JSON queries.',
      '---',
      '',
      '# jq Query Generated',
      '',
      'Call `jq_query_generated` only for available JSON input.'
    ].join('\n')
  };
  const responses = [JSON.stringify(ir), JSON.stringify(profile), JSON.stringify(skill)];
  const requests: ModelTurnRequest[] = [];
  const client: ModelTurnClient = {
    async createTurn(request) {
      requests.push(request);
      const finalText = responses.shift();
      assert.ok(finalText);
      return {
        historyItems: [{ type: 'message', role: 'assistant', content: finalText }],
        functionCalls: [], finalText, usage
      };
    }
  };
  let keyReads = 0;
  const options = {
    repositoryRoot: root,
    collectEvidence: async () => evidence,
    loadApiKey: async () => { keyReads += 1; return 'private-key'; },
    createClient: (_key: string) => client,
    now: () => new Date('2026-08-14T01:00:00.000Z')
  };

  await runGenerationCommand(['collect'], options);
  await runGenerationCommand(['extract'], options);
  await runGenerationCommand(['propose'], options);
  const review = await runGenerationCommand(['review'], options);
  assert.equal(keyReads, 2);
  assert.equal(requests.length, 2);
  assert.equal(review.command, 'review');
  assert.match(await readFile(generationArtifactPath(root, 'review.md'), 'utf8'), /MCP 生成审阅报告/);

  await runGenerationCommand(['approve'], options);
  await runGenerationCommand(['materialize'], options);
  await runGenerationCommand(['skill'], options);
  const verification = await runGenerationCommand(['verify'], options);

  assert.equal(keyReads, 3);
  assert.equal(requests.length, 3);
  assert.equal(verification.status, 'verified');
  assert.deepEqual(
    (await readGenerationJson(root, 'verification.json') as { checks: unknown[] }).checks.length,
    2
  );
});

test('rejects unknown commands before reading credentials', async () => {
  let keyRead = false;
  await assert.rejects(runGenerationCommand(['unknown'], {
    repositoryRoot: process.cwd(),
    loadApiKey: async () => { keyRead = true; return 'key'; }
  }), /Expected one generation command/);
  assert.equal(keyRead, false);
});
