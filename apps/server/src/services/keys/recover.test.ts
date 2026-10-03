// Boot recovery of the key state (C16-T3, W7.7-T1): `_keys` is written at the first v1.3 boot when the secrets table is
// empty or a row decrypts, never for a key that reads no row; a stored state gives the keyring version; a key that
// fails the check and an invalid state are logged. The `secret.key.next` table (ARCHITECTURE.md 6.14): a crash injected
// after each step of the write-ahead rotation (`.next` written, the transaction failed, the commit done but not the
// rename, the rename done) is resolved at the next boot. No key text ever reaches a log line.
import type { Database } from '../../db/client.ts'
import type { MemoryLogger } from '../../logger.ts'
import type { KeyRecoveryInput } from './recover.ts'
import type { RotationStep } from './rotate.ts'
import type { KeyState } from './types.ts'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../db/client.ts'
import { migrateDatabase } from '../../db/migrate.ts'
import { secrets, settings } from '../../db/schema.ts'
import { loadEnv } from '../../env.ts'
import { createMemoryLogger } from '../../logger.ts'
import { createKeyring, createMasterKeyring, deriveSubkey, encodeMasterKey, readMasterKeyFile } from '../../security/keyring.ts'
import { createRedactor } from '../../security/redact.ts'
import { decryptSecret, encryptSecret, secretAad } from '../secrets/crypto.ts'
import { keyCheckOfMasterKey } from './check.ts'
import { KeyRecoveryError, nextKeyPath, readKeyState, recoverKeyState } from './recover.ts'
import { rotateWithKeyFile } from './rotate.ts'
import { KEY_STATE_SETTING } from './types.ts'

const cleanups: (() => void)[] = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse())
    cleanup()
})

interface Setup {
  input: KeyRecoveryInput
  logs: MemoryLogger
  database: Database
  dataDir: string
}

async function setup(options: { masterKey?: Uint8Array } = {}): Promise<Setup> {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'hf-keys-recover-')))
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }))
  const env = loadEnv({
    HF_DATA_DIR: dataDir,
    ...(options.masterKey === undefined ? {} : { HF_MASTER_KEY: encodeMasterKey(options.masterKey) }),
  }, { cwd: dataDir })
  const database = await openDatabase({ path: ':memory:' })
  cleanups.push(() => database.close())
  await migrateDatabase(database.db)
  const redactor = createRedactor()
  const logs = createMemoryLogger({ redactor })
  return { input: { env, db: database.db, logger: logs.logger, redactor }, logs, database, dataDir }
}

/** Stores one secret encrypted with `masterKey` at `keyVersion`. */
async function storeSecret(s: Setup, masterKey: Uint8Array, name: string, keyVersion = 1): Promise<void> {
  const key = deriveSubkey(masterKey, 'encryption')
  await s.input.db.insert(secrets).values({
    scope: 'provider:openai',
    name,
    ciphertext: encryptSecret(key, secretAad('provider:openai', name), 'sk-test-value-0000'),
    hint: null,
    keyVersion,
  })
}

async function storedState(s: Setup): Promise<unknown> {
  const [row] = await s.input.db.select({ value: settings.value }).from(settings).where(eq(settings.key, KEY_STATE_SETTING))
  return row?.value
}

function messages(logs: MemoryLogger): unknown[] {
  return logs.records.map(record => record.msg)
}

describe('recoverKeyState: first v1.3 boot', () => {
  it('creates the key file on a new data directory and records the check of an empty secrets table', async () => {
    const s = await setup()
    expect(await recoverKeyState(s.input)).toEqual({ keyVersion: 1 })
    const key = readMasterKeyFile(s.input.env.paths.secretKey)
    expect(key).not.toBeNull()
    expect(await storedState(s)).toEqual({ version: 1, check: keyCheckOfMasterKey(key!), rotatedAt: null })
    expect(messages(s.logs)).toContain('created the master key file')
    expect(messages(s.logs)).toContain('recorded the key check')
    expect(s.logs.text()).not.toContain(encodeMasterKey(key!))
  })

  it('records the check when at least one version-1 row decrypts', async () => {
    const key = randomBytes(32)
    const s = await setup({ masterKey: key })
    await storeSecret(s, randomBytes(32), 'stale')
    await storeSecret(s, key, 'apiKey')
    expect(await recoverKeyState(s.input)).toEqual({ keyVersion: 1 })
    expect(await storedState(s)).toEqual({ version: 1, check: keyCheckOfMasterKey(key), rotatedAt: null })
    // HF_MASTER_KEY never creates a key file.
    expect(existsSync(s.input.env.paths.secretKey)).toBe(false)
    expect(s.logs.text()).not.toContain(encodeMasterKey(key))
  })

  it('records nothing when no row decrypts (a wrong key must not become the recorded one)', async () => {
    const key = randomBytes(32)
    const s = await setup({ masterKey: key })
    await storeSecret(s, randomBytes(32), 'apiKey')
    expect(await recoverKeyState(s.input)).toEqual({ keyVersion: 1 })
    expect(await storedState(s)).toBeUndefined()
    expect(messages(s.logs)).toContain('no stored secret can be decrypted with the master key; the key check is not recorded')
  })

  it('is idempotent: a second boot keeps the recorded state', async () => {
    const s = await setup()
    await recoverKeyState(s.input)
    const first = await storedState(s)
    expect(await recoverKeyState(s.input)).toEqual({ keyVersion: 1 })
    expect(await storedState(s)).toEqual(first)
    expect(messages(s.logs).filter(message => message === 'recorded the key check')).toHaveLength(1)
  })
})

describe('recoverKeyState: a stored state', () => {
  it('returns the stored version for the keyring and does not warn when the check matches', async () => {
    const key = randomBytes(32)
    const s = await setup({ masterKey: key })
    const state: KeyState = { version: 3, check: keyCheckOfMasterKey(key), rotatedAt: 1_759_000_000_000 }
    await s.input.db.insert(settings).values({ key: KEY_STATE_SETTING, value: state })
    const { keyVersion } = await recoverKeyState(s.input)
    expect(keyVersion).toBe(3)
    expect(await readKeyState(s.input.db)).toEqual(state)
    expect(s.logs.records.filter(record => record.level === 'warn')).toEqual([])
    // The keyring factory of main.ts takes it.
    const keyring = createKeyring({ env: s.input.env, logger: s.input.logger, redactor: s.input.redactor } as never, { keyVersion })
    expect(keyring.keyVersion).toBe(3)
  })

  it('warns when the key does not match the stored check (env mode) and keeps the state', async () => {
    const s = await setup({ masterKey: randomBytes(32) })
    const state: KeyState = { version: 2, check: keyCheckOfMasterKey(randomBytes(32)), rotatedAt: 5 }
    await s.input.db.insert(settings).values({ key: KEY_STATE_SETTING, value: state })
    expect(await recoverKeyState(s.input)).toEqual({ keyVersion: 2 })
    expect(s.logs.records.find(record => record.msg === 'the master key does not match the stored key check; stored secrets cannot be decrypted'))
      .toMatchObject({ level: 'warn', source: 'env', keyVersion: 2 })
    expect(await storedState(s)).toEqual(state)
  })

  it('leaves an invalid state unchanged and uses the highest row version', async () => {
    const key = randomBytes(32)
    const s = await setup({ masterKey: key })
    await s.input.db.insert(settings).values({ key: KEY_STATE_SETTING, value: { version: 'two' } })
    await storeSecret(s, key, 'a', 1)
    await storeSecret(s, key, 'b', 4)
    expect(await recoverKeyState(s.input)).toEqual({ keyVersion: 4 })
    expect(await readKeyState(s.input.db)).toBeNull()
    expect(await storedState(s)).toEqual({ version: 'two' })
    expect(messages(s.logs)).toContain('the stored key state is invalid and is left unchanged')
  })
})

/** Decrypts the stored `provider:openai/apiKey` with `masterKey`; null when it does not decrypt. */
async function readSecretWith(s: Setup, masterKey: Uint8Array, name = 'apiKey'): Promise<{ value: string, keyVersion: number } | null> {
  const [row] = await s.input.db.select().from(secrets).where(eq(secrets.name, name))
  if (row === undefined)
    return null
  try {
    return { value: decryptSecret(deriveSubkey(masterKey, 'encryption'), secretAad(row.scope, row.name), row.ciphertext), keyVersion: row.keyVersion }
  }
  catch {
    return null
  }
}

class InjectedCrash extends Error {}

/**
 * A file-mode data directory after its first boot (secret.key, `_keys` v1, one secret), then a rotation that "crashes"
 * right after `crashAt` (`transaction`: the transaction fails instead).
 */
async function rotateAndCrash(crashAt: RotationStep): Promise<{ s: Setup, oldKey: Uint8Array, newKey: Uint8Array, error: unknown }> {
  const s = await setup()
  await recoverKeyState(s.input)
  const oldKey = readMasterKeyFile(s.input.env.paths.secretKey)!
  await storeSecret(s, oldKey, 'apiKey')
  const newKey = randomBytes(32)
  let error: unknown
  try {
    await rotateWithKeyFile({
      db: s.input.db,
      env: s.input.env,
      logger: s.input.logger,
      oldKeyring: createMasterKeyring(oldKey, 1),
      newKeyring: createMasterKeyring(newKey, 2),
      newKey,
      now: 1_759_000_000_000,
      onStep: (step) => {
        if (step === crashAt)
          throw new InjectedCrash(step)
      },
    })
  }
  catch (caught) {
    error = caught
  }
  return { s, oldKey, newKey, error }
}

describe('recoverKeyState: secret.key.next after a crash (W7.7-T1)', () => {
  it('crash after .next was written: the rotation did not commit, .next is deleted with a warning', async () => {
    const { s, oldKey, newKey, error } = await rotateAndCrash('next-written')
    expect(error).toBeInstanceOf(InjectedCrash)
    expect(readMasterKeyFile(nextKeyPath(s.input.env))).toEqual(newKey)
    expect(statSync(nextKeyPath(s.input.env)).mode & 0o777).toBe(0o600)

    expect(await recoverKeyState(s.input)).toEqual({ keyVersion: 1 })
    expect(existsSync(nextKeyPath(s.input.env))).toBe(false)
    expect(readMasterKeyFile(s.input.env.paths.secretKey)).toEqual(oldKey)
    expect(s.logs.records.find(record => record.msg === 'removed secret.key.next: the interrupted key rotation did not commit'))
      .toMatchObject({ level: 'warn' })
    expect(await readSecretWith(s, oldKey)).toEqual({ value: 'sk-test-value-0000', keyVersion: 1 })
    expect(s.logs.text()).not.toContain(encodeMasterKey(newKey))
  })

  it('a failed transaction: nothing committed and .next already removed, the next boot has nothing to do', async () => {
    const { s, oldKey, error } = await rotateAndCrash('transaction')
    expect(error).toBeInstanceOf(InjectedCrash)
    expect(existsSync(nextKeyPath(s.input.env))).toBe(false)
    expect(await storedState(s)).toMatchObject({ version: 1, check: keyCheckOfMasterKey(oldKey) })
    expect(await recoverKeyState(s.input)).toEqual({ keyVersion: 1 })
    expect(readMasterKeyFile(s.input.env.paths.secretKey)).toEqual(oldKey)
    expect(await readSecretWith(s, oldKey)).toEqual({ value: 'sk-test-value-0000', keyVersion: 1 })
    expect(s.logs.records.filter(record => record.level === 'warn' && String(record.msg).includes('secret.key.next'))).toEqual([])
  })

  it('crash after the commit but before the rename: .next is renamed over secret.key', async () => {
    const { s, newKey, error } = await rotateAndCrash('committed')
    expect(error).toBeInstanceOf(InjectedCrash)
    expect(await storedState(s)).toEqual({ version: 2, check: keyCheckOfMasterKey(newKey), rotatedAt: 1_759_000_000_000 })

    expect(await recoverKeyState(s.input)).toEqual({ keyVersion: 2 })
    expect(existsSync(nextKeyPath(s.input.env))).toBe(false)
    expect(readMasterKeyFile(s.input.env.paths.secretKey)).toEqual(newKey)
    expect(statSync(s.input.env.paths.secretKey).mode & 0o777).toBe(0o600)
    expect(s.logs.records.find(record => record.msg === 'finished an interrupted key rotation: secret.key.next replaced secret.key'))
      .toMatchObject({ level: 'info', keyVersion: 2 })
    expect(await readSecretWith(s, newKey)).toEqual({ value: 'sk-test-value-0000', keyVersion: 2 })
    expect(s.logs.text()).not.toContain(encodeMasterKey(newKey))
  })

  it('crash after the rename: secret.key holds the new key, nothing is left to do', async () => {
    const { s, newKey, error } = await rotateAndCrash('renamed')
    expect(error).toBeInstanceOf(InjectedCrash)
    expect(existsSync(nextKeyPath(s.input.env))).toBe(false)
    expect(await recoverKeyState(s.input)).toEqual({ keyVersion: 2 })
    expect(readMasterKeyFile(s.input.env.paths.secretKey)).toEqual(newKey)
    expect(await readSecretWith(s, newKey)).toEqual({ value: 'sk-test-value-0000', keyVersion: 2 })
    expect(s.logs.records.filter(record => record.level === 'warn')).toEqual([])
  })

  it('a completed rotation: the next boot reads version 2 without a warning', async () => {
    const s = await setup()
    await recoverKeyState(s.input)
    const oldKey = readMasterKeyFile(s.input.env.paths.secretKey)!
    await storeSecret(s, oldKey, 'apiKey')
    const newKey = randomBytes(32)
    const result = await rotateWithKeyFile({
      db: s.input.db,
      env: s.input.env,
      logger: s.input.logger,
      oldKeyring: createMasterKeyring(oldKey, 1),
      newKeyring: createMasterKeyring(newKey, 2),
      newKey,
      now: 5,
    })
    expect(result).toMatchObject({ keyVersion: 2, secrets: 1, skippedSecrets: 0, renamed: true })
    expect(await recoverKeyState(s.input)).toEqual({ keyVersion: 2 })
    expect(readMasterKeyFile(s.input.env.paths.secretKey)).toEqual(newKey)
  })

  it('neither file matches the stored check: the boot fails with a message naming both files', async () => {
    const s = await setup()
    await recoverKeyState(s.input)
    unlinkSync(s.input.env.paths.secretKey)
    writeFileSync(s.input.env.paths.secretKey, `${encodeMasterKey(randomBytes(32))}\n`, { mode: 0o600 })
    writeFileSync(nextKeyPath(s.input.env), `${encodeMasterKey(randomBytes(32))}\n`, { mode: 0o600 })
    const error = await recoverKeyState(s.input).then(() => null, (caught: unknown) => caught)
    expect(error).toBeInstanceOf(KeyRecoveryError)
    expect((error as Error).message).toContain(s.input.env.paths.secretKey)
    expect((error as Error).message).toContain(nextKeyPath(s.input.env))
    // Both files are kept for the operator.
    expect(existsSync(nextKeyPath(s.input.env))).toBe(true)
  })

  it('a random secret.key.next next to the right secret.key is removed with a warning', async () => {
    const s = await setup()
    await recoverKeyState(s.input)
    writeFileSync(nextKeyPath(s.input.env), 'not a key\n', { mode: 0o600 })
    expect(await recoverKeyState(s.input)).toEqual({ keyVersion: 1 })
    expect(existsSync(nextKeyPath(s.input.env))).toBe(false)
    expect(messages(s.logs)).toContain('removed secret.key.next: the interrupted key rotation did not commit')
  })

  it('promotes a matching .next even when secret.key is missing (never generates a key over it)', async () => {
    const { s, newKey } = await rotateAndCrash('committed')
    unlinkSync(s.input.env.paths.secretKey)
    s.logs.records.length = 0
    expect(await recoverKeyState(s.input)).toEqual({ keyVersion: 2 })
    expect(readMasterKeyFile(s.input.env.paths.secretKey)).toEqual(newKey)
    expect(messages(s.logs)).not.toContain('created the master key file')
  })

  it('no key state stored: nothing ever committed, .next is removed', async () => {
    const s = await setup()
    writeFileSync(nextKeyPath(s.input.env), `${encodeMasterKey(randomBytes(32))}\n`, { mode: 0o600 })
    expect(await recoverKeyState(s.input)).toEqual({ keyVersion: 1 })
    expect(existsSync(nextKeyPath(s.input.env))).toBe(false)
    expect(messages(s.logs)).toContain('removed secret.key.next: no key rotation committed (no key state is stored)')
  })

  it('an invalid key state: .next is left in place with a warning (cannot decide)', async () => {
    const s = await setup()
    await s.input.db.insert(settings).values({ key: KEY_STATE_SETTING, value: { version: 'two' } })
    writeFileSync(nextKeyPath(s.input.env), `${encodeMasterKey(randomBytes(32))}\n`, { mode: 0o600 })
    await recoverKeyState(s.input)
    expect(existsSync(nextKeyPath(s.input.env))).toBe(true)
    expect(messages(s.logs)).toContain('found secret.key.next but the stored key state is invalid; it is left in place')
  })

  it('env mode ignores a secret.key.next (only the file mode writes it)', async () => {
    const s = await setup({ masterKey: randomBytes(32) })
    writeFileSync(nextKeyPath(s.input.env), `${encodeMasterKey(randomBytes(32))}\n`, { mode: 0o600 })
    await recoverKeyState(s.input)
    expect(existsSync(nextKeyPath(s.input.env))).toBe(true)
    expect(messages(s.logs)).toContain('secret.key.next is ignored while HF_MASTER_KEY is set')
  })
})
