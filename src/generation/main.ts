import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createDeepSeekModelClient } from '../agent/deepseek-client.js';
import type { ModelTurnClient } from '../agent/model-client.js';
import { createApprovalRecord, verifyApprovalRecord } from './approval.js';
import {
  collectCliEvidence,
  parseCliEvidence,
  type CliEvidence
} from './collector.js';
import { loadDeepSeekApiKey } from './credentials.js';
import { executeGeneratedTool } from './executor.js';
import {
  extractCliIr,
  generateSkillDraft,
  GenerationStageOutputError,
  parseSkillDraft,
  proposeToolProfile
} from './generator.js';
import { artifactHash } from './hash.js';
import { materializeToolBundle } from './materializer.js';
import { parseToolProfile } from './profile.js';
import { renderProfileReview } from './review.js';
import { parseCliIr } from './schema.js';
import {
  generationArtifactPath,
  readGenerationJson,
  writeGenerationJson,
  writeGenerationText
} from './storage.js';

const COMMANDS = ['collect', 'extract', 'propose', 'review', 'approve', 'materialize', 'skill', 'verify'] as const;
type GenerationCommand = typeof COMMANDS[number];

export interface GenerationCommandOptions {
  repositoryRoot: string;
  collectEvidence?: () => Promise<CliEvidence>;
  loadApiKey?: () => Promise<string>;
  createClient?: (apiKey: string) => ModelTurnClient;
  now?: () => Date;
}

export interface GenerationCommandSummary {
  command: GenerationCommand;
  status: 'collected' | 'generated' | 'review-ready' | 'approved' | 'materialized' | 'verified';
  artifact: string;
  usage?: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

type PublicUsage = NonNullable<GenerationCommandSummary['usage']>;

export async function runGenerationCommand(
  argv: readonly string[],
  options: GenerationCommandOptions
): Promise<GenerationCommandSummary> {
  const command = parseCommand(argv);
  const now = options.now ?? (() => new Date());
  const collectEvidence = options.collectEvidence ?? (() => collectCliEvidence({
    cliName: 'jq', executable: 'jq', collectedAt: now()
  }));
  const loadApiKey = options.loadApiKey ?? (() => loadDeepSeekApiKey());
  const createClient = options.createClient ?? (apiKey => createDeepSeekModelClient({ apiKey }));

  if (command === 'collect') {
    const evidence = await collectEvidence();
    const path = await writeGenerationJson(options.repositoryRoot, 'evidence.json', evidence);
    return { command, status: 'collected', artifact: path };
  }

  const evidence = parseCliEvidence(await readGenerationJson(options.repositoryRoot, 'evidence.json'));
  if (command === 'extract') {
    const client = createClient(await loadApiKey());
    const result = await runPaidStage(
      options.repositoryRoot,
      'ir-failure.json',
      now,
      () => extractCliIr({ evidence, client })
    );
    const path = await writeGenerationJson(options.repositoryRoot, 'ir.json', result.artifact);
    await writeStageMetadata(options.repositoryRoot, 'ir-stage.json', result, now());
    return { command, status: 'generated', artifact: path, usage: publicUsage(result.usage) };
  }

  const ir = parseCliIr(await readGenerationJson(options.repositoryRoot, 'ir.json'), evidence);
  if (command === 'propose') {
    const client = createClient(await loadApiKey());
    const result = await runPaidStage(
      options.repositoryRoot,
      'profile-failure.json',
      now,
      () => proposeToolProfile({ ir, client })
    );
    const path = await writeGenerationJson(options.repositoryRoot, 'profile.json', result.artifact);
    await writeStageMetadata(options.repositoryRoot, 'profile-stage.json', result, now());
    return { command, status: 'generated', artifact: path, usage: publicUsage(result.usage) };
  }

  const profile = parseToolProfile(await readGenerationJson(options.repositoryRoot, 'profile.json'), ir);
  if (command === 'review') {
    const path = await writeGenerationText(
      options.repositoryRoot,
      'review.md',
      renderProfileReview(evidence, ir, profile)
    );
    return { command, status: 'review-ready', artifact: path };
  }
  if (command === 'approve') {
    const approval = createApprovalRecord({ evidence, ir, profile, approvedAt: now() });
    const path = await writeGenerationJson(options.repositoryRoot, 'approval.json', approval);
    return { command, status: 'approved', artifact: path };
  }

  const approval = await readGenerationJson(options.repositoryRoot, 'approval.json');
  if (!verifyApprovalRecord(approval, evidence, ir, profile)) {
    throw new Error('A matching approval is required for this command.');
  }
  const bundle = materializeToolBundle(ir, profile);
  if (command === 'materialize') {
    const path = await writeGenerationJson(options.repositoryRoot, 'bundle.json', bundle);
    return { command, status: 'materialized', artifact: path };
  }
  if (command === 'skill') {
    const client = createClient(await loadApiKey());
    const result = await runPaidStage(
      options.repositoryRoot,
      'skill-failure.json',
      now,
      () => generateSkillDraft({ evidence, ir, profile, approval, client })
    );
    await writeGenerationJson(options.repositoryRoot, 'skill.json', result.artifact);
    const path = await writeGenerationText(options.repositoryRoot, 'skill.md', result.artifact.skillMarkdown);
    await writeStageMetadata(options.repositoryRoot, 'skill-stage.json', result, now());
    return { command, status: 'generated', artifact: path, usage: publicUsage(result.usage) };
  }

  parseSkillDraft(await readGenerationJson(options.repositoryRoot, 'skill.json'), profile);
  const checks = await verifyGeneratedBundle(bundle, evidence.cli.executable, options.repositoryRoot);
  const path = await writeGenerationJson(options.repositoryRoot, 'verification.json', {
    schemaVersion: 1,
    verifiedAt: now().toISOString(),
    evidenceHash: evidence.evidenceHash,
    irHash: artifactHash(ir),
    profileHash: artifactHash(profile),
    checks
  });
  return { command, status: 'verified', artifact: path };
}

async function runPaidStage<T>(
  repositoryRoot: string,
  failureName: string,
  now: () => Date,
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof GenerationStageOutputError) {
      await writeGenerationJson(repositoryRoot, failureName, {
        schemaVersion: 1,
        failedAt: now().toISOString(),
        model: 'deepseek-v4-flash',
        promptHash: error.promptHash,
        usage: error.usage,
        reason: error.message,
        rawOutput: error.rawOutput
      });
    }
    throw error;
  }
}

async function verifyGeneratedBundle(
  bundle: ReturnType<typeof materializeToolBundle>,
  executable: string,
  root: string
): Promise<{ id: string; success: true }[]> {
  const cases = [
    {
      id: 'inline-count',
      input: { filter: '.users | length', source: { type: 'inline', data: { users: [1, 2, 3] } } },
      expected: [3]
    },
    {
      id: 'inline-transform',
      input: { filter: '[.values[] | select(. >= 2)]', source: { type: 'inline', data: { values: [1, 2, 3] } } },
      expected: [[2, 3]]
    }
  ];
  const checks: { id: string; success: true }[] = [];
  for (const verificationCase of cases) {
    const output = await executeGeneratedTool({
      bundle, executable, root, input: verificationCase.input
    });
    if (!output.ok || JSON.stringify(output.values) !== JSON.stringify(verificationCase.expected)) {
      throw new Error(`Generated tool verification failed: ${verificationCase.id}.`);
    }
    checks.push({ id: verificationCase.id, success: true });
  }
  return checks;
}

async function writeStageMetadata(
  repositoryRoot: string,
  name: string,
  result: { model: string; promptHash: string; usage: unknown; artifact: unknown },
  generatedAt: Date
): Promise<void> {
  await writeGenerationJson(repositoryRoot, name, {
    schemaVersion: 1,
    generatedAt: generatedAt.toISOString(),
    model: result.model,
    promptHash: result.promptHash,
    artifactHash: artifactHash(result.artifact),
    usage: result.usage
  });
}

function publicUsage(usage: {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
}): PublicUsage {
  return {
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens
  };
}

function parseCommand(argv: readonly string[]): GenerationCommand {
  if (argv.length !== 1 || !COMMANDS.includes(argv[0] as GenerationCommand)) {
    throw new Error(`Expected one generation command: ${COMMANDS.join(', ')}.`);
  }
  return argv[0] as GenerationCommand;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const summary = await runGenerationCommand(argv, { repositoryRoot: process.cwd() });
  console.log(JSON.stringify(summary));
}

function isEntrypoint(entrypoint: string | undefined): boolean {
  if (!entrypoint) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entrypoint)).href;
  } catch {
    return false;
  }
}

if (isEntrypoint(process.argv[1])) {
  main().catch(() => {
    console.error('Generation command failed. Inspect the private stage artifacts for details.');
    process.exitCode = 1;
  });
}
