// Master key DTOs (API.md section 4.22, ADR-034): `GET /keys` and the online rotation `POST /keys/rotate` (fresh auth).
// A rotation re-encrypts every secret with a new key and invalidates every session, share URL and pending approval.
// Deployments whose key comes from `HF_MASTER_KEY` rotate offline with the `rotate-key` CLI.
import { z } from 'zod'
import { timestampSchema } from '../ids.ts'

const countSchema = z.int().min(0)

/** Where the master key comes from: `HF_MASTER_KEY` (`env`) or `<dataDir>/secret.key` (`file`). */
export const keySourceSchema = z.enum(['env', 'file'])
export type KeySource = z.infer<typeof keySourceSchema>

/**
 * The stored key check against the key in use: `ok`; `mismatch` (another key than the one the secrets were written
 * with: stored secrets cannot be read and a rotation is refused); `unknown` (no check stored yet, e.g. a v1.2 database
 * whose secrets could not be read).
 */
export const keyCheckSchema = z.enum(['ok', 'mismatch', 'unknown'])
export type KeyCheck = z.infer<typeof keyCheckSchema>

/** `GET /keys`: the state of the master key (never the key). */
export const keyStatusSchema = z.object({
  source: keySourceSchema,
  /** Key version: 1 until the first rotation, then +1 per rotation. */
  keyVersion: z.int().min(1),
  /** Last rotation; null = never rotated. */
  rotatedAt: timestampSchema.nullable(),
  keyCheck: keyCheckSchema,
  /** Stored secrets (rows), readable or not. */
  secrets: countSchema,
  /** Stored secrets that cannot be decrypted with the current key (a rotation leaves them unchanged). */
  unreadableSecrets: countSchema,
  /** Share links (their URLs change with a rotation). */
  shares: countSchema,
  /** Messages waiting for a tool approval (a rotation denies them). */
  pendingApprovals: countSchema,
  /** `POST /keys/rotate` can run: the key comes from `secret.key` and the key check is `ok`. */
  canRotate: z.boolean(),
})
export type KeyStatus = z.infer<typeof keyStatusSchema>

/** Body of `POST /keys/rotate` (fresh auth): the typed confirmation. */
export const keyRotateBodySchema = z.strictObject({
  confirm: z.literal('ROTATE'),
})
export type KeyRotateBody = z.infer<typeof keyRotateBodySchema>

/** Response of `POST /keys/rotate`: what the rotation did. */
export const keyRotationResultSchema = z.object({
  /** The new key version. */
  keyVersion: z.int().min(1),
  rotatedAt: timestampSchema,
  /** Secrets re-encrypted with the new key. */
  secrets: countSchema,
  /** Secrets that could not be read with the old key, left unchanged. */
  skippedSecrets: countSchema,
  /** Share links whose URL changed (the owners copy the new links). */
  shares: countSchema,
  /** Pending tool approvals denied ("Expired after a key rotation."). */
  approvalsExpired: countSchema,
  /** Chats whose pending approval flag was cleared. */
  chats: countSchema,
  /** Runs stopped before the rotation. */
  runsStopped: countSchema,
})
export type KeyRotationResult = z.infer<typeof keyRotationResultSchema>
