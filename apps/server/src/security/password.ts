// Password hashing and the active password (ARCHITECTURE.md 10.1, `PasswordService` of ./types.ts). Owner: W1.1
// (W1.1-T2).
//
// Hash: scrypt (N = 2^15, r = 8, p = 1, 32-byte key, 16-byte random salt, maxmem 64 MiB) encoded as
// `scrypt$15$8$1$<salt b64>$<hash b64>`; verification recomputes with the encoded parameters (bounded, so a tampered
// string cannot make the server allocate huge amounts of memory) and compares with `timingSafeEqual`.
// Source of truth: `HF_PASSWORD` (hashed in memory at boot) wins over the hash stored in secrets (scope `auth`, name
// `password`). Passwords are NFC-normalized before hashing, so the same typed characters always match.
import type { ScryptOptions } from 'node:crypto'
import type { AppDeps } from '../types.ts'
import type { PasswordService, PasswordSource } from './types.ts'
import { Buffer } from 'node:buffer'
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { HarnessError } from '@harness-forge/shared'

/** Secrets scope and name of the stored password hash. */
export const PASSWORD_SECRET_SCOPE = 'auth'
export const PASSWORD_SECRET_NAME = 'password'

export interface ScryptParams {
  /** log2 of the cost parameter N. */
  logN: number
  /** Block size. */
  r: number
  /** Parallelization. */
  p: number
}

/** Parameters of new hashes (ARCHITECTURE.md 10.1). */
export const SCRYPT_PARAMS: Readonly<ScryptParams> = Object.freeze({ logN: 15, r: 8, p: 1 })

const KEY_BYTES = 32
const SALT_BYTES = 16
/** scrypt memory cap (node's default is 32 MiB, too small for N = 2^15 with r = 8 plus overhead). */
const SCRYPT_MAXMEM = 64 * 1024 * 1024

/**
 * Accepted parameter ranges when verifying a hash string. The key length is exact: a shorter scrypt output is a prefix
 * of the full one, so a truncated key must not verify.
 */
const HASH_LIMITS = { logN: [10, 16], r: [1, 16], p: [1, 4], saltBytes: [16, 64], keyBytes: [KEY_BYTES, KEY_BYTES] } as const

const HASH_PATTERN = /^scrypt\$(\d{1,2})\$(\d{1,2})\$(\d{1,2})\$([A-Z0-9+/]+={0,2})\$([A-Z0-9+/]+={0,2})$/i

interface ParsedHash extends ScryptParams {
  salt: Buffer
  key: Buffer
}

function inRange(value: number, [min, max]: readonly [number, number]): boolean {
  return Number.isInteger(value) && value >= min && value <= max
}

/** Base64 that decodes and re-encodes to the same string (rejects non-canonical, tampered encodings). */
function decodeCanonicalBase64(text: string): Buffer | null {
  const bytes = Buffer.from(text, 'base64')
  return bytes.toString('base64') === text ? bytes : null
}

function scryptMemory(params: ScryptParams): number {
  return 128 * params.r * (2 ** params.logN + params.p + 2)
}

function parseHash(encoded: string): ParsedHash | null {
  const match = encoded.match(HASH_PATTERN)
  if (match === null)
    return null
  const [, logN = '', r = '', p = '', saltText = '', keyText = ''] = match
  const params: ScryptParams = { logN: Number(logN), r: Number(r), p: Number(p) }
  if (!inRange(params.logN, HASH_LIMITS.logN) || !inRange(params.r, HASH_LIMITS.r) || !inRange(params.p, HASH_LIMITS.p))
    return null
  if (scryptMemory(params) > SCRYPT_MAXMEM)
    return null
  const salt = decodeCanonicalBase64(saltText)
  const key = decodeCanonicalBase64(keyText)
  if (salt === null || key === null || !inRange(salt.length, HASH_LIMITS.saltBytes) || !inRange(key.length, HASH_LIMITS.keyBytes))
    return null
  return { ...params, salt, key }
}

function deriveKey(password: string, salt: Buffer, keyLength: number, params: ScryptParams): Promise<Buffer> {
  const options: ScryptOptions = { N: 2 ** params.logN, r: params.r, p: params.p, maxmem: SCRYPT_MAXMEM }
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFC'), salt, keyLength, options, (error, key) => {
      if (error)
        reject(error)
      else
        resolve(key)
    })
  })
}

/** `scrypt$<logN>$<r>$<p>$<salt b64>$<hash b64>` with a fresh random salt (`params` only for tests). */
export async function hashPassword(password: string, params: ScryptParams = SCRYPT_PARAMS): Promise<string> {
  const salt = randomBytes(SALT_BYTES)
  const key = await deriveKey(password, salt, KEY_BYTES, params)
  return `scrypt$${params.logN}$${params.r}$${params.p}$${salt.toString('base64')}$${key.toString('base64')}`
}

/** Constant-time check of `password` against an encoded hash; false for a malformed or tampered hash string. */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  if (typeof password !== 'string' || typeof encoded !== 'string')
    return false
  const parsed = parseHash(encoded)
  if (parsed === null)
    return false
  try {
    const key = await deriveKey(password, parsed.salt, parsed.key.length, parsed)
    return key.length === parsed.key.length && timingSafeEqual(key, parsed.key)
  }
  catch {
    return false
  }
}

export function createPasswordService(deps: AppDeps): PasswordService {
  const envPassword = deps.env.password

  // HF_PASSWORD is hashed once, in the background from boot, so logins compare hashes like a stored password does.
  let envHash: Promise<string> | null = null
  const envHashOf = (value: string): Promise<string> => (envHash ??= hashPassword(value))
  if (envPassword !== null)
    envHashOf(envPassword).catch(() => {})

  // The stored hash, cached: `set()` is its only writer. A failing read is not cached and fails the request (closed).
  let storedHash: Promise<string | null> | null = null

  function currentStoredHash(): Promise<string | null> {
    storedHash ??= deps.secrets.get(PASSWORD_SECRET_SCOPE, PASSWORD_SECRET_NAME).catch((error: unknown) => {
      storedHash = null
      throw error
    })
    return storedHash
  }

  async function source(): Promise<PasswordSource | null> {
    if (envPassword !== null)
      return 'env'
    return (await currentStoredHash()) === null ? null : 'settings'
  }

  async function check(candidate: string): Promise<boolean> {
    if (envPassword !== null)
      return verifyPassword(candidate, await envHashOf(envPassword))
    const hash = await currentStoredHash()
    return hash === null ? false : verifyPassword(candidate, hash)
  }

  async function set(newPassword: string | null): Promise<void> {
    if (envPassword !== null) {
      throw new HarnessError({
        code: 'conflict',
        message: 'The password is set by HF_PASSWORD; change or remove it in the server environment.',
        details: { reason: 'env-password' },
      })
    }
    if (newPassword === null) {
      await deps.secrets.delete(PASSWORD_SECRET_SCOPE, PASSWORD_SECRET_NAME)
      storedHash = Promise.resolve(null)
    }
    else {
      const hash = await hashPassword(newPassword)
      await deps.secrets.set(PASSWORD_SECRET_SCOPE, PASSWORD_SECRET_NAME, hash)
      storedHash = Promise.resolve(hash)
    }
    // Every session issued before the change ends (the caller gets a new cookie from `PUT /auth/password`).
    await deps.sessions.revokeAll()
  }

  return {
    hash: password => hashPassword(password),
    verify: verifyPassword,
    source,
    check,
    set,
  }
}
