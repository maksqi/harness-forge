import type { MemoryLogger } from '../logger.ts'
import type { AppDeps } from '../types.ts'
import type { Redactor } from './types.ts'
import { Buffer } from 'node:buffer'
import { createHash, hkdfSync, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { loadEnv } from '../env.ts'
import { createMemoryLogger } from '../logger.ts'
import { createTestApp } from '../testing/create-test-app.ts'
import { createFakeKeyring as createRotatableFakeKeyring, fakeMasterKey } from '../testing/fake-keyring.ts'
import { createFakeKeyring } from '../testing/fakes.ts'
import {
  beginKeyChange,
  createKeyring,
  createMasterKeyring,
  decodeMasterKey,
  deriveSubkey,
  encodeMasterKey,
  HKDF_SALT,
  isKeyChanging,
  isRotatableKeyring,
  KeyringError,
  loadMasterKey,
  MASTER_KEY_BYTES,
  swapMasterKey,
  whenKeyStable,
} from './keyring.ts'
import { createRedactor } from './redact.ts'
import { SUBKEY_NAMES } from './types.ts'

const posix = process.platform !== 'win32'
const cleanups: (() => void | Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
})

function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-forge-keyring-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

interface KeyringDeps {
  deps: AppDeps
  logs: MemoryLogger
  redactor: Redactor
  secretKeyPath: string
}

/** The inputs `createKeyring` reads (`env`, `logger`, `redactor`), with `masterKey` set directly (bypassing env.ts). */
function keyringDeps(dataDir: string, masterKey: string | null = null): KeyringDeps {
  const env = { ...loadEnv({ HF_DATA_DIR: dataDir }, { cwd: dataDir }), masterKey }
  const redactor = createRedactor()
  const logs = createMemoryLogger({ redactor })
  const deps = { env, logger: logs.logger, redactor } as unknown as AppDeps
  return { deps, logs, redactor, secretKeyPath: env.paths.secretKey }
}

function mode(path: string): number {
  return statSync(path).mode & 0o777
}

describe('subkeys', () => {
  it('derives HKDF-SHA256 subkeys with salt harness-forge/v1 and info = name (same as the fake keyring)', () => {
    const seed = 'keyring-test-seed'
    const master = createHash('sha256').update(seed).digest()
    const keyring = createMasterKeyring(master)
    const fake = createFakeKeyring(seed)
    for (const name of SUBKEY_NAMES) {
      const expected = new Uint8Array(hkdfSync('sha256', master, HKDF_SALT, name, 32))
      expect(keyring.subkey(name)).toEqual(expected)
      expect(keyring.subkey(name)).toEqual(fake.subkey(name))
      expect(keyring.subkey(name)).toHaveLength(32)
    }
    expect(keyring.keyVersion).toBe(1)
  })

  it('gives every subkey name distinct bytes', () => {
    const keyring = createMasterKeyring(randomBytes(32))
    const hex = SUBKEY_NAMES.map(name => Buffer.from(keyring.subkey(name)).toString('hex'))
    expect(new Set(hex).size).toBe(SUBKEY_NAMES.length)
  })

  it('derives the share subkey (ADR-025) like the others: stable and distinct from encryption, session and approval', () => {
    expect(SUBKEY_NAMES).toEqual(['encryption', 'session', 'approval', 'share'])
    const master = randomBytes(32)
    const keyring = createMasterKeyring(master)
    const share = keyring.subkey('share')
    expect(share).toHaveLength(MASTER_KEY_BYTES)
    expect(share).toEqual(new Uint8Array(hkdfSync('sha256', master, HKDF_SALT, 'share', MASTER_KEY_BYTES)))
    // Stable: the same master key always gives the same share subkey (share tokens survive a restart).
    expect(createMasterKeyring(master).subkey('share')).toEqual(share)
    expect(keyring.subkey('share')).toEqual(share)
    for (const other of ['encryption', 'session', 'approval'] as const)
      expect(Buffer.from(keyring.subkey(other)).equals(Buffer.from(share)), other).toBe(false)
    // Another master key gives another share subkey (a new master key invalidates every share link).
    expect(createMasterKeyring(randomBytes(32)).subkey('share')).not.toEqual(share)
  })

  it('pins the derivation with known answers (changing salt, info or length would break stored secrets and links)', () => {
    const keyring = createMasterKeyring(Uint8Array.from({ length: MASTER_KEY_BYTES }, (_value, index) => index))
    const hex = (name: (typeof SUBKEY_NAMES)[number]): string => Buffer.from(keyring.subkey(name)).toString('hex')
    expect(hex('encryption')).toBe('a0dde0c0959b7ff5ad308d8a6a270a0d70b6cbed73ea8e4939c508826d749749')
    expect(hex('session')).toBe('13d1927af2f237c5039e1dc433eecba1399445ab9e2d2e1706ce85a8b11a431c')
    expect(hex('approval')).toBe('0a674c9286f20bb80a73b4175858a92892df61c0dccd715ae5e2b4a5a19bba70')
    expect(hex('share')).toBe('2e01ecf94039a337bc078d0d1cace809b1071370e6970e655dd30f487d20b156')
  })

  it('returns a copy, so a caller cannot alter the key others see', () => {
    const keyring = createMasterKeyring(randomBytes(32))
    const first = keyring.subkey('session')
    const snapshot = new Uint8Array(first)
    first.fill(0)
    expect(keyring.subkey('session')).toEqual(snapshot)
  })

  it('does not keep a reference to the master key buffer', () => {
    const master = randomBytes(32)
    const expected = deriveSubkey(master, 'encryption')
    const keyring = createMasterKeyring(master)
    master.fill(0)
    expect(keyring.subkey('encryption')).toEqual(expected)
  })

  it('rejects unknown subkey names and master keys of the wrong size', () => {
    const keyring = createMasterKeyring(randomBytes(32))
    expect(() => keyring.subkey('nope' as never)).toThrow(KeyringError)
    expect(() => keyring.subkey('__proto__' as never)).toThrow(KeyringError)
    expect(() => createMasterKeyring(randomBytes(16))).toThrow(KeyringError)
  })
})

describe('master key text', () => {
  it('decodes base64 and base64url of exactly 32 bytes', () => {
    const key = randomBytes(32)
    expect(decodeMasterKey(key.toString('base64'))).toEqual(key)
    expect(decodeMasterKey(`  ${key.toString('base64')}\n`)).toEqual(key)
    expect(decodeMasterKey(key.toString('base64url'))).toEqual(key)
    expect(decodeMasterKey(encodeMasterKey(key))).toEqual(key)
  })

  it.each([
    ['empty', ''],
    ['16 bytes', randomBytes(16).toString('base64')],
    ['33 bytes', randomBytes(33).toString('base64')],
    ['hex of 32 bytes', randomBytes(32).toString('hex')],
    ['invalid characters', `${'!'.repeat(43)}=`],
    ['inner whitespace', `${randomBytes(32).toString('base64').slice(0, 20)} ${randomBytes(32).toString('base64').slice(21)}`],
  ])('rejects %s', (_label, text) => {
    expect(decodeMasterKey(text)).toBeNull()
  })
})

describe('createKeyring with HF_MASTER_KEY', () => {
  it('uses the environment key and never creates the key file', () => {
    const key = randomBytes(32)
    const { deps, secretKeyPath } = keyringDeps(tempDataDir(), key.toString('base64'))
    const keyring = createKeyring(deps)
    for (const name of SUBKEY_NAMES)
      expect(keyring.subkey(name)).toEqual(deriveSubkey(key, name))
    expect(existsSync(secretKeyPath)).toBe(false)
  })

  it('accepts the key as parsed by env.ts', () => {
    const key = randomBytes(32)
    const dataDir = tempDataDir()
    const env = loadEnv({ HF_DATA_DIR: dataDir, HF_MASTER_KEY: ` ${key.toString('base64url')} ` }, { cwd: dataDir })
    expect(loadMasterKey(env)).toEqual({ key, source: 'env' })
  })

  it.each([
    ['too short', randomBytes(16).toString('base64')],
    ['too long', randomBytes(48).toString('base64')],
    ['not base64', 'correct horse battery staple'],
  ])('fails the boot for a key that is %s, without echoing it', (_label, value) => {
    const { deps } = keyringDeps(tempDataDir(), value)
    expect(() => createKeyring(deps)).toThrow(KeyringError)
    expect(() => createKeyring(deps)).toThrow(/HF_MASTER_KEY/)
    try {
      createKeyring(deps)
    }
    catch (error) {
      expect((error as Error).message).not.toContain(value)
    }
  })

  it('registers the key with the redactor so it never reaches a log line', () => {
    const key = randomBytes(32).toString('base64')
    const { deps, logs } = keyringDeps(tempDataDir(), key)
    createKeyring(deps)
    deps.logger.info(`leak attempt ${key}`, { copy: key })
    expect(logs.text()).not.toContain(key)
  })

  it('warns when HF_MASTER_KEY differs from an existing key file', () => {
    const dataDir = tempDataDir()
    const fileKeyring = keyringDeps(dataDir)
    createKeyring(fileKeyring.deps)
    const { deps, logs } = keyringDeps(dataDir, randomBytes(32).toString('base64'))
    createKeyring(deps)
    expect(logs.records.some(record => record.level === 'warn' && record.msg.includes('differs'))).toBe(true)
  })

  it('does not warn when HF_MASTER_KEY holds the key of the key file', () => {
    const dataDir = tempDataDir()
    const fileKeyring = keyringDeps(dataDir)
    const first = createKeyring(fileKeyring.deps)
    const text = readFileSync(fileKeyring.secretKeyPath, 'utf8').trim()
    const { deps, logs } = keyringDeps(dataDir, text)
    expect(createKeyring(deps).subkey('encryption')).toEqual(first.subkey('encryption'))
    expect(logs.records.some(record => record.level === 'warn')).toBe(false)
  })
})

describe('createKeyring with the key file', () => {
  it('creates secret.key once (mode 0600) and reuses it on restart', () => {
    const dataDir = tempDataDir()
    const first = keyringDeps(dataDir)
    const keyring = createKeyring(first.deps)
    const path = first.secretKeyPath
    expect(existsSync(path)).toBe(true)
    if (posix)
      expect(mode(path)).toBe(0o600)
    const text = readFileSync(path, 'utf8')
    expect(decodeMasterKey(text)).toHaveLength(MASTER_KEY_BYTES)
    expect(first.logs.records.filter(record => record.msg === 'created the master key file')).toHaveLength(1)
    const mtime = statSync(path).mtimeMs

    const second = keyringDeps(dataDir)
    const restarted = createKeyring(second.deps)
    for (const name of SUBKEY_NAMES)
      expect(restarted.subkey(name)).toEqual(keyring.subkey(name))
    expect(readFileSync(path, 'utf8')).toBe(text)
    expect(statSync(path).mtimeMs).toBe(mtime)
    expect(second.logs.records.some(record => record.msg === 'created the master key file')).toBe(false)
    // No temporary file is left behind.
    expect(readdirSync(dataDir).filter(name => name.startsWith('secret.key'))).toEqual(['secret.key'])
  })

  it('creates the data directory when it does not exist yet', () => {
    const dataDir = join(tempDataDir(), 'nested', 'data')
    const { deps, secretKeyPath } = keyringDeps(dataDir)
    createKeyring(deps)
    expect(existsSync(secretKeyPath)).toBe(true)
  })

  it('never logs the generated key', () => {
    const { deps, logs, secretKeyPath } = keyringDeps(tempDataDir())
    createKeyring(deps)
    const text = readFileSync(secretKeyPath, 'utf8').trim()
    deps.logger.info(`leak attempt ${text}`)
    expect(logs.text()).not.toContain(text)
  })

  it.runIf(posix)('refuses a key file readable by other users', () => {
    const { deps, secretKeyPath } = keyringDeps(tempDataDir())
    createKeyring(deps)
    chmodSync(secretKeyPath, 0o644)
    expect(() => createKeyring(deps)).toThrow(KeyringError)
    expect(() => createKeyring(deps)).toThrow(/chmod 600/)
    chmodSync(secretKeyPath, 0o640)
    expect(() => createKeyring(deps)).toThrow(/mode 640/)
    chmodSync(secretKeyPath, 0o600)
    expect(() => createKeyring(deps)).not.toThrow()
  })

  it.each([
    ['empty', ''],
    ['not base64', 'hello world\n'],
    ['too short', `${randomBytes(16).toString('base64')}\n`],
  ])('refuses a key file that is %s', (_label, content) => {
    const { deps, secretKeyPath } = keyringDeps(tempDataDir())
    writeFileSync(secretKeyPath, content, { mode: 0o600 })
    expect(() => createKeyring(deps)).toThrow(/is invalid/)
  })

  it('refuses a key path that is not a regular file', () => {
    const { deps, secretKeyPath } = keyringDeps(tempDataDir())
    mkdirSync(secretKeyPath, { mode: 0o700 })
    expect(() => createKeyring(deps)).toThrow(/not a regular file/)
  })

  it('accepts a key file written by hand in base64', () => {
    const key = randomBytes(32)
    const { deps, secretKeyPath } = keyringDeps(tempDataDir())
    writeFileSync(secretKeyPath, `${key.toString('base64')}\n`, { mode: 0o600 })
    if (posix)
      chmodSync(secretKeyPath, 0o600)
    expect(createKeyring(deps).subkey('approval')).toEqual(deriveSubkey(key, 'approval'))
  })
})

describe('createKeyring in the app', () => {
  it('is used by createTestApp when requested and keeps its key across restarts', async () => {
    const dataDir = tempDataDir()
    const first = await createTestApp({ dataDir, factories: { keyring: createKeyring }, start: false })
    cleanups.push(() => first.close())
    const session = first.deps.keyring.subkey('session')
    expect(session).toHaveLength(32)
    expect(existsSync(first.env.paths.secretKey)).toBe(true)
    if (posix)
      expect(mode(first.env.paths.secretKey)).toBe(0o600)
    await first.close()

    const second = await createTestApp({ dataDir, factories: { keyring: createKeyring }, start: false })
    cleanups.push(() => second.close())
    expect(second.deps.keyring.subkey('session')).toEqual(session)
  })

  it('fails the app construction for an invalid key file', async () => {
    const dataDir = tempDataDir()
    writeFileSync(join(dataDir, 'secret.key'), 'garbage', { mode: 0o600 })
    await expect(createTestApp({ dataDir, factories: { keyring: createKeyring }, start: false })).rejects.toThrow(KeyringError)
  })
})

describe('rotation controls (Phase 7, ADR-034)', () => {
  /** Resolves with true when `promise` settles within a few macrotask turns. */
  async function settlesSoon(promise: Promise<unknown>): Promise<boolean> {
    let settled = false
    void promise.then(() => {
      settled = true
    })
    for (let index = 0; index < 3; index++)
      await new Promise(resolve => setTimeout(resolve, 0))
    return settled
  }

  it('is one frozen object whose keyVersion is a getter', () => {
    const keyring = createMasterKeyring(randomBytes(32), 4)
    expect(Object.isFrozen(keyring)).toBe(true)
    expect(Object.getOwnPropertyDescriptor(keyring, 'keyVersion')?.get).toBeTypeOf('function')
    expect(keyring.keyVersion).toBe(4)
    expect(() => {
      (keyring as { keyVersion: number }).keyVersion = 9
    }).toThrow(TypeError)
    expect(Object.keys(keyring).sort()).toEqual(['keyVersion', 'subkey'])
    expect(isRotatableKeyring(keyring)).toBe(true)
  })

  it('swapMasterKey changes every subkey and the version in place; copies taken before keep their bytes', () => {
    const before = randomBytes(32)
    const after = randomBytes(32)
    const expected = new Map(SUBKEY_NAMES.map(name => [name, deriveSubkey(after, name)]))
    const keyring = createMasterKeyring(before)
    const old = new Map(SUBKEY_NAMES.map(name => [name, keyring.subkey(name)]))
    swapMasterKey(keyring, after, 2)
    // The keyring keeps no reference to the key it was given.
    after.fill(0)
    expect(keyring.keyVersion).toBe(2)
    for (const name of SUBKEY_NAMES) {
      expect(keyring.subkey(name)).not.toEqual(old.get(name))
      expect(keyring.subkey(name)).toEqual(expected.get(name))
      expect(old.get(name)).toEqual(deriveSubkey(before, name))
    }
  })

  it('derives the new subkeys exactly like a new keyring over the new key', () => {
    const next = randomBytes(32)
    const keyring = createMasterKeyring(randomBytes(32))
    swapMasterKey(keyring, new Uint8Array(next), 3)
    const fresh = createMasterKeyring(next, 3)
    for (const name of SUBKEY_NAMES)
      expect(keyring.subkey(name)).toEqual(fresh.subkey(name))
  })

  it('refuses keyrings it did not create, keys of the wrong size and invalid versions', () => {
    const literal = { keyVersion: 1, subkey: () => new Uint8Array(32) }
    expect(isRotatableKeyring(literal)).toBe(false)
    expect(() => swapMasterKey(literal, randomBytes(32), 2)).toThrow(KeyringError)
    expect(() => beginKeyChange(literal)).toThrow(KeyringError)
    const keyring = createMasterKeyring(randomBytes(32))
    expect(() => swapMasterKey(keyring, randomBytes(16), 2)).toThrow(KeyringError)
    for (const version of [0, -1, 1.5, Number.NaN])
      expect(() => swapMasterKey(keyring, randomBytes(32), version)).toThrow(KeyringError)
    expect(() => createMasterKeyring(randomBytes(32), 0)).toThrow(KeyringError)
    expect(keyring.keyVersion).toBe(1)
  })

  it('whenKeyStable resolves at once when stable and waits for every end() of overlapping key changes', async () => {
    const keyring = createMasterKeyring(randomBytes(32))
    expect(isKeyChanging(keyring)).toBe(false)
    expect(await settlesSoon(whenKeyStable(keyring))).toBe(true)

    const endFirst = beginKeyChange(keyring)
    const endSecond = beginKeyChange(keyring)
    expect(isKeyChanging(keyring)).toBe(true)
    const waiting = whenKeyStable(keyring)
    expect(await settlesSoon(waiting)).toBe(false)
    endFirst()
    endFirst()
    expect(await settlesSoon(waiting)).toBe(false)
    endSecond()
    expect(await settlesSoon(waiting)).toBe(true)
    expect(isKeyChanging(keyring)).toBe(false)
    expect(await settlesSoon(whenKeyStable(keyring))).toBe(true)

    // A new change after a stable period needs its own end().
    const endThird = beginKeyChange(keyring)
    const later = whenKeyStable(keyring)
    expect(await settlesSoon(later)).toBe(false)
    endThird()
    expect(await settlesSoon(later)).toBe(true)
  })

  it('treats a keyring it did not create as always stable', async () => {
    expect(await settlesSoon(whenKeyStable({ keyVersion: 1, subkey: () => new Uint8Array(32) }))).toBe(true)
  })

  it('createKeyring takes the key version recovered at boot', () => {
    const dataDir = tempDataDir()
    const { deps } = keyringDeps(dataDir)
    expect(createKeyring(deps).keyVersion).toBe(1)
    const keyring = createKeyring(deps, { keyVersion: 3 })
    expect(keyring.keyVersion).toBe(3)
    expect(isRotatableKeyring(keyring)).toBe(true)
    expect(() => createKeyring(deps, { keyVersion: 0 })).toThrow(KeyringError)
  })

  it('the frozen deps.keyring keeps returning the same object across a swap', async () => {
    const t = await createTestApp({ start: false, overrides: { keyring: createRotatableFakeKeyring() } })
    cleanups.push(() => t.close())
    const keyring = t.deps.keyring
    const before = keyring.subkey('share')
    swapMasterKey(keyring, fakeMasterKey('rotated'), 2)
    expect(t.deps.keyring).toBe(keyring)
    expect(t.deps.keyring.keyVersion).toBe(2)
    expect(t.deps.keyring.subkey('share')).not.toEqual(before)
    expect(t.deps.keyring.subkey('share')).toEqual(createRotatableFakeKeyring('rotated').subkey('share'))
  })

  it('the fake keyring is rotatable and keeps the Phase 1 - 6 derivation', () => {
    const seed = 'fake-seed'
    const keyring = createRotatableFakeKeyring(seed)
    const master = createHash('sha256').update(seed).digest()
    expect(isRotatableKeyring(keyring)).toBe(true)
    expect(keyring.keyVersion).toBe(1)
    for (const name of SUBKEY_NAMES)
      expect(keyring.subkey(name)).toEqual(new Uint8Array(hkdfSync('sha256', master, HKDF_SALT, name, 32)))
    expect(fakeMasterKey(seed)).toEqual(new Uint8Array(master))
    swapMasterKey(keyring, fakeMasterKey('other'), 2)
    expect(keyring.subkey('encryption')).toEqual(createRotatableFakeKeyring('other').subkey('encryption'))
  })
})
