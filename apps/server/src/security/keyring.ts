// Master key + HKDF subkeys (ARCHITECTURE.md 10.3, W1.2-T1). Implements the frozen `Keyring` (./types.ts).
//
// Source of the 32-byte master key, loaded synchronously at boot (`createDeps` builds the keyring eagerly, so an invalid
// key fails the boot with exit code 1):
// 1. `HF_MASTER_KEY`: base64 (or base64url) of exactly 32 bytes;
// 2. else `<dataDir>/secret.key`: base64 text of 32 bytes, generated once with `crypto.randomBytes(32)` and mode 0600.
//    The file is written to a temporary name and hard-linked into place, so it is never partial and never replaces a
//    key another process created first. A group/world accessible key file is refused (POSIX only).
// Subkeys (`SUBKEY_NAMES`: `encryption`, `session`, `approval`, `share`): HKDF-SHA256(masterKey, salt `harness-forge/v1`,
// info = subkey name, 32 bytes), derived eagerly; the master key bytes are then zeroed. `subkey()` returns a fresh copy
// so a caller can never alter the key seen by others.
import type { AppDeps } from '../types.ts'
import type { Keyring, SubkeyName } from './types.ts'
import { Buffer } from 'node:buffer'
import { hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto'
import { closeSync, fchmodSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import process from 'node:process'
import { SUBKEY_NAMES } from './types.ts'

/** Master key and subkey length in bytes. */
export const MASTER_KEY_BYTES = 32
/** HKDF salt shared by every subkey (ARCHITECTURE.md 10.3). */
export const HKDF_SALT = 'harness-forge/v1'
/** `secrets.key_version` of keys encrypted with this keyring (rotation is future work). */
export const KEY_VERSION = 1
/** Permissions of a generated `secret.key`. */
export const KEY_FILE_MODE = 0o600

/** Base64 or base64url text of 32 bytes: 43 characters plus optional padding (same rule as `env.ts`). */
const MASTER_KEY_TEXT = /^[\w+/-]{43}={0,2}$/

/** Link errors of filesystems without hard links: fall back to an exclusive create. */
const NO_HARD_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EMLINK'])

/** An invalid or unreadable master key: the boot fails with this message. */
export class KeyringError extends Error {
  override readonly name = 'KeyringError'
}

/** Where the master key came from: `HF_MASTER_KEY`, an existing `secret.key`, or a `secret.key` created now. */
export type MasterKeySource = 'env' | 'file' | 'generated'

export interface LoadedMasterKey {
  key: Buffer
  source: MasterKeySource
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

/** Decodes the base64 / base64url text of a 32-byte key; null when the text is anything else. */
export function decodeMasterKey(text: string): Buffer | null {
  const value = text.trim()
  if (!MASTER_KEY_TEXT.test(value))
    return null
  // Node's base64 decoder also accepts the URL-safe alphabet.
  const key = Buffer.from(value, 'base64')
  return key.length === MASTER_KEY_BYTES ? key : null
}

/** The base64 text stored in `secret.key` (also accepted by `HF_MASTER_KEY`). */
export function encodeMasterKey(key: Uint8Array): string {
  return Buffer.from(key.buffer, key.byteOffset, key.byteLength).toString('base64')
}

/** HKDF-SHA256 subkey of the master key: salt `harness-forge/v1`, info = subkey name, 32 bytes. */
export function deriveSubkey(masterKey: Uint8Array, name: SubkeyName): Uint8Array {
  return new Uint8Array(hkdfSync('sha256', masterKey, HKDF_SALT, name, MASTER_KEY_BYTES))
}

function isSubkeyName(name: unknown): name is SubkeyName {
  return typeof name === 'string' && (SUBKEY_NAMES as readonly string[]).includes(name)
}

/**
 * A keyring over a 32-byte master key. The subkeys are derived immediately; `masterKey` itself is not retained (the
 * caller may zero it afterwards).
 */
export function createMasterKeyring(masterKey: Uint8Array, keyVersion: number = KEY_VERSION): Keyring {
  if (masterKey.length !== MASTER_KEY_BYTES)
    throw new KeyringError(`The master key must be exactly ${MASTER_KEY_BYTES} bytes.`)
  const subkeys = new Map<SubkeyName, Uint8Array>(SUBKEY_NAMES.map(name => [name, deriveSubkey(masterKey, name)]))
  return Object.freeze({
    keyVersion,
    subkey: (name: SubkeyName): Uint8Array => {
      const key = isSubkeyName(name) ? subkeys.get(name) : undefined
      if (key === undefined)
        throw new KeyringError(`Unknown subkey "${String(name)}".`)
      return new Uint8Array(key)
    },
  })
}

/**
 * Reads `secret.key`: null when the file does not exist. Throws `KeyringError` for anything but a regular file holding
 * the base64 text of 32 bytes, and (POSIX) for a file with any group/world permission bit.
 */
export function readMasterKeyFile(path: string): Buffer | null {
  let stats
  try {
    stats = statSync(path)
  }
  catch (error) {
    if (errorCode(error) === 'ENOENT')
      return null
    throw new KeyringError(`Cannot read the master key file ${path} (${errorCode(error) ?? 'unknown error'}).`)
  }
  if (!stats.isFile())
    throw new KeyringError(`The master key file ${path} is not a regular file.`)
  if (process.platform !== 'win32' && (stats.mode & 0o077) !== 0) {
    const mode = (stats.mode & 0o777).toString(8).padStart(3, '0')
    throw new KeyringError(`The master key file ${path} is accessible by other users (mode ${mode}); run "chmod 600 ${path}".`)
  }
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  }
  catch (error) {
    throw new KeyringError(`Cannot read the master key file ${path} (${errorCode(error) ?? 'unknown error'}).`)
  }
  const key = decodeMasterKey(text)
  if (key === null)
    throw new KeyringError(`The master key file ${path} is invalid: expected the base64 encoding of exactly ${MASTER_KEY_BYTES} bytes.`)
  return key
}

/** Creates `path` exclusively (never replaces a file) with mode 0600 and flushes it to disk. */
function writeNewFile(path: string, data: Buffer): void {
  const fd = openSync(path, 'wx', KEY_FILE_MODE)
  let written = false
  try {
    fchmodSync(fd, KEY_FILE_MODE)
    let offset = 0
    while (offset < data.length)
      offset += writeSync(fd, data, offset, data.length - offset)
    fsyncSync(fd)
    written = true
  }
  finally {
    closeSync(fd)
    if (!written) {
      try {
        unlinkSync(path)
      }
      catch {
        // Nothing to clean up.
      }
    }
  }
}

/** Best effort: makes a new directory entry durable (not supported on every platform). */
function fsyncDirectory(dir: string): void {
  try {
    const fd = openSync(dir, 'r')
    try {
      fsyncSync(fd)
    }
    finally {
      closeSync(fd)
    }
  }
  catch {
    // Windows and some filesystems cannot fsync a directory.
  }
}

/** Writes a new random key file; false when another process created `path` first (its key is kept). */
function createMasterKeyFile(path: string): boolean {
  const dir = dirname(path)
  const raw = randomBytes(MASTER_KEY_BYTES)
  const data = Buffer.from(`${encodeMasterKey(raw)}\n`, 'utf8')
  raw.fill(0)
  const temp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeNewFile(temp, data)
    try {
      // Atomic and exclusive: the key file appears complete or not at all, and an existing key is never replaced.
      linkSync(temp, path)
    }
    catch (error) {
      const code = errorCode(error)
      if (code === 'EEXIST')
        return false
      if (code === undefined || !NO_HARD_LINKS.has(code))
        throw error
      try {
        writeNewFile(path, data)
      }
      catch (fallbackError) {
        if (errorCode(fallbackError) === 'EEXIST')
          return false
        throw fallbackError
      }
    }
  }
  catch (error) {
    throw new KeyringError(`Cannot create the master key file ${path} (${errorCode(error) ?? 'unknown error'}).`)
  }
  finally {
    try {
      unlinkSync(temp)
    }
    catch {
      // Already gone.
    }
    data.fill(0)
  }
  fsyncDirectory(dir)
  return true
}

/** Reads `secret.key`, creating it (0600) when it does not exist yet. */
export function loadOrCreateMasterKeyFile(path: string): LoadedMasterKey {
  const existing = readMasterKeyFile(path)
  if (existing !== null)
    return { key: existing, source: 'file' }
  const created = createMasterKeyFile(path)
  // Read the new file back through the checks of every later boot (regular file, mode 0600, valid content), so a
  // filesystem that ignores permissions fails now rather than at the next restart.
  const key = readMasterKeyFile(path)
  if (key === null)
    throw new KeyringError(`The master key file ${path} disappeared while it was being created.`)
  return { key, source: created ? 'generated' : 'file' }
}

/**
 * The master key from `HF_MASTER_KEY` (wins) or `secret.key` (created when missing). Throws `KeyringError` for an
 * invalid key.
 */
export function loadMasterKey(env: { masterKey: string | null, paths: { secretKey: string } }): LoadedMasterKey {
  if (env.masterKey !== null) {
    const key = decodeMasterKey(env.masterKey)
    if (key === null)
      throw new KeyringError(`HF_MASTER_KEY must be the base64 encoding of exactly ${MASTER_KEY_BYTES} bytes (for example the output of "openssl rand -base64 32").`)
    return { key, source: 'env' }
  }
  return loadOrCreateMasterKeyFile(env.paths.secretKey)
}

/** True when `secret.key` exists and holds a key other than `key` (secrets written with it become unreadable). */
function keyFileDiffers(path: string, key: Buffer): boolean {
  try {
    const other = decodeMasterKey(readFileSync(path, 'utf8'))
    return other !== null && !timingSafeEqual(other, key)
  }
  catch {
    return false
  }
}

export function createKeyring(deps: AppDeps): Keyring {
  const { env, logger, redactor } = deps
  const { key, source } = loadMasterKey(env)
  try {
    // Never let the key text reach a log line.
    redactor.addSecret(encodeMasterKey(key))
    if (env.masterKey !== null)
      redactor.addSecret(env.masterKey)
    if (source === 'env' && keyFileDiffers(env.paths.secretKey, key)) {
      logger.warn('HF_MASTER_KEY differs from the master key file; secrets encrypted with the file key cannot be decrypted', {
        path: env.paths.secretKey,
      })
    }
    if (source === 'generated')
      logger.info('created the master key file', { path: env.paths.secretKey })
    else
      logger.debug('master key loaded', { source })
    return createMasterKeyring(key)
  }
  finally {
    key.fill(0)
  }
}
