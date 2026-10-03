// Boot recovery of the key state (Phase 7, ADR-034, ARCHITECTURE.md 5 and 6.14). Owner: C16 (C16-T3) and W7.7
// (W7.7-T1: the `secret.key.next` table). Called by `main.ts` after the migrations and before `createDeps`; the keyring
// factory then takes the returned `keyVersion`. The offline `rotate-key` CLI runs it too before it rotates.
//
// 1. File mode (`HF_MASTER_KEY` unset) with a `secret.key.next` left by an interrupted rotation, decided BEFORE the key
//    file is loaded (so a missing `secret.key` is never generated while `.next` may hold the key in use):
//    | the check of `.next` equals the stored check  | the rotation committed: rename `.next` over `secret.key`, fsync |
//    | the check of `secret.key` equals the stored one | the rotation did not commit: delete `.next`, warn              |
//    | `_keys` absent                                  | nothing committed (a commit writes `_keys`): delete, warn       |
//    | `_keys` invalid                                 | cannot decide: `.next` is left in place, warn                   |
//    | neither matches                                 | `KeyRecoveryError` naming both files (the boot fails, exit 1)   |
//    In env mode a `.next` is ignored (warning): only the file mode writes it.
// 2. The master key is loaded like the keyring loads it (`HF_MASTER_KEY`, else `secret.key`, created 0600 when missing)
//    and registered with the redactor; it is zeroed before this function returns.
// 3. `_keys` present and valid: its `version` is the keyring version; a key check that does not match logs a warning
//    (stored secrets cannot be decrypted; `GET /keys` reports `keyCheck: 'mismatch'`).
// 4. `_keys` absent (the first v1.3 boot, or a new data directory): version 1, and `{ version: 1, check, rotatedAt:
//    null }` is written when the secrets table is empty or at least one version-1 row decrypts with the key; otherwise
//    nothing is written (a wrong key must not become the recorded one) and a warning is logged.
// 5. `_keys` present but invalid: a warning, nothing is overwritten, and the version is the highest `key_version` of the
//    secret rows (1 without rows).
import type { Db } from '../../db/client.ts'
import type { Env } from '../../env.ts'
import type { Logger } from '../../logger.ts'
import type { Redactor } from '../../security/types.ts'
import type { KeyState } from './types.ts'
import { existsSync, renameSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { secrets, settings } from '../../db/schema.ts'
import { deriveSubkey, encodeMasterKey, KEY_VERSION, loadMasterKey, readMasterKeyFile, syncDirectory } from '../../security/keyring.ts'
import { decryptSecret, secretAad } from '../secrets/crypto.ts'
import { keyCheckOfMasterKey, keyCheckOfSubkey, parseKeyState, sameKeyCheck } from './check.ts'
import { KEY_STATE_SETTING } from './types.ts'

/** What `recoverKeyState` needs: the values `main.ts` has before `createDeps`. */
export interface KeyRecoveryInput {
  readonly env: Pick<Env, 'masterKey' | 'paths'>
  readonly db: Db
  readonly logger: Logger
  readonly redactor: Redactor
}

/** Result of `recoverKeyState`. */
export interface KeyRecovery {
  /** Version for the keyring (`createKeyring(deps, { keyVersion })`): `_keys.version`, 1 when absent. */
  readonly keyVersion: number
}

/** `<dataDir>/secret.key.next`: the new key written ahead of a rotation's commit (ADR-034). */
export function nextKeyPath(env: Pick<Env, 'paths'>): string {
  return `${env.paths.secretKey}.next`
}

/** The stored `_keys` row: `undefined` when absent, `null` when present but invalid. */
export async function readKeyState(db: Db): Promise<KeyState | null | undefined> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, KEY_STATE_SETTING)).limit(1)
  if (row === undefined)
    return undefined
  return parseKeyState(row.value)
}

/** Writes `_keys` unless a row exists already (never replaces a stored state); true when it was written. */
async function insertKeyState(db: Db, state: KeyState): Promise<boolean> {
  const inserted = await db
    .insert(settings)
    .values({ key: KEY_STATE_SETTING, value: state, updatedAt: Date.now() })
    .onConflictDoNothing({ target: settings.key })
    .returning({ key: settings.key })
  return inserted.length > 0
}

/** The highest `secrets.key_version`, or `KEY_VERSION` without rows. */
async function highestRowVersion(db: Db): Promise<number> {
  const [row] = await db.select({ version: sql<number | null>`max(${secrets.keyVersion})` }).from(secrets)
  const version = Number(row?.version ?? KEY_VERSION)
  return Number.isSafeInteger(version) && version >= 1 ? version : KEY_VERSION
}

/** `empty`: no secret rows; `readable`: a row of `version` decrypts with `encryptionKey`; `unreadable`: none does. */
async function probeSecrets(db: Db, encryptionKey: Uint8Array, version: number): Promise<'empty' | 'readable' | 'unreadable'> {
  const [count] = await db.select({ rows: sql<number>`count(*)` }).from(secrets)
  if (Number(count?.rows ?? 0) === 0)
    return 'empty'
  const rows = await db
    .select({ scope: secrets.scope, name: secrets.name, ciphertext: secrets.ciphertext })
    .from(secrets)
    .where(eq(secrets.keyVersion, version))
  for (const row of rows) {
    try {
      decryptSecret(encryptionKey, secretAad(row.scope, row.name), row.ciphertext)
      return 'readable'
    }
    catch {
      // Another key, or a damaged row: try the next one.
    }
  }
  return 'unreadable'
}

/** The boot cannot tell which key belongs to the database: it fails with this message (exit code 1). */
export class KeyRecoveryError extends Error {
  override readonly name = 'KeyRecoveryError'
}

/** What `resolveNextKeyFile` did with `secret.key.next`. */
export type NextKeyOutcome = 'none' | 'promoted' | 'removed' | 'kept' | 'ignored'

/** Reads a key file for a comparison: null when it is missing, unreadable or invalid (never throws). */
function tryReadKey(path: string): Uint8Array | null {
  try {
    return readMasterKeyFile(path)
  }
  catch {
    return null
  }
}

function matchesCheck(key: Uint8Array | null, check: string): boolean {
  return key !== null && sameKeyCheck(keyCheckOfMasterKey(key), check)
}

/**
 * Step 1 of the file comment: decides what happens to a `secret.key.next` (file mode). Throws `KeyRecoveryError` when
 * neither file matches the stored check. Never logs key material.
 */
export async function resolveNextKeyFile(input: Pick<KeyRecoveryInput, 'env' | 'db'> & { logger: Logger }): Promise<NextKeyOutcome> {
  const { env, db, logger } = input
  const next = nextKeyPath(env)
  if (!existsSync(next))
    return 'none'
  if (env.masterKey !== null) {
    logger.warn('secret.key.next is ignored while HF_MASTER_KEY is set', { path: next })
    return 'ignored'
  }
  const stored = await readKeyState(db)
  if (stored === null) {
    logger.warn('found secret.key.next but the stored key state is invalid; it is left in place', { path: next })
    return 'kept'
  }
  const remove = (message: string): NextKeyOutcome => {
    unlinkSync(next)
    syncDirectory(dirname(next))
    logger.warn(message, { path: next })
    return 'removed'
  }
  if (stored === undefined)
    return remove('removed secret.key.next: no key rotation committed (no key state is stored)')

  const nextKey = tryReadKey(next)
  const currentKey = tryReadKey(env.paths.secretKey)
  try {
    if (matchesCheck(nextKey, stored.check)) {
      renameSync(next, env.paths.secretKey)
      syncDirectory(dirname(env.paths.secretKey))
      logger.info('finished an interrupted key rotation: secret.key.next replaced secret.key', { keyVersion: stored.version })
      return 'promoted'
    }
    if (matchesCheck(currentKey, stored.check))
      return remove('removed secret.key.next: the interrupted key rotation did not commit')
  }
  finally {
    nextKey?.fill(0)
    currentKey?.fill(0)
  }
  throw new KeyRecoveryError(
    `Neither ${env.paths.secretKey} nor ${next} matches the key check stored in the database, so the key of the stored `
    + `secrets is unknown. Keep both files, restore the key file that belongs to this database as ${env.paths.secretKey} `
    + `(and remove ${next}), then start again.`,
  )
}

/**
 * Resolves the key state at boot (see the file comment) and returns the keyring version. Throws `KeyringError` for an
 * invalid or unreadable master key (the boot fails with exit code 1, as it would in `createKeyring`) and
 * `KeyRecoveryError` for a `secret.key.next` that matches no stored check. Never logs key material.
 */
export async function recoverKeyState(input: KeyRecoveryInput): Promise<KeyRecovery> {
  const { env, db, redactor } = input
  const logger = input.logger.child({ component: 'keys' })
  await resolveNextKeyFile({ env, db, logger })
  const { key, source } = loadMasterKey(env)
  const encryptionKey = deriveSubkey(key, 'encryption')
  try {
    redactor.addSecret(encodeMasterKey(key))
    if (source === 'generated')
      logger.info('created the master key file', { path: env.paths.secretKey })
    const mode = source === 'env' ? 'env' : 'file'

    const stored = await readKeyState(db)
    const check = keyCheckOfSubkey(encryptionKey)
    if (stored === null) {
      const keyVersion = await highestRowVersion(db)
      logger.warn('the stored key state is invalid and is left unchanged', { keyVersion })
      return { keyVersion }
    }
    if (stored !== undefined) {
      if (!sameKeyCheck(stored.check, check)) {
        logger.warn('the master key does not match the stored key check; stored secrets cannot be decrypted', {
          source: mode,
          keyVersion: stored.version,
        })
      }
      return { keyVersion: stored.version }
    }

    const probe = await probeSecrets(db, encryptionKey, KEY_VERSION)
    if (probe === 'unreadable') {
      logger.warn('no stored secret can be decrypted with the master key; the key check is not recorded', { source: mode })
      return { keyVersion: KEY_VERSION }
    }
    if (await insertKeyState(db, { version: KEY_VERSION, check, rotatedAt: null }))
      logger.info('recorded the key check', { keyVersion: KEY_VERSION, secrets: probe })
    return { keyVersion: KEY_VERSION }
  }
  finally {
    encryptionKey.fill(0)
    key.fill(0)
  }
}
