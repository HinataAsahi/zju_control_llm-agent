import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  createStage2bSkillIdentity,
  experimentConditionForTreatment,
  loadStage2bSkillAsset
} from '../../src/experiment/stage2b-treatment.js';

const repositoryRoot = resolve('.');

test('maps versioned treatments to a neutral prompt condition and immutable skill identities', async () => {
  assert.deepEqual(createStage2bSkillIdentity('v1', 'abc'), {
    version: 'v1',
    sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  });
  assert.equal(experimentConditionForTreatment('description'), 'description');
  assert.equal(experimentConditionForTreatment('skill-v1'), 'skill');
  assert.equal(experimentConditionForTreatment('skill-v2'), 'skill');

  assert.equal(await loadStage2bSkillAsset(repositoryRoot, 'description'), undefined);
  const v1 = await loadStage2bSkillAsset(repositoryRoot, 'skill-v1');
  const v2 = await loadStage2bSkillAsset(repositoryRoot, 'skill-v2');
  assert.ok(v1);
  assert.ok(v2);
  assert.equal(v1.identity.version, 'v1');
  assert.equal(v2.identity.version, 'v2');
  assert.match(v1.identity.sha256, /^[a-f0-9]{64}$/);
  assert.match(v2.identity.sha256, /^[a-f0-9]{64}$/);
  assert.notEqual(v1.identity.sha256, v2.identity.sha256);
  assert.equal(v1.workspaceAsset.relativePath, 'skills/jq-query-v1/SKILL.md');
  assert.equal(v2.workspaceAsset.relativePath, 'skills/jq-query-v2/SKILL.md');
});
