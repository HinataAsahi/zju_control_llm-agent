import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as z from 'zod/v4';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_OUTPUT_LIMIT_BYTES = 1024 * 1024;

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CliEvidenceSource extends CommandResult {
  id: 'version' | 'help';
  argv: readonly string[];
  sha256: string;
}

export interface CliEvidence {
  schemaVersion: 1;
  cli: {
    name: string;
    executable: string;
    version: string;
  };
  collectedAt: string;
  sources: readonly CliEvidenceSource[];
  evidenceHash: string;
}

export interface CollectCliEvidenceOptions {
  cliName: string;
  executable: string;
  collectedAt?: Date;
  runCommand?: (executable: string, args: readonly string[]) => Promise<CommandResult>;
}

const evidenceSourceSchema = z.strictObject({
  id: z.enum(['version', 'help']),
  argv: z.array(z.string().min(1)).length(2),
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.literal(0),
  sha256: z.string().regex(/^[a-f0-9]{64}$/)
});

const cliEvidenceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  cli: z.strictObject({
    name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
    executable: z.string().min(1),
    version: z.string().min(1)
  }),
  collectedAt: z.iso.datetime(),
  sources: z.array(evidenceSourceSchema).length(2),
  evidenceHash: z.string().regex(/^[a-f0-9]{64}$/)
});

export async function collectCliEvidence(options: CollectCliEvidenceOptions): Promise<CliEvidence> {
  const cliName = parseCliName(options.cliName);
  const executable = options.executable.trim();
  if (!executable) throw new Error('CLI executable must not be empty.');
  const runCommand = options.runCommand ?? runEvidenceCommand;
  const definitions = [
    { id: 'version' as const, args: ['--version'] as const },
    { id: 'help' as const, args: ['--help'] as const }
  ];
  const sources: CliEvidenceSource[] = [];

  for (const definition of definitions) {
    const result = await runCommand(executable, definition.args);
    if (!Number.isSafeInteger(result.exitCode) || result.exitCode !== 0) {
      const code = Number.isSafeInteger(result.exitCode) ? result.exitCode : 'unknown';
      throw new Error(`Unable to collect ${cliName} ${definition.id}: command exited with code ${code}.`);
    }
    sources.push({
      id: definition.id,
      argv: [executable, ...definition.args],
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      sha256: sha256(result.stdout)
    });
  }

  const versionSource = sources[0];
  if (!versionSource) throw new Error(`Unable to collect ${cliName} version.`);
  const version = parseVersion(cliName, versionSource.stdout);
  if (!version) throw new Error(`Unable to identify ${cliName} version.`);
  const evidenceHash = sha256(JSON.stringify({
    cliName,
    version,
    sources: sources.map(source => ({ id: source.id, sha256: source.sha256 }))
  }));

  return {
    schemaVersion: 1,
    cli: { name: cliName, executable, version },
    collectedAt: (options.collectedAt ?? new Date()).toISOString(),
    sources,
    evidenceHash
  };
}

export function parseCliEvidence(value: unknown): CliEvidence {
  const evidence = cliEvidenceSchema.parse(value);
  const sourceIds = evidence.sources.map(source => source.id);
  if (sourceIds[0] !== 'version' || sourceIds[1] !== 'help') {
    throw new Error('Evidence sources must contain version followed by help.');
  }
  for (const source of evidence.sources) {
    if (source.sha256 !== sha256(source.stdout)) {
      throw new Error(`Evidence source ${source.id} hash does not match its content.`);
    }
    const expectedFlag = source.id === 'version' ? '--version' : '--help';
    if (source.argv[0] !== evidence.cli.executable || source.argv[1] !== expectedFlag) {
      throw new Error(`Evidence source ${source.id} command does not match its identity.`);
    }
  }
  const version = parseVersion(evidence.cli.name, evidence.sources[0]!.stdout);
  if (version !== evidence.cli.version) throw new Error('Evidence CLI version does not match version output.');
  const expectedHash = sha256(JSON.stringify({
    cliName: evidence.cli.name,
    version: evidence.cli.version,
    sources: evidence.sources.map(source => ({ id: source.id, sha256: source.sha256 }))
  }));
  if (expectedHash !== evidence.evidenceHash) throw new Error('Evidence hash does not match its sources.');
  return evidence;
}

function parseCliName(value: string): string {
  const name = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    throw new Error('CLI name must be a simple executable name.');
  }
  return name;
}

function parseVersion(cliName: string, output: string): string | undefined {
  const escapedName = cliName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = output.trim().match(new RegExp(`^${escapedName}(?:-|\\s+)(?:v)?([0-9]+(?:\\.[0-9]+){1,3}(?:[-+][A-Za-z0-9._-]+)?)$`, 'i'));
  return match?.[1];
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function runEvidenceCommand(executable: string, args: readonly string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let outputBytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const child = spawn(executable, [...args], {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: restrictedEnvironment()
    });
    const timeout = setTimeout(() => finish(new Error('CLI evidence command timed out.')), DEFAULT_TIMEOUT_MS);

    function finish(error?: Error, result?: CommandResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) {
        child.kill('SIGKILL');
        reject(error);
      } else if (result) {
        resolve(result);
      }
    }

    function capture(target: Buffer[], chunk: Buffer | string): void {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += buffer.byteLength;
      if (outputBytes > DEFAULT_OUTPUT_LIMIT_BYTES) {
        finish(new Error('CLI evidence command exceeded its output limit.'));
        return;
      }
      target.push(buffer);
    }

    child.stdout.on('data', chunk => capture(stdout, chunk));
    child.stderr.on('data', chunk => capture(stderr, chunk));
    child.once('error', () => finish(new Error('Unable to start CLI evidence command.')));
    child.once('close', (code) => finish(undefined, {
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
      exitCode: code ?? -1
    }));
  });
}

function restrictedEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8'
  };
}
