import { artifactHash } from './hash.js';
import type { ToolProfile } from './profile.js';
import type { CliIr } from './schema.js';

type JsonSchema = Record<string, unknown>;

export interface GeneratedToolBundle {
  schemaVersion: 1;
  tool: { name: string; description: string };
  inputSchema: {
    type: 'object';
    properties: Record<string, JsonSchema>;
    required: string[];
    additionalProperties: false;
  };
  execution: {
    schemaVersion: 1;
    cliName: string;
    cliVersion: string;
    irHash: string;
    profileHash: string;
    executable?: never;
    shell: false;
    fixedArgv: string[];
    argv: ToolProfile['bindings']['argv'];
    stdin: ToolProfile['bindings']['stdin'];
    output: ToolProfile['output'];
    limits: ToolProfile['limits'];
  };
}

export function materializeToolBundle(ir: CliIr, profile: ToolProfile): GeneratedToolBundle {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const field of profile.inputFields) {
    properties[field.name] = field.shape.type === 'string'
      ? {
          type: 'string',
          description: field.description,
          minLength: field.shape.minLength,
          maxLength: field.shape.maxUtf8Bytes
        }
      : jsonSourceSchema(field.description, field.shape.allowInline, field.shape.allowFile);
    if (field.required) required.push(field.name);
  }
  const fixedArgv = profile.bindings.fixedOptions.map(optionId => {
    const option = ir.options.find(candidate => candidate.id === optionId);
    if (!option) throw new Error(`Unable to materialize missing option ${optionId}.`);
    return option.names.find(name => name.startsWith('--') && name !== '--') ?? option.names[0]!;
  });
  fixedArgv.push('--');

  return {
    schemaVersion: 1,
    tool: { ...profile.tool },
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    execution: {
      schemaVersion: 1,
      cliName: ir.cliName,
      cliVersion: ir.version,
      irHash: artifactHash(ir),
      profileHash: artifactHash(profile),
      shell: false,
      fixedArgv,
      argv: [...profile.bindings.argv].sort((left, right) => left.position - right.position),
      stdin: { ...profile.bindings.stdin },
      output: { ...profile.output },
      limits: { ...profile.limits }
    }
  };
}

function jsonSourceSchema(description: string, allowInline: boolean, allowFile: boolean): JsonSchema {
  const variants: JsonSchema[] = [];
  if (allowInline) {
    variants.push({
      type: 'object',
      properties: {
        type: { const: 'inline' },
        data: {}
      },
      required: ['type', 'data'],
      additionalProperties: false
    });
  }
  if (allowFile) {
    variants.push({
      type: 'object',
      properties: {
        type: { const: 'file' },
        path: { type: 'string', minLength: 1 }
      },
      required: ['type', 'path'],
      additionalProperties: false
    });
  }
  return { description, oneOf: variants };
}
