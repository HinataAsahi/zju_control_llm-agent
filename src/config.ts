import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface Limits {
  inputLimitBytes: number;
  outputLimitBytes: number;
  timeoutMs: number;
}

export interface AppConfig {
  root: string;
  jqExecutable: string;
  limits: Limits;
}

export const DEFAULT_LIMITS: Limits = {
  inputLimitBytes: 1024 * 1024,
  outputLimitBytes: 1024 * 1024,
  timeoutMs: 5000
};

export async function loadConfig(argv: string[]): Promise<AppConfig> {
  if (argv.length !== 2 || argv[0] !== '--root' || !argv[1]) {
    throw new Error('Expected --root <path>.');
  }

  let root: string;
  try {
    root = await realpath(resolve(argv[1]));
  } catch {
    throw new Error('Root path is not available.');
  }

  let rootStats;
  try {
    rootStats = await stat(root);
  } catch {
    throw new Error('Root path is not available.');
  }
  if (!rootStats.isDirectory()) {
    throw new Error('Root path must be a directory.');
  }

  return { root, jqExecutable: 'jq', limits: DEFAULT_LIMITS };
}
