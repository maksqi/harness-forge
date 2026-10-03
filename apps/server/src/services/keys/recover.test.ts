// Boot recovery of the key state (C16-T3): `_keys` is written at the first v1.3 boot when the secrets table is empty or
// a row decrypts, never for a key that reads no row; a stored state gives the keyring version; a key that fails the
// check, an invalid state and a leftover `secret.key.next` are logged. No key text ever reaches a log line.
import type { Database } from '../../db/client.ts'
import type { MemoryLogger } from '../../logger.ts'
import type { KeyRecoveryInput } from './recover.ts'
import type { KeyState } from './types.ts'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../db/client.ts'
import { migrateDatabase } from '../../db/migrate.ts'
import { secrets, settings } from '../../db/schema.ts'
import { loadEnv } from '../../env.ts'
import { createMemoryLogger } from '../../logger.ts'
import { createKeyring, deriveSubkey, encodeMasterKey, readMasterKeyFile } from '../../security/keyring.ts'
import { createRedactor } from '../../security/redact.ts'
import { encryptSecret, secretAad } from '../secrets/crypto.ts'
import { keyCheckOfMasterKey } from './check.ts'
import { nextKeyPath, readKeyState, recoverKeyState } from './recover.ts'
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

  it('leaves a secret.key.next in place for now and warns (the recovery table is W7.7)', async () => {
    const s = await setup()
    writeFileSync(nextKeyPath(s.input.env), `${encodeMasterKey(randomBytes(32))}\n`, { mode: 0o600 })
    await recoverKeyState(s.input)
    expect(existsSync(nextKeyPath(s.input.env))).toBe(true)
    expect(messages(s.logs)).toContain('found secret.key.next from an interrupted key rotation; it is left in place')
  })
})
