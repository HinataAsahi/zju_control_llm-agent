import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelTurnClient, ModelTurnRequest, ModelUsage } from '../../src/agent/model-client.js';
import { createApprovalRecord } from '../../src/generation/approval.js';
import { collectCliEvidence } from '../../src/generation/collector.js';
import {
  extractCliIr,
  generateSkillDraft,
  GenerationStageOutputError,
  parseSkillDraft,
  proposeToolProfile
} from '../../src/generation/generator.js';
import { artifactHash } from '../../src/generation/hash.js';
import { parseToolProfile } from '../../src/generation/profile.js';
import { parseCliIr } from '../../src/generation/schema.js';

const usage: ModelUsage = {
  inputTokens: 100,
  cachedInputTokens: 20,
  outputTokens: 30,
  reasoningOutputTokens: 0,
  totalTokens: 130
};

async function fixture() {
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
  const irValue = {
    schemaVersion: 1,
    cliName: 'jq',
    version: '1.8.2',
    evidenceHash: evidence.evidenceHash,
    summary: 'Process JSON input with filters.',
    usageForms: [{
      text: 'jq [options] <jq filter>',
      evidence: [{ sourceId: 'help', startLine: 1, endLine: 1 }]
    }],
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
        id: 'end-options', names: ['--'], takesValue: false,
        valueName: null, inferredType: 'boolean', repeatable: 'no',
        description: 'Terminate option processing.', confidence: 'high', uncertainty: null,
        constraints: [], evidence: [{ sourceId: 'help', startLine: 3, endLine: 3 }]
      }
    ]
  };
  const ir = parseCliIr(irValue, evidence);
  const profileValue = {
    schemaVersion: 1,
    cliName: 'jq',
    irHash: artifactHash(ir),
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
  const profile = parseToolProfile(profileValue, ir);
  return { evidence, irValue, ir, profileValue, profile };
}

function clientReturning(finalText: string, requests: ModelTurnRequest[]): ModelTurnClient {
  return {
    async createTurn(request) {
      requests.push(request);
      return {
        historyItems: [{ type: 'message', role: 'assistant', content: finalText }],
        functionCalls: [], finalText, usage
      };
    }
  };
}

test('extracts CLI IR in one request with numbered immutable evidence', async () => {
  const { evidence, irValue } = await fixture();
  const requests: ModelTurnRequest[] = [];
  const result = await extractCliIr({ evidence, client: clientReturning(JSON.stringify(irValue), requests) });

  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0]?.tools, []);
  assert.match(requests[0]?.history[0]?.type === 'message' ? requests[0].history[0].content : '', /L1: Usage/);
  assert.equal(result.artifact.options.length, 2);
  assert.deepEqual(result.usage, usage);
  assert.match(result.promptHash, /^[a-f0-9]{64}$/);
});

test('does not retry malformed model JSON', async () => {
  const { evidence } = await fixture();
  const requests: ModelTurnRequest[] = [];

  await assert.rejects(
    extractCliIr({ evidence, client: clientReturning('```json\n{}\n```', requests) }),
    (error: unknown) => error instanceof GenerationStageOutputError
      && error.message === 'Generation stage returned invalid JSON.'
      && error.rawOutput.startsWith('```json')
      && error.usage.totalTokens === 130
  );
  assert.equal(requests.length, 1);
});

test('proposes and validates a complete ToolProfile in one request', async () => {
  const { ir, profileValue } = await fixture();
  const requests: ModelTurnRequest[] = [];
  const result = await proposeToolProfile({ ir, client: clientReturning(JSON.stringify(profileValue), requests) });

  assert.equal(requests.length, 1);
  assert.equal(result.artifact.tool.name, 'jq_query_generated');
  assert.equal(result.artifact.capabilityDecisions.length, 3);
});

test('requires a valid approval before generating a bounded Skill draft', async () => {
  const { evidence, ir, profile } = await fixture();
  const requests: ModelTurnRequest[] = [];
  const client = clientReturning(JSON.stringify({
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
  }), requests);

  await assert.rejects(
    generateSkillDraft({ evidence, ir, profile, approval: {}, client }),
    /A matching approval is required before Skill generation/
  );
  assert.equal(requests.length, 0);

  const approval = createApprovalRecord({ evidence, ir, profile });
  const result = await generateSkillDraft({ evidence, ir, profile, approval, client });
  assert.equal(requests.length, 1);
  assert.match(result.artifact.skillMarkdown, /jq_query_generated/);
  assert.throws(
    () => parseSkillDraft({ ...result.artifact, profileHash: '0'.repeat(64) }, profile),
    /Skill profileHash does not match the approved profile/
  );
});
