import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ExperimentCondition } from './schema.js';
import type { Stage2bTreatment } from './stage2b-suite.js';

export type Stage2bSkillVersion = 'v1' | 'v2';

export interface Stage2bSkillIdentity {
  version: Stage2bSkillVersion;
  sha256: string;
}

export interface Stage2bLoadedSkillAsset {
  identity: Stage2bSkillIdentity;
  contents: string;
  workspaceAsset: {
    root: string;
    relativePath: string;
  };
}

const versionedAssets: Readonly<Partial<Record<Stage2bTreatment, {
  version: Stage2bSkillVersion;
  relativePath: string;
}>>> = Object.freeze({
  'skill-v1': Object.freeze({ version: 'v1', relativePath: 'skills/jq-query-v1/SKILL.md' }),
  'skill-v2': Object.freeze({ version: 'v2', relativePath: 'skills/jq-query-v2/SKILL.md' })
});

export function experimentConditionForTreatment(treatment: Stage2bTreatment): ExperimentCondition {
  return treatment === 'skill-v1' || treatment === 'skill-v2' ? 'skill' : treatment;
}

export function createStage2bSkillIdentity(
  version: Stage2bSkillVersion,
  contents: string
): Stage2bSkillIdentity {
  return {
    version,
    sha256: createHash('sha256').update(contents, 'utf8').digest('hex')
  };
}

export async function loadStage2bSkillAsset(
  repositoryRoot: string,
  treatment: Stage2bTreatment
): Promise<Stage2bLoadedSkillAsset | undefined> {
  const asset = versionedAssets[treatment];
  if (!asset) return undefined;
  const root = resolve(repositoryRoot, 'experiments/stage-2b');
  const path = resolve(root, asset.relativePath);
  const metadata = await lstat(path, { bigint: true });
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error('Stage 2B skill asset must be a regular non-symlink file.');
  }
  const noFollow = Reflect.get(constants, 'O_NOFOLLOW');
  const flags = constants.O_RDONLY | (typeof noFollow === 'number' ? noFollow : 0);
  const handle = await open(path, flags);
  let contents: string;
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
      throw new Error('Stage 2B skill asset changed while being opened.');
    }
    contents = await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
  return {
    identity: createStage2bSkillIdentity(asset.version, contents),
    contents,
    workspaceAsset: { root, relativePath: asset.relativePath }
  };
}
