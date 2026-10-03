// The shared core of the master-key rotation (Phase 7, ADR-034, ARCHITECTURE.md 6.14). Owner: W7.7 (W7.7-T4 / T5).
// Used by the online rotation (`KeyService.rotate`, ./index.ts) and by the offline `rotate-key` CLI (./cli.ts).
//
// - `rotateSecretsTx(tx, oldKeyring, newKeyring, now)`: inside ONE transaction, every secret row readable at the old
//   version is decrypted with the old `encryption` subkey and encrypted with the new one at the new version (the hint
//   and `updated_at` are kept; a row of another version or that fails GCM is left unchanged and counted as skipped);
//   every message with an open tool approval goes through `denyOpenApprovals(parts, KEY_ROTATION_DENIAL_REASON)` (the
//   approval requests were signed with the old `approval` subkey and can no longer be answered); every
//   `chats.pending_approval` flag is cleared; `_keys` = `{ version: new, check: check(new key), rotatedAt: now }`.
// - `rotateWithKeyFile(...)`: the write-ahead file flow (file mode): `secret.key.next` (exclusive, 0600, fsync of the
//   file and the folder) BEFORE the transaction, so a crash can never lose the new key; the transaction; then the rename
//   over `secret.key` (+ fsync of the folder). A failed transaction removes `.next` and rethrows; a failed rename is
//   logged and finished by the next boot (`recoverKeyState`).
//
// Key material never reaches a log line, an error message or a return value.
import type { HarnessUIMessagePart } from '@harness-forge/shared'
import type { Db, DbExecutor } from '../../db/client.ts'
import type { Env } from '../../env.ts'
import type { Logger } from '../../logger.ts'
import type { Keyring } from '../../security/types.ts'
import type { KeyState } from './types.ts'
import { existsSync, renameSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { and, eq, sql } from 'drizzle-orm'
import { chats, messages, secrets, settings } from '../../db/schema.ts'
import { readMasterKeyFile, syncDirectory, writeMasterKeyFile } from '../../security/keyring.ts'
import { denyOpenApprovals, isOpenApproval } from '../chats/approvals.ts'
import { decryptSecret, encryptSecret, secretAad } from '../secrets/crypto.ts'
import { keyCheckOf, keyCheckOfMasterKey, sameKeyCheck } from './check.ts'
import { nextKeyPath } from './recover.ts'
import { KEY_ROTATION_DENIAL_REASON, KEY_STATE_SETTING } from './types.ts'

/** Most chat ids carried by `key.rotated` (`keyRotatedDataSchema`). */
export const KEY_ROTATED_CHAT_IDS_MAX = 1000

/** What one rotation transaction did. */
export interface SecretsRotation {
  /** The new key version (`_keys.version`, the version of every re-encrypted row). */
  keyVersion: number
  rotatedAt: number
  /** Rows re-encrypted with the new key. */
  secrets: number
  /** Rows the old key could not read (another version, or failing GCM), left unchanged. */
  skippedSecrets: number
  /** Tool parts denied with `KEY_ROTATION_DENIAL_REASON`. */
  approvalsExpired: number
  /** Chats whose `pending_approval` flag was cleared. */
  chats: number
  /** Chats whose approvals expired or whose flag was cleared (sorted, unique, every one of them). */
  chatIds: string[]
}

/** The steps of `rotateWithKeyFile`, for tests that inject a crash after one of them. */
export type RotationStep = 'next-written' | 'transaction' | 'committed' | 'renamed'

/**
 * Test hook: called after each step. A throw after `next-written`, `committed` or `renamed` leaves the files and the
 * database exactly as a crash at that point would; a throw at `transaction` (inside the transaction, before the commit)
 * is a failed transaction: it rolls back and `.next` is removed.
 */
export type RotationHook = (step: RotationStep) => void | Promise<void>

/** The SQL condition of a message that may hold an open approval (`approval-requested` / `approval-responded`). */
const MAY_HOLD_APPROVAL = sql`instr(${messages.parts}, '"approval-re') > 0`

/** Messages waiting for a tool approval (`KeyStatus.pendingApprovals`). */
export async function countPendingApprovals(db: DbExecutor): Promise<number> {
  const rows = await db.select({ parts: messages.parts }).from(messages).where(MAY_HOLD_APPROVAL)
  return rows.filter(row => Array.isArray(row.parts) && (row.parts as HarnessUIMessagePart[]).some(isOpenApproval)).length
}

/** Re-encrypts the secrets (see the file comment); returns the counts of rewritten and skipped rows. */
async function reencryptSecrets(tx: DbExecutor, oldKeyring: Keyring, newKeyring: Keyring): Promise<{ secrets: number, skippedSecrets: number }> {
  const oldVersion = oldKeyring.keyVersion
  const newVersion = newKeyring.keyVersion
  const rows = await tx
    .select({ scope: secrets.scope, name: secrets.name, ciphertext: secrets.ciphertext, keyVersion: secrets.keyVersion })
    .from(secrets)
  const oldKey = oldKeyring.subkey('encryption')
  const newKey = newKeyring.subkey('encryption')
  let rewritten = 0
  let skipped = 0
  try {
    for (const row of rows) {
      if (row.keyVersion !== oldVersion) {
        skipped += 1
        continue
      }
      const aad = secretAad(row.scope, row.name)
      let value: string
      try {
        value = decryptSecret(oldKey, aad, row.ciphertext)
      }
      catch {
        skipped += 1
        continue
      }
      const ciphertext = encryptSecret(newKey, aad, value)
      await tx
        .update(secrets)
        .set({ ciphertext, keyVersion: newVersion })
        .where(and(eq(secrets.scope, row.scope), eq(secrets.name, row.name)))
      rewritten += 1
    }
  }
  finally {
    oldKey.fill(0)
    newKey.fill(0)
  }
  return { secrets: rewritten, skippedSecrets: skipped }
}

/** Denies every open approval; returns the denied part count and the chats touched. */
async function expireApprovals(tx: DbExecutor, now: number): Promise<{ denied: number, chatIds: Set<string> }> {
  const rows = await tx
    .select({ id: messages.id, chatId: messages.chatId, parts: messages.parts })
    .from(messages)
    .where(MAY_HOLD_APPROVAL)
  let denied = 0
  const chatIds = new Set<string>()
  for (const row of rows) {
    if (!Array.isArray(row.parts))
      continue
    const result = denyOpenApprovals(row.parts as HarnessUIMessagePart[], KEY_ROTATION_DENIAL_REASON)
    if (result.denied === 0)
      continue
    await tx.update(messages).set({ parts: result.parts, updatedAt: now }).where(eq(messages.id, row.id))
    denied += result.denied
    chatIds.add(row.chatId)
  }
  return { denied, chatIds }
}

/**
 * The rotation transaction (see the file comment). `newKeyring.keyVersion` must be `oldKeyring.keyVersion + 1`; call
 * it with the transaction object only (`db.transaction(tx => rotateSecretsTx(tx, ...))`).
 */
export async function rotateSecretsTx(tx: DbExecutor, oldKeyring: Keyring, newKeyring: Keyring, now: number): Promise<SecretsRotation> {
  if (newKeyring.keyVersion !== oldKeyring.keyVersion + 1)
    throw new Error(`The new key version must be ${oldKeyring.keyVersion + 1}, not ${newKeyring.keyVersion}.`)
  const counts = await reencryptSecrets(tx, oldKeyring, newKeyring)
  const approvals = await expireApprovals(tx, now)
  const cleared = await tx
    .update(chats)
    .set({ pendingApproval: false })
    .where(eq(chats.pendingApproval, true))
    .returning({ id: chats.id })
  for (const { id } of cleared)
    approvals.chatIds.add(id)

  const state: KeyState = { version: newKeyring.keyVersion, check: keyCheckOf(newKeyring), rotatedAt: now }
  await tx
    .insert(settings)
    .values({ key: KEY_STATE_SETTING, value: state, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value: state, updatedAt: now } })

  return {
    keyVersion: state.version,
    rotatedAt: now,
    secrets: counts.secrets,
    skippedSecrets: counts.skippedSecrets,
    approvalsExpired: approvals.denied,
    chats: cleared.length,
    chatIds: [...approvals.chatIds].sort(),
  }
}

/** Removes a file; true when it existed. */
function removeFile(path: string): boolean {
  try {
    unlinkSync(path)
    return true
  }
  catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'ENOENT')
      return false
    throw error
  }
}

/** Renames `secret.key.next` over `secret.key` and makes the rename durable. */
export function promoteNextKeyFile(env: Pick<Env, 'paths'>): void {
  renameSync(nextKeyPath(env), env.paths.secretKey)
  syncDirectory(dirname(env.paths.secretKey))
}

export interface KeyFileRotationInput {
  readonly db: Db
  readonly env: Pick<Env, 'paths'>
  readonly logger: Logger
  /** The keyring of the key in use (its version is the old version). */
  readonly oldKeyring: Keyring
  /** A keyring over the new key at the old version + 1. */
  readonly newKeyring: Keyring
  /** The new 32-byte master key (written to `secret.key.next`; not retained). */
  readonly newKey: Uint8Array
  readonly now: number
  readonly onStep?: RotationHook
}

export interface KeyFileRotation extends SecretsRotation {
  /** `secret.key` holds the new key now (false: the rename failed and the next boot finishes it). */
  renamed: boolean
}

/**
 * A `secret.key.next` left before this rotation: when it holds the key in use (an earlier rotation committed but its
 * rename failed), the rename is finished now; anything else is not needed by anyone (the key in use matches the stored
 * check) and is removed.
 */
function settleLeftoverNextKey(input: KeyFileRotationInput): void {
  const path = nextKeyPath(input.env)
  if (!existsSync(path))
    return
  let leftover: Uint8Array | null = null
  try {
    leftover = readMasterKeyFile(path)
  }
  catch {
    // Unreadable or invalid: not a key anyone can use.
  }
  try {
    if (leftover !== null && sameKeyCheck(keyCheckOfMasterKey(leftover), keyCheckOf(input.oldKeyring))) {
      promoteNextKeyFile(input.env)
      input.logger.warn('finished the rename of an earlier key rotation (secret.key.next held the key in use)', { path })
    }
    else {
      removeFile(path)
      syncDirectory(dirname(path))
      input.logger.warn('removed a stale secret.key.next before the key rotation', { path })
    }
  }
  finally {
    leftover?.fill(0)
  }
}

/**
 * The write-ahead file rotation (see the file comment). Throws when `.next` cannot be written (nothing changed) or the
 * transaction fails (`.next` removed, nothing changed); never throws after the commit (a failed rename is logged), except
 * when a test hook does.
 */
export async function rotateWithKeyFile(input: KeyFileRotationInput): Promise<KeyFileRotation> {
  const { db, env, logger, onStep } = input
  const path = nextKeyPath(env)
  settleLeftoverNextKey(input)
  writeMasterKeyFile(path, input.newKey)
  await onStep?.('next-written')

  let rotation: SecretsRotation
  try {
    rotation = await db.transaction(async (tx) => {
      const result = await rotateSecretsTx(tx, input.oldKeyring, input.newKeyring, input.now)
      await onStep?.('transaction')
      return result
    })
  }
  catch (error) {
    try {
      removeFile(path)
      syncDirectory(dirname(path))
    }
    catch (cleanupError) {
      // The next boot removes it: the stored check still names the old key.
      logger.error('cannot remove secret.key.next after a failed key rotation', { path, err: cleanupError })
    }
    throw error
  }
  await onStep?.('committed')

  let renamed = true
  try {
    promoteNextKeyFile(env)
  }
  catch (error) {
    renamed = false
    logger.error('cannot replace secret.key with secret.key.next; the next start finishes the rotation', { path, err: error })
  }
  if (renamed)
    await onStep?.('renamed')
  return { ...rotation, renamed }
}
