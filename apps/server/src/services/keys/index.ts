// Master-key service (Phase 7, ADR-034, API.md 5.23, ARCHITECTURE.md 6.14). Owner: W7.7 (W7.7-T4). Implements
// `KeyService` (./types.ts) behind `createKeyService(deps, options?)`.
//
// - `status()` (`GET /keys`): the key source (`env` = `HF_MASTER_KEY`, `file` = `secret.key`), the live keyring version,
//   the last rotation, the key check of the live key against `_keys`, the secret rows and how many of them the live key
//   cannot read, the share links, the messages waiting for a tool approval and `canRotate`.
// - `rotate()` (`POST /keys/rotate`, file mode only): fresh auth again, `confirm: 'ROTATE'`, `409 env-key`, then under
//   `maintenance.exclusive('key-rotation', ..., { blockRuns: true })` (another operation: `409 busy`): `409
//   key-mismatch` unless the live key matches the stored check, every run stopped, `beginKeyChange` (secret reads and
//   writes wait), a new random key written ahead to `secret.key.next`, one transaction (`rotateSecretsTx`), the rename
//   over `secret.key`, the live swap (`swapMasterKey`; the key buffer zeroed, its text registered with the redactor),
//   `end()`, `key.rotated`, `events.disconnectAll()`, one `master key rotated` log line with the counts. The route issues
//   the caller's new session cookie.
//
// Both members only read the key state: `_keys` is written by the boot recovery (`recoverKeyState`, first v1.3 boot) and
// by a rotation's transaction. When it is missing (no recovery ran, e.g. `createTestApp()`, or every secret was
// unreadable at boot), the state the recovery would record is computed in memory: the live key when the secrets table
// is empty or a row of the live version decrypts, else the key check is `unknown`.
import type { KeyRotateBody, KeyRotationResult, KeyStatus } from '@harness-forge/shared'
import type { AppDeps, SensitiveOperationOptions } from '../../types.ts'
import type { RotationHook } from './rotate.ts'
import type { KeyService, KeyState } from './types.ts'
import { HarnessError, validationError } from '@harness-forge/shared'
import { count } from 'drizzle-orm'
import { chatShares, secrets } from '../../db/schema.ts'
import {
  beginKeyChange,
  createMasterKeyring,
  encodeMasterKey,
  generateMasterKey,
  isRotatableKeyring,
  swapMasterKey,
  whenKeyStable,
} from '../../security/keyring.ts'
import { decryptSecret, secretAad } from '../secrets/crypto.ts'
import { keyCheckOf, sameKeyCheck } from './check.ts'
import { readKeyState } from './recover.ts'
import { countPendingApprovals, KEY_ROTATED_CHAT_IDS_MAX, rotateWithKeyFile } from './rotate.ts'

/** Message of the `409 env-key` refusal. */
export const ENV_KEY_MESSAGE = 'The master key comes from HF_MASTER_KEY and cannot be rotated online. Stop the server and run '
  + '"rotate-key" with HF_NEW_MASTER_KEY set (pnpm key:rotate).'
/** Message of the `409 key-mismatch` refusal. */
export const KEY_MISMATCH_MESSAGE = 'The master key in use does not match the key the secrets were written with; a rotation '
  + 'would lose them. Restore the original key first.'

export interface KeyServiceOptions {
  /** Clock of `rotatedAt` (tests); default `Date.now`. */
  now?: () => number
  /** Test hook of the rotation steps (crash injection, see `RotationHook`). */
  onStep?: RotationHook
}

function envKeyError(): HarnessError {
  return new HarnessError({ code: 'conflict', message: ENV_KEY_MESSAGE, details: { reason: 'env-key' } })
}

function keyMismatchError(): HarnessError {
  return new HarnessError({ code: 'conflict', message: KEY_MISMATCH_MESSAGE, details: { reason: 'key-mismatch' } })
}

export function createKeyService(deps: AppDeps, options: KeyServiceOptions = {}): KeyService {
  const { db, env } = deps
  const logger = deps.logger.child({ component: 'keys' })
  const now = options.now ?? Date.now
  const source = (): KeyStatus['source'] => (env.masterKey === null ? 'file' : 'env')

  /**
   * The stored `_keys`; when it is missing, the state the boot recovery would record (computed in memory, never written:
   * `GET /keys` is read-only): the live key and version when the secrets table is empty or a row of the live version
   * decrypts, else null (unknown).
   */
  async function keyState(): Promise<KeyState | null> {
    const stored = await readKeyState(db)
    if (stored !== undefined)
      return stored
    const counts = await secretCounts()
    if (counts.secrets > 0 && counts.unreadable === counts.secrets)
      return null
    return { version: deps.keyring.keyVersion, check: keyCheckOf(deps.keyring), rotatedAt: null }
  }

  function keyCheckOfState(state: KeyState | null): KeyStatus['keyCheck'] {
    if (state === null)
      return 'unknown'
    return sameKeyCheck(state.check, keyCheckOf(deps.keyring)) ? 'ok' : 'mismatch'
  }

  /** Secret rows, and how many of them the live key cannot read. */
  async function secretCounts(): Promise<{ secrets: number, unreadable: number }> {
    const { keyring } = deps
    const rows = await db
      .select({ scope: secrets.scope, name: secrets.name, ciphertext: secrets.ciphertext, keyVersion: secrets.keyVersion })
      .from(secrets)
    const key = keyring.subkey('encryption')
    let unreadable = 0
    try {
      for (const row of rows) {
        if (row.keyVersion !== keyring.keyVersion) {
          unreadable += 1
          continue
        }
        try {
          decryptSecret(key, secretAad(row.scope, row.name), row.ciphertext)
        }
        catch {
          unreadable += 1
        }
      }
    }
    finally {
      key.fill(0)
    }
    return { secrets: rows.length, unreadable }
  }

  async function shareCount(): Promise<number> {
    const [row] = await db.select({ value: count() }).from(chatShares)
    return Number(row?.value ?? 0)
  }

  async function status(): Promise<KeyStatus> {
    await whenKeyStable(deps.keyring)
    const state = await keyState()
    const keyCheck = keyCheckOfState(state)
    const counts = await secretCounts()
    const keySource = source()
    return {
      source: keySource,
      keyVersion: deps.keyring.keyVersion,
      rotatedAt: state?.rotatedAt ?? null,
      keyCheck,
      secrets: counts.secrets,
      unreadableSecrets: counts.unreadable,
      shares: await shareCount(),
      pendingApprovals: await countPendingApprovals(db),
      canRotate: keySource === 'file' && keyCheck === 'ok' && isRotatableKeyring(deps.keyring),
    }
  }

  /** Stops every run (preparing runs are refused by `stop`); returns the chats whose run was stopped. */
  async function stopRuns(): Promise<string[]> {
    const ids = new Set(await deps.chats.allIds())
    for (const run of deps.runs.active())
      ids.add(run.chatId)
    const holding = [...ids].filter(id => deps.runs.hasRun(id))
    const results = await Promise.all(holding.map(async id => ({ id, stopped: await deps.runs.stop(id) })))
    return results.filter(result => result.stopped).map(result => result.id)
  }

  async function rotateNow(): Promise<KeyRotationResult> {
    const { keyring } = deps
    const state = await keyState()
    if (keyCheckOfState(state) !== 'ok')
      throw keyMismatchError()
    if (!isRotatableKeyring(keyring))
      throw new HarnessError({ code: 'internal_error', message: 'The keyring of this server cannot be rotated.' })

    const stoppedChats = await stopRuns()
    const end = beginKeyChange(keyring)
    try {
      const oldVersion = keyring.keyVersion
      const newVersion = oldVersion + 1
      const newKey = generateMasterKey()
      try {
        // Registered before the key is written anywhere: its text can never reach a log line.
        deps.redactor.addSecret(encodeMasterKey(newKey))
        const newKeyring = createMasterKeyring(newKey, newVersion)
        const rotation = await rotateWithKeyFile({
          db,
          env,
          logger,
          oldKeyring: keyring,
          newKeyring,
          newKey,
          now: now(),
          ...(options.onStep === undefined ? {} : { onStep: options.onStep }),
        })
        swapMasterKey(keyring, newKey, newVersion)

        const shares = await shareCount()
        const result: KeyRotationResult = {
          keyVersion: rotation.keyVersion,
          rotatedAt: rotation.rotatedAt,
          secrets: rotation.secrets,
          skippedSecrets: rotation.skippedSecrets,
          shares,
          approvalsExpired: rotation.approvalsExpired,
          chats: rotation.chats,
          runsStopped: stoppedChats.length,
        }
        const chatIds = [...new Set([...stoppedChats, ...rotation.chatIds])].sort().slice(0, KEY_ROTATED_CHAT_IDS_MAX)
        end()
        logger.info('master key rotated', { ...result, renamed: rotation.renamed })
        deps.events.emit('key.rotated', { keyVersion: result.keyVersion, rotatedAt: result.rotatedAt, chatIds })
        // Every session was signed with the old key: no stream may keep listening under it.
        await deps.events.disconnectAll()
        return result
      }
      finally {
        newKey.fill(0)
      }
    }
    finally {
      end()
    }
  }

  async function rotate(body: KeyRotateBody, sensitive: SensitiveOperationOptions): Promise<KeyRotationResult> {
    sensitive.requireFreshAuth()
    if ((body as { confirm?: unknown }).confirm !== 'ROTATE')
      throw validationError([{ path: ['confirm'], message: 'Type ROTATE to confirm.', code: 'custom' }])
    if (source() === 'env')
      throw envKeyError()
    return deps.maintenance.exclusive('key-rotation', rotateNow, { blockRuns: true })
  }

  return { status, rotate }
}
