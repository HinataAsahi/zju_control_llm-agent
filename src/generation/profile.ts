import * as z from 'zod/v4';
import { artifactHash } from './hash.js';
import type { CliIr } from './schema.js';

const capabilityIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const fieldNameSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

const decisionSchema = z.strictObject({
  kind: z.enum(['option', 'positional']),
  capabilityId: capabilityIdSchema,
  disposition: z.enum(['allow', 'deny', 'defer']),
  risk: z.enum(['low', 'medium', 'high']),
  reason: z.string().min(1)
});

const stringShapeSchema = z.strictObject({
  type: z.literal('string'),
  minLength: z.number().int().min(0).max(1_000_000),
  maxUtf8Bytes: z.number().int().positive().max(16 * 1024 * 1024)
}).refine(shape => shape.maxUtf8Bytes >= shape.minLength, {
  message: 'maxUtf8Bytes must not be less than minLength.'
});

const jsonSourceShapeSchema = z.strictObject({
  type: z.literal('json-source'),
  allowInline: z.boolean(),
  allowFile: z.boolean()
}).refine(shape => shape.allowInline || shape.allowFile, {
  message: 'A JSON source must allow inline data, files, or both.'
});

const inputFieldSchema = z.strictObject({
  name: fieldNameSchema,
  description: z.string().min(1),
  required: z.boolean(),
  shape: z.discriminatedUnion('type', [stringShapeSchema, jsonSourceShapeSchema])
});

const argvBindingSchema = z.strictObject({
  field: fieldNameSchema,
  capabilityId: capabilityIdSchema,
  position: z.number().int().min(0).max(64)
});

const stdinBindingSchema = z.strictObject({
  field: fieldNameSchema,
  encoding: z.literal('json')
});

export const toolProfileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  cliName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  irHash: z.string().regex(/^[a-f0-9]{64}$/),
  tool: z.strictObject({
    name: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    description: z.string().min(1).max(1024)
  }),
  capabilityDecisions: z.array(decisionSchema),
  inputFields: z.array(inputFieldSchema).min(1),
  bindings: z.strictObject({
    fixedOptions: z.array(capabilityIdSchema),
    endOfOptionsCapabilityId: capabilityIdSchema,
    argv: z.array(argvBindingSchema),
    stdin: stdinBindingSchema
  }),
  output: z.strictObject({ type: z.literal('json-lines') }),
  limits: z.strictObject({
    timeoutMs: z.number().int().min(100).max(30_000),
    inputBytes: z.number().int().positive().max(16 * 1024 * 1024),
    outputBytes: z.number().int().positive().max(16 * 1024 * 1024)
  })
});

export type ToolProfile = z.infer<typeof toolProfileSchema>;

export function parseToolProfile(value: unknown, ir: CliIr): ToolProfile {
  const profile = toolProfileSchema.parse(value);
  if (profile.cliName !== ir.cliName) throw new Error('Profile CLI name does not match the IR.');
  if (profile.irHash !== artifactHash(ir)) throw new Error('Profile irHash does not match the IR.');

  const expected = new Map<string, 'option' | 'positional'>([
    ...ir.positionals.map(item => [item.id, 'positional'] as const),
    ...ir.options.map(item => [item.id, 'option'] as const)
  ]);
  const decisions = new Map<string, ToolProfile['capabilityDecisions'][number]>();
  for (const decision of profile.capabilityDecisions) {
    const expectedKind = expected.get(decision.capabilityId);
    if (!expectedKind) throw new Error(`Decision references unknown capability ${decision.capabilityId}.`);
    if (expectedKind !== decision.kind) {
      throw new Error(`Decision kind for ${decision.capabilityId} does not match the IR.`);
    }
    if (decisions.has(decision.capabilityId)) {
      throw new Error(`Decision for ${decision.capabilityId} is duplicated.`);
    }
    decisions.set(decision.capabilityId, decision);
  }
  for (const positional of ir.positionals) {
    if (!decisions.has(positional.id)) throw new Error(`Missing decision for positional ${positional.id}.`);
  }
  for (const option of ir.options) {
    if (!decisions.has(option.id)) throw new Error(`Missing decision for option ${option.id}.`);
  }

  const fields = new Map<string, ToolProfile['inputFields'][number]>();
  for (const field of profile.inputFields) {
    if (fields.has(field.name)) throw new Error(`Input field ${field.name} is duplicated.`);
    fields.set(field.name, field);
  }
  const positions = new Set<number>();
  const boundFields = new Set<string>();
  const boundCapabilities = new Set<string>();
  for (const binding of profile.bindings.argv) {
    const field = fields.get(binding.field);
    if (!field) throw new Error(`argv binding references unknown field ${binding.field}.`);
    if (field.shape.type !== 'string') throw new Error(`argv field ${binding.field} must be a string.`);
    const decision = decisions.get(binding.capabilityId);
    if (decision?.kind !== 'positional' || decision.disposition !== 'allow') {
      throw new Error(`Positional ${binding.capabilityId} is not allowed.`);
    }
    if (positions.has(binding.position)) throw new Error(`argv position ${binding.position} is duplicated.`);
    if (boundFields.has(binding.field)) throw new Error(`Input field ${binding.field} has duplicate bindings.`);
    if (boundCapabilities.has(binding.capabilityId)) {
      throw new Error(`Positional ${binding.capabilityId} has duplicate bindings.`);
    }
    positions.add(binding.position);
    boundFields.add(binding.field);
    boundCapabilities.add(binding.capabilityId);
  }
  const stdinField = fields.get(profile.bindings.stdin.field);
  if (!stdinField || stdinField.shape.type !== 'json-source') {
    throw new Error('stdin binding must reference a JSON source input field.');
  }
  if (boundFields.has(profile.bindings.stdin.field)) {
    throw new Error(`Input field ${profile.bindings.stdin.field} has duplicate bindings.`);
  }
  boundFields.add(profile.bindings.stdin.field);
  for (const field of profile.inputFields) {
    if (!boundFields.has(field.name)) throw new Error(`Input field ${field.name} has no execution binding.`);
  }
  const fixedOptions = new Set<string>();
  for (const optionId of profile.bindings.fixedOptions) {
    if (fixedOptions.has(optionId)) throw new Error(`Fixed option ${optionId} is duplicated.`);
    fixedOptions.add(optionId);
    const decision = decisions.get(optionId);
    const option = ir.options.find(candidate => candidate.id === optionId);
    if (decision?.kind !== 'option' || decision.disposition !== 'allow') {
      throw new Error(`Fixed option ${optionId} is not allowed.`);
    }
    if (option?.takesValue) throw new Error(`Fixed option ${optionId} requires a value.`);
  }
  const endDecision = decisions.get(profile.bindings.endOfOptionsCapabilityId);
  const endOption = ir.options.find(candidate => candidate.id === profile.bindings.endOfOptionsCapabilityId);
  if (
    endDecision?.kind !== 'option'
    || endDecision.disposition !== 'allow'
    || !endOption?.names.includes('--')
  ) {
    throw new Error('endOfOptionsCapabilityId must reference an allowed -- capability.');
  }
  if (fixedOptions.has(profile.bindings.endOfOptionsCapabilityId)) {
    throw new Error('The end-of-options capability cannot also be a fixed option.');
  }
  if (stdinField.shape.allowFile && !stdinField.required) {
    throw new Error('A file-capable JSON source must be required.');
  }
  return profile;
}
