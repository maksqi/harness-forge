// Offline master-key rotation: `node apps/server/dist/main.mjs rotate-key [--force]` (root script `pnpm key:rotate`;
// Phase 7, ADR-034, ARCHITECTURE.md 6.14). Owner: W7.7 (W7.7-T5).
//
// `main.ts` dispatches on `argv[2] === ROTATE_KEY_COMMAND` before it loads anything else and exits with the code
// `runRotateKeyCommand` resolves: 0 done, 1 failed, 2 refused. Steps:
// 1. Loads `<workspace root>/.env` (variables already set win) and parses the environment like the server.
// 2. Refuses (exit 2) while a server may use the data directory: `GET /api/health` on `HF_HOST:HF_PORT` answers within
//    1 s (`0.0.0.0` is probed as `127.0.0.1`, `::` as `::1`; skipped for `HF_PORT=0`), or `server.lock` names a live
//    process on this host. A lock written on another host (or that cannot be read) is refused unless `--force` is given;
//    `--force` never overrides a live process on this host.
// 3. Opens and migrates the database (it must exist), finishes or drops an interrupted online rotation
//    (`secret.key.next`) and records the key check like the boot does (`recoverKeyState`).
// 4. The old key: `HF_MASTER_KEY`, else `secret.key` (never created here). It must match the stored key check.
// 5. The new key: with `HF_MASTER_KEY` (env mode) `HF_NEW_MASTER_KEY` is required (base64 of 32 bytes, different from
//    the old key); the CLI never generates or prints a key, and afterwards the operator replaces `HF_MASTER_KEY` with it.
//    With `secret.key` (file mode) a new key is generated and the write-ahead flow of the online rotation runs
//    (`secret.key.next`, one transaction, the rename).
// 6. One transaction (`rotateSecretsTx`, shared with the online rotation); a summary on stderr.
// Everything goes to stderr, through the redactor; no key text is ever written.
import type { Env } from '../../env.ts'
import type { LogRecord } from '../../logger.ts'
import type { Keyring } from '../../security/types.ts'
import type { RotationHook, SecretsRotation } from './rotate.ts'
import { Buffer } from 'node:buffer'
import { existsSync } from 'node:fs'
import process from 'node:process'
import { count } from 'drizzle-orm'
import { openDatabase } from '../../db/client.ts'
import { migrateDatabase } from '../../db/migrate.ts'
import { chatShares } from '../../db/schema.ts'
import { EnvError, loadDotEnvFile, loadEnv } from '../../env.ts'
import { createLogger } from '../../logger.ts'
import {
  createMasterKeyring,
  decodeMasterKey,
  encodeMasterKey,
  generateMasterKey,
  readMasterKeyFile,
} from '../../security/keyring.ts'
import { createRedactor } from '../../security/redact.ts'
import { keyCheckOf, sameKeyCheck } from './check.ts'
import { readKeyState, recoverKeyState, resolveNextKeyFile } from './recover.ts'
import { rotateSecretsTx, rotateWithKeyFile } from './rotate.ts'
import { currentHostname, isProcessAlive, readServerLock, serverLockPath } from './server-lock.ts'

/** `argv[2]` that selects the CLI instead of the server. */
export const ROTATE_KEY_COMMAND = 'rotate-key'

/** Exit codes of the CLI. */
export const CLI_EXIT = Object.freeze({ done: 0, failed: 1, refused: 2 })

/** The only option. */
export const FORCE_FLAG = '--force'

/** The variable holding the new key in env mode (CLI only, DECISIONS.md contract seed). */
export const NEW_MASTER_KEY_VARIABLE = 'HF_NEW_MASTER_KEY'

/** Timeout of the `/api/health` probe. */
export const HEALTH_PROBE_TIMEOUT_MS = 1000

/** Prefix of every line the CLI writes. */
export const CLI_PREFIX = `harness-forge ${ROTATE_KEY_COMMAND}:`

export const USAGE = `usage: ${ROTATE_KEY_COMMAND} [${FORCE_FLAG}]  (env mode: set ${NEW_MASTER_KEY_VARIABLE} to the new base64 key)`

export interface RotateKeyCommandIo {
  /** Where the summary and errors go (default `process.stderr`). */
  readonly stderr?: { write: (text: string) => unknown }
  /**
   * Environment variables (default `process.env`, after loading the `.env` file). When given, no `.env` file is loaded
   * unless `envFile` names one.
   */
  readonly vars?: Readonly<Record<string, string | undefined>>
  /** `.env` file loaded into `process.env` first; default: the workspace `.env` when `vars` is not given. */
  readonly envFile?: string | null
  /** Base of a relative `HF_DATA_DIR` (default `process.cwd()`). */
  readonly cwd?: string
  /** Timeout of the health probe (default `HEALTH_PROBE_TIMEOUT_MS`). */
  readonly probeTimeoutMs?: number
  /** Clock of `rotatedAt` (tests). */
  readonly now?: () => number
  /** Test hook of the rotation steps (crash injection). */
  readonly onStep?: RotationHook
}

/** True when `argv` (as `process.argv`) selects the rotation CLI. */
export function isRotateKeyCommand(argv: readonly string[]): boolean {
  return argv[2] === ROTATE_KEY_COMMAND
}

/** A failure with an exit code and a message for the operator (never key material). */
class CliStop extends Error {
  constructor(readonly code: number, message: string) {
    super(message)
  }
}

function refused(message: string): CliStop {
  return new CliStop(CLI_EXIT.refused, message)
}

function failed(message: string): CliStop {
  return new CliStop(CLI_EXIT.failed, message)
}

/** The URL of the health probe, or null when the port is not fixed (`HF_PORT=0`). */
export function healthProbeUrl(env: Pick<Env, 'host' | 'port'>): string | null {
  if (env.port === 0)
    return null
  let host = env.host.trim().replace(/^\[(.*)\]$/, '$1')
  if (host === '0.0.0.0' || host === '')
    host = '127.0.0.1'
  else if (host === '::')
    host = '::1'
  const authority = host.includes(':') ? `[${host}]` : host
  return `http://${authority}:${env.port}/api/health`
}

/** True when something answers the health URL within the timeout (any HTTP answer counts). */
export async function serverAnswers(url: string, timeoutMs: number = HEALTH_PROBE_TIMEOUT_MS): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' })
    await response.body?.cancel().catch(() => {})
    return true
  }
  catch {
    return false
  }
}

/** Step 2 of the file comment: throws `refused` while a server may use the data directory. */
async function assertNoServer(env: Env, force: boolean, timeoutMs: number, warn: (text: string) => void): Promise<void> {
  const url = healthProbeUrl(env)
  if (url !== null && await serverAnswers(url, timeoutMs))
    throw refused(`a server answers at ${url}. Stop the server first, then run ${ROTATE_KEY_COMMAND} again.`)

  const path = serverLockPath(env)
  const lock = readServerLock(path)
  if (lock === null)
    return
  if (lock === 'invalid') {
    if (!force)
      throw refused(`${path} exists but cannot be read. Make sure no server uses ${env.dataDir}, then run again with ${FORCE_FLAG}.`)
    warn(`${FORCE_FLAG}: ignoring the unreadable ${path}.`)
    return
  }
  const here = currentHostname()
  if (lock.hostname === here) {
    if (lock.pid !== process.pid && isProcessAlive(lock.pid))
      throw refused(`${path} names a running process (pid ${lock.pid}). Stop the server first, then run ${ROTATE_KEY_COMMAND} again.`)
    warn(`${path} is stale (pid ${lock.pid} is not running); continuing.`)
    return
  }
  if (!force) {
    throw refused(`${path} was written on another host (${lock.hostname}, pid ${lock.pid}). Make sure that server is stopped, `
      + `then run again with ${FORCE_FLAG}.`)
  }
  warn(`${FORCE_FLAG}: ignoring the lock of host ${lock.hostname} (pid ${lock.pid}).`)
}

function plural(value: number, one: string, many: string = `${one}s`): string {
  return `${value} ${value === 1 ? one : many}`
}

function summary(rotation: SecretsRotation, shares: number): string {
  return `rotated the master key to version ${rotation.keyVersion}: ${plural(rotation.secrets, 'secret')} re-encrypted, `
    + `${rotation.skippedSecrets} unreadable left unchanged, ${plural(shares, 'share link')} changed, `
    + `${plural(rotation.approvalsExpired, 'pending approval')} expired.`
}

/**
 * Runs the CLI with the arguments after `rotate-key` and resolves with the exit code (never rejects; `main.ts` calls
 * `process.exit` with it).
 */
export async function runRotateKeyCommand(args: readonly string[], io: RotateKeyCommandIo = {}): Promise<number> {
  const stderr = io.stderr ?? process.stderr
  const redactor = createRedactor()
  const write = (text: string): void => {
    stderr.write(`${CLI_PREFIX} ${redactor.redactText(text)}\n`)
  }
  const warn = (text: string): void => write(`warning: ${text}`)
  const logger = createLogger({
    level: 'info',
    redactor,
    sink: (record: LogRecord) => write(record.level === 'info' ? record.msg : `${record.level}: ${record.msg}`),
  })

  let close: (() => void) | null = null
  const keys: Uint8Array[] = []
  try {
    const unknown = args.filter(arg => arg !== FORCE_FLAG)
    if (unknown.length > 0)
      throw failed(`unknown argument ${JSON.stringify(unknown[0])}. ${USAGE}`)
    const force = args.includes(FORCE_FLAG)

    // 1. The environment, like the server.
    const envFile = io.envFile === undefined ? (io.vars === undefined ? undefined : null) : io.envFile
    if (envFile !== null) {
      try {
        loadDotEnvFile(envFile)
      }
      catch (error) {
        throw failed(`cannot load the .env file: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const vars = io.vars ?? process.env
    for (const name of ['HF_MASTER_KEY', NEW_MASTER_KEY_VARIABLE, 'HF_PASSWORD']) {
      const value = vars[name]
      if (typeof value === 'string' && value.trim() !== '') {
        redactor.addSecret(value)
        redactor.addSecret(value.trim())
      }
    }
    let env: Env
    try {
      env = loadEnv(vars, io.cwd === undefined ? {} : { cwd: io.cwd })
    }
    catch (error) {
      if (error instanceof EnvError)
        throw failed(error.message)
      throw error
    }
    if (!existsSync(env.paths.db))
      throw failed(`there is no database at ${env.paths.db}: nothing to rotate (check HF_DATA_DIR).`)

    // 2. No server may use the data directory.
    await assertNoServer(env, force, io.probeTimeoutMs ?? HEALTH_PROBE_TIMEOUT_MS, warn)

    // 3. The database, migrated, with an interrupted online rotation settled and the key check recorded.
    const database = await openDatabase({ path: env.paths.db })
    close = () => database.close()
    await migrateDatabase(database.db)
    const mode = env.masterKey === null ? 'file' : 'env'
    if (mode === 'file') {
      await resolveNextKeyFile({ env, db: database.db, logger })
      if (!existsSync(env.paths.secretKey))
        throw failed(`there is no master key file at ${env.paths.secretKey} and HF_MASTER_KEY is not set: nothing to rotate.`)
    }
    else if (existsSync(env.paths.secretKey)) {
      warn(`${env.paths.secretKey} exists but is not used while HF_MASTER_KEY is set; it is left unchanged.`)
    }
    await recoverKeyState({ env, db: database.db, logger, redactor })

    // 4. The old key must be the key of the stored secrets.
    const oldKey = mode === 'env' ? decodeMasterKey(env.masterKey ?? '') : readMasterKeyFile(env.paths.secretKey)
    if (oldKey === null)
      throw failed(mode === 'env' ? 'HF_MASTER_KEY is not a base64 key of 32 bytes.' : `cannot read ${env.paths.secretKey}.`)
    keys.push(oldKey)
    redactor.addSecret(encodeMasterKey(oldKey))
    const stored = await readKeyState(database.db)
    if (stored === undefined || stored === null) {
      throw failed('the key check is not recorded (no stored secret can be decrypted with the current key, or the stored '
        + 'key state is invalid): the key of the stored secrets is unknown, nothing was changed.')
    }
    const oldKeyring: Keyring = createMasterKeyring(oldKey, stored.version)
    if (!sameKeyCheck(stored.check, keyCheckOf(oldKeyring))) {
      throw failed(`the current master key (${mode === 'env' ? 'HF_MASTER_KEY' : env.paths.secretKey}) does not match the key `
        + 'the secrets were written with; rotating would lose them. Nothing was changed.')
    }

    // 5. The new key.
    const newText = vars[NEW_MASTER_KEY_VARIABLE]?.trim() ?? ''
    let newKey: Uint8Array
    if (mode === 'env') {
      if (newText === '') {
        throw failed(`${NEW_MASTER_KEY_VARIABLE} is not set. The key comes from HF_MASTER_KEY, so the new key must be given in `
          + `${NEW_MASTER_KEY_VARIABLE} (for example the output of "openssl rand -base64 32"); it is never generated here.`)
      }
      const decoded = decodeMasterKey(newText)
      if (decoded === null)
        throw failed(`${NEW_MASTER_KEY_VARIABLE} must be the base64 encoding of exactly 32 bytes.`)
      keys.push(decoded)
      if (Buffer.compare(decoded, oldKey) === 0)
        throw failed(`${NEW_MASTER_KEY_VARIABLE} holds the current key; give a new one.`)
      newKey = decoded
    }
    else {
      if (newText !== '')
        warn(`${NEW_MASTER_KEY_VARIABLE} is ignored: the key comes from ${env.paths.secretKey}, so a new key is generated.`)
      newKey = generateMasterKey()
      keys.push(newKey)
    }
    redactor.addSecret(encodeMasterKey(newKey))
    const newKeyring = createMasterKeyring(newKey, stored.version + 1)

    // 6. One transaction (file mode: behind the write-ahead secret.key.next).
    const now = (io.now ?? Date.now)()
    let rotation: SecretsRotation
    if (mode === 'file') {
      rotation = await rotateWithKeyFile({
        db: database.db,
        env,
        logger,
        oldKeyring,
        newKeyring,
        newKey,
        now,
        ...(io.onStep === undefined ? {} : { onStep: io.onStep }),
      })
    }
    else {
      rotation = await database.db.transaction(async (tx) => {
        const result = await rotateSecretsTx(tx, oldKeyring, newKeyring, now)
        await io.onStep?.('transaction')
        return result
      })
    }
    const [shareRow] = await database.db.select({ value: count() }).from(chatShares)
    const shares = Number(shareRow?.value ?? 0)
    write(summary(rotation, shares))
    if (mode === 'env')
      write(`now replace HF_MASTER_KEY with the value of ${NEW_MASTER_KEY_VARIABLE} (then unset ${NEW_MASTER_KEY_VARIABLE}) and start the server.`)
    else
      write(`${env.paths.secretKey} holds the new key; start the server.`)
    return CLI_EXIT.done
  }
  catch (error) {
    if (error instanceof CliStop) {
      write(error.code === CLI_EXIT.refused ? `refused: ${error.message}` : `failed: ${error.message}`)
      return error.code
    }
    write(`failed: ${error instanceof Error ? error.message : String(error)}`)
    return CLI_EXIT.failed
  }
  finally {
    for (const key of keys)
      key.fill(0)
    close?.()
  }
}
