import * as z from 'zod/v4';
import type { CliEvidence } from './collector.js';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const evidenceReferenceSchema = z.strictObject({
  sourceId: z.enum(['version', 'help']),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive()
}).refine(reference => reference.endLine >= reference.startLine, {
  message: 'Evidence endLine must be greater than or equal to startLine.'
});

const confidenceSchema = z.enum(['high', 'medium', 'low']);
const inferredTypeSchema = z.enum([
  'boolean', 'string', 'integer', 'number', 'json', 'path', 'unknown'
]);

const evidencedUsageSchema = z.strictObject({
  text: z.string().min(1),
  evidence: z.array(evidenceReferenceSchema).min(1)
});

const positionalSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  name: z.string().min(1),
  cardinality: z.enum(['one', 'optional', 'zero-or-more', 'one-or-more']),
  inferredType: inferredTypeSchema,
  confidence: confidenceSchema,
  uncertainty: z.string().min(1).nullable(),
  evidence: z.array(evidenceReferenceSchema).min(1)
});

const optionConstraintSchema = z.strictObject({
  kind: z.enum(['implies', 'conflicts', 'range', 'other']),
  expression: z.string().min(1),
  evidence: z.array(evidenceReferenceSchema).min(1)
});

const optionSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  names: z.array(z.string().regex(/^(?:--|--?[A-Za-z0-9][A-Za-z0-9-]*)$/)).min(1),
  takesValue: z.boolean(),
  valueName: z.string().min(1).nullable(),
  inferredType: inferredTypeSchema,
  repeatable: z.enum(['yes', 'no', 'unknown']),
  description: z.string().min(1),
  confidence: confidenceSchema,
  uncertainty: z.string().min(1).nullable(),
  constraints: z.array(optionConstraintSchema),
  evidence: z.array(evidenceReferenceSchema).min(1)
}).superRefine((option, context) => {
  if (option.takesValue !== (option.valueName !== null)) {
    context.addIssue({
      code: 'custom',
      message: 'takesValue and valueName must agree.',
      path: ['valueName']
    });
  }
  if (!option.takesValue && option.inferredType !== 'boolean' && option.inferredType !== 'unknown') {
    context.addIssue({
      code: 'custom',
      message: 'A flag without a value must be boolean or unknown.',
      path: ['inferredType']
    });
  }
});

export const cliIrSchema = z.strictObject({
  schemaVersion: z.literal(1),
  cliName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  version: z.string().min(1),
  evidenceHash: sha256Schema,
  summary: z.string().min(1),
  usageForms: z.array(evidencedUsageSchema).min(1),
  positionals: z.array(positionalSchema),
  options: z.array(optionSchema)
});

export type EvidenceReference = z.infer<typeof evidenceReferenceSchema>;
export type CliIr = z.infer<typeof cliIrSchema>;

export function parseCliIr(value: unknown, evidence: CliEvidence): CliIr {
  const ir = cliIrSchema.parse(value);
  if (ir.evidenceHash !== evidence.evidenceHash) {
    throw new Error('IR evidenceHash does not match collected evidence.');
  }
  if (ir.cliName !== evidence.cli.name || ir.version !== evidence.cli.version) {
    throw new Error('IR CLI identity does not match collected evidence.');
  }

  const references = [
    ...ir.usageForms.flatMap(item => item.evidence),
    ...ir.positionals.flatMap(item => item.evidence),
    ...ir.options.flatMap(option => [
      ...option.evidence,
      ...option.constraints.flatMap(constraint => constraint.evidence)
    ])
  ];
  for (const reference of references) validateEvidenceReference(reference, evidence);

  const ids = new Set<string>();
  const aliases = new Set<string>();
  for (const option of ir.options) {
    if (ids.has(option.id)) throw new Error(`Option id ${option.id} is duplicated.`);
    ids.add(option.id);
    for (const alias of option.names) {
      if (aliases.has(alias)) throw new Error(`Option alias ${alias} is duplicated.`);
      aliases.add(alias);
    }
  }
  const positionalIds = new Set<string>();
  for (const positional of ir.positionals) {
    if (positionalIds.has(positional.id)) {
      throw new Error(`Positional id ${positional.id} is duplicated.`);
    }
    positionalIds.add(positional.id);
  }
  for (const optionId of ids) {
    if (positionalIds.has(optionId)) throw new Error(`Capability id ${optionId} is duplicated.`);
  }
  return ir;
}

function validateEvidenceReference(reference: EvidenceReference, evidence: CliEvidence): void {
  const source = evidence.sources.find(candidate => candidate.id === reference.sourceId);
  if (!source) throw new Error(`Evidence source ${reference.sourceId} is unavailable.`);
  const lineCount = source.stdout.split('\n').length;
  if (reference.startLine > lineCount || reference.endLine > lineCount) {
    throw new Error(`Evidence line range is outside source ${reference.sourceId}.`);
  }
}
