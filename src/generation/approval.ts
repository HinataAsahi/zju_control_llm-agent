import * as z from 'zod/v4';
import type { CliEvidence } from './collector.js';
import { artifactHash } from './hash.js';
import type { ToolProfile } from './profile.js';
import type { CliIr } from './schema.js';

const approvalRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  approvedAt: z.iso.datetime(),
  evidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
  irHash: z.string().regex(/^[a-f0-9]{64}$/),
  profileHash: z.string().regex(/^[a-f0-9]{64}$/)
});

export type ApprovalRecord = z.infer<typeof approvalRecordSchema>;

export function createApprovalRecord(options: {
  evidence: CliEvidence;
  ir: CliIr;
  profile: ToolProfile;
  approvedAt?: Date;
}): ApprovalRecord {
  return {
    schemaVersion: 1,
    approvedAt: (options.approvedAt ?? new Date()).toISOString(),
    evidenceHash: options.evidence.evidenceHash,
    irHash: artifactHash(options.ir),
    profileHash: artifactHash(options.profile)
  };
}

export function verifyApprovalRecord(
  value: unknown,
  evidence: CliEvidence,
  ir: CliIr,
  profile: ToolProfile
): boolean {
  const result = approvalRecordSchema.safeParse(value);
  return result.success
    && result.data.evidenceHash === evidence.evidenceHash
    && result.data.irHash === artifactHash(ir)
    && result.data.profileHash === artifactHash(profile);
}
