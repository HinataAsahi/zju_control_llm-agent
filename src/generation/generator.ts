import * as z from 'zod/v4';
import { DEEPSEEK_MODEL } from '../agent/deepseek-client.js';
import type { ModelTurnClient, ModelUsage } from '../agent/model-client.js';
import { verifyApprovalRecord, type ApprovalRecord } from './approval.js';
import type { CliEvidence } from './collector.js';
import { sha256 } from './collector.js';
import { artifactHash } from './hash.js';
import { materializeToolBundle } from './materializer.js';
import { parseToolProfile, type ToolProfile } from './profile.js';
import { parseCliIr, type CliIr } from './schema.js';

const GENERATION_TIMEOUT_MS = 60_000;

export interface GenerationStageResult<T> {
  artifact: T;
  model: string;
  promptHash: string;
  usage: ModelUsage;
}

export class GenerationStageOutputError extends Error {
  constructor(
    message: string,
    public readonly rawOutput: string,
    public readonly promptHash: string,
    public readonly usage: ModelUsage
  ) {
    super(message);
    this.name = 'GenerationStageOutputError';
  }
}

const skillDraftSchema = z.strictObject({
  schemaVersion: z.literal(1),
  profileHash: z.string().regex(/^[a-f0-9]{64}$/),
  skillMarkdown: z.string().min(1).max(16 * 1024)
});

export type SkillDraft = z.infer<typeof skillDraftSchema>;

export async function extractCliIr(options: {
  evidence: CliEvidence;
  client: ModelTurnClient;
}): Promise<GenerationStageResult<CliIr>> {
  const help = sourceText(options.evidence, 'help');
  const version = sourceText(options.evidence, 'version');
  const userContent = [
    `CLI name: ${options.evidence.cli.name}`,
    `CLI version: ${options.evidence.cli.version}`,
    `Evidence hash: ${options.evidence.evidenceHash}`,
    '',
    'VERSION EVIDENCE',
    numberLines(version),
    '',
    'HELP EVIDENCE',
    numberLines(help)
  ].join('\n');
  return runStructuredStage({
    client: options.client,
    instructions: IR_INSTRUCTIONS,
    userContent,
    outputSchema: { type: 'object', additionalProperties: false },
    parse: value => parseCliIr(value, options.evidence)
  });
}

export async function proposeToolProfile(options: {
  ir: CliIr;
  client: ModelTurnClient;
}): Promise<GenerationStageResult<ToolProfile>> {
  const userContent = [
    `IR hash: ${artifactHash(options.ir)}`,
    '',
    'VALIDATED CLI IR',
    JSON.stringify(options.ir, null, 2)
  ].join('\n');
  return runStructuredStage({
    client: options.client,
    instructions: PROFILE_INSTRUCTIONS,
    userContent,
    outputSchema: { type: 'object', additionalProperties: false },
    parse: value => parseToolProfile(value, options.ir)
  });
}

export async function generateSkillDraft(options: {
  evidence: CliEvidence;
  ir: CliIr;
  profile: ToolProfile;
  approval: ApprovalRecord | unknown;
  client: ModelTurnClient;
}): Promise<GenerationStageResult<SkillDraft>> {
  if (!verifyApprovalRecord(options.approval, options.evidence, options.ir, options.profile)) {
    throw new Error('A matching approval is required before Skill generation.');
  }
  const bundle = materializeToolBundle(options.ir, options.profile);
  const profileHash = artifactHash(options.profile);
  const userContent = [
    `Profile hash: ${profileHash}`,
    '',
    'APPROVED TOOL PROFILE',
    JSON.stringify(options.profile, null, 2),
    '',
    'MATERIALIZED MCP TOOL',
    JSON.stringify({ tool: bundle.tool, inputSchema: bundle.inputSchema }, null, 2)
  ].join('\n');
  const result = await runStructuredStage({
    client: options.client,
    instructions: SKILL_INSTRUCTIONS,
    userContent,
    outputSchema: { type: 'object', additionalProperties: false },
    parse: value => parseSkillDraft(value, options.profile)
  });
  return result;
}

export function parseSkillDraft(value: unknown, profile: ToolProfile): SkillDraft {
  const skill = skillDraftSchema.parse(value);
  if (skill.profileHash !== artifactHash(profile)) {
    throw new Error('Skill profileHash does not match the approved profile.');
  }
  validateSkillMarkdown(skill.skillMarkdown, profile.tool.name);
  return skill;
}

async function runStructuredStage<T>(options: {
  client: ModelTurnClient;
  instructions: string;
  userContent: string;
  outputSchema: Record<string, unknown>;
  parse: (value: unknown) => T;
}): Promise<GenerationStageResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GENERATION_TIMEOUT_MS);
  const promptHash = sha256(`${options.instructions}\n${options.userContent}`);
  try {
    const response = await options.client.createTurn({
      instructions: options.instructions,
      history: [{ type: 'message', role: 'user', content: options.userContent }],
      tools: [],
      outputSchema: options.outputSchema,
      signal: controller.signal
    });
    if (response.functionCalls.length > 0 || !response.finalText) {
      throw new GenerationStageOutputError(
        'Generation stage returned unsupported output.',
        response.finalText ?? '',
        promptHash,
        response.usage
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.finalText);
    } catch {
      throw new GenerationStageOutputError(
        'Generation stage returned invalid JSON.',
        response.finalText,
        promptHash,
        response.usage
      );
    }
    if (!isRecord(parsed)) {
      throw new GenerationStageOutputError(
        'Generation stage returned invalid JSON.',
        response.finalText,
        promptHash,
        response.usage
      );
    }
    let artifact: T;
    try {
      artifact = options.parse(parsed);
    } catch {
      throw new GenerationStageOutputError(
        'Generation stage output failed local validation.',
        response.finalText,
        promptHash,
        response.usage
      );
    }
    return {
      artifact,
      model: DEEPSEEK_MODEL,
      promptHash,
      usage: response.usage
    };
  } finally {
    clearTimeout(timer);
  }
}

function sourceText(evidence: CliEvidence, id: 'version' | 'help'): string {
  const source = evidence.sources.find(candidate => candidate.id === id);
  if (!source) throw new Error(`Collected evidence is missing ${id}.`);
  return source.stdout;
}

function numberLines(value: string): string {
  return value.split('\n').map((line, index) => `L${index + 1}: ${line}`).join('\n');
}

function validateSkillMarkdown(markdown: string, toolName: string): void {
  const skillName = toolName.replaceAll('_', '-');
  if (!markdown.startsWith(`---\nname: ${skillName}\ndescription:`)) {
    throw new Error('Skill draft has invalid frontmatter.');
  }
  const closingFrontmatter = markdown.indexOf('\n---', 4);
  if (closingFrontmatter < 0 || !markdown.includes(`\`${toolName}\``)) {
    throw new Error('Skill draft does not describe the approved tool.');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const IR_INSTRUCTIONS = `You extract a complete evidence-backed CLI intermediate representation from numbered version and help text.
Return exactly one JSON object and no Markdown fence or prose. Use schemaVersion 1 and copy cliName, version, and evidenceHash exactly.
Represent every usage form, positional argument, and documented option, including the standalone -- end-of-options marker. Do not silently omit capabilities.
Each usage form, positional, option, and constraint must cite one or more source ranges as {"sourceId":"help"|"version","startLine":N,"endLine":N}.
Use stable lowercase kebab-case ids. Option names retain leading dashes. inferredType is boolean|string|integer|number|json|path|unknown. confidence is high|medium|low. repeatable is yes|no|unknown.
Use null uncertainty only when the cited text is explicit; otherwise explain what is uncertain. Do not invent defaults, constraints, examples, or semantics absent from the evidence.
The JSON keys are exactly: schemaVersion, cliName, version, evidenceHash, summary, usageForms, positionals, options. Usage forms contain text and evidence. Positionals contain id, name, cardinality, inferredType, confidence, uncertainty, evidence. Options contain id, names, takesValue, valueName, inferredType, repeatable, description, confidence, uncertainty, constraints, evidence. Constraints contain kind, expression, evidence.`;

const PROFILE_INSTRUCTIONS = `You propose a narrow, read-only MCP ToolProfile for the validated jq CLI IR. Return exactly one JSON object and no Markdown fence or prose.
This first profile must expose one tool named jq_query_generated for deterministic queries over inline JSON or an allowed JSON file. It must not expose arbitrary argv, shell commands, environment variables, output formatting choices, module paths, filter files, raw text modes, or direct CLI file operands.
Create exactly one capabilityDecisions entry for every positional and option in the IR. Use allow only for the filter positional, compact JSON output option, and standalone -- end-of-options marker required by the declarative binding. Mark every other capability deny or defer with a concrete risk reason.
Create required inputFields filter (string, minLength 1, maxUtf8Bytes 4096) and source (json-source, allowInline true, allowFile true). Bind filter to argv position 0, source to JSON stdin, compact output as the sole fixed option, and the standalone -- capability as endOfOptionsCapabilityId.
Use output type json-lines and limits timeoutMs 5000, inputBytes 1048576, outputBytes 1048576. Copy cliName and the supplied IR hash exactly.
The JSON keys are exactly: schemaVersion, cliName, irHash, tool, capabilityDecisions, inputFields, bindings, output, limits. Decisions contain kind, capabilityId, disposition, risk, reason. Bindings contain fixedOptions, endOfOptionsCapabilityId, argv, stdin.`;

const SKILL_INSTRUCTIONS = `You write a concise Agent Skill for one approved MCP tool. Return exactly one JSON object with schemaVersion 1, the supplied profileHash, and skillMarkdown.
The Markdown must start with YAML frontmatter whose name is the MCP tool name with underscores changed to hyphens and whose description explains the trigger boundary. Mention the exact MCP tool name in backticks.
Explain when to use it, when not to use it, inline versus allowed-file sources, one-target-query strategy, and recovery from structured errors. Do not recommend shell execution, raw jq CLI calls, non-JSON re-encoding, path traversal, invented data, unchanged retries, or capabilities denied by the profile. Keep the Skill generic and do not mention experiment task IDs.`;
