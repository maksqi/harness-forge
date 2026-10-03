// Key check and the stored key state `_keys` (Phase 7, ADR-034, ARCHITECTURE.md 6.14). Owner: C16 (W7.7 builds on it).
//
// check = base64url(HMAC-SHA256(encryption subkey, 'harness-forge/key-check/v1')): it identifies the master key without
// revealing it, so the server can tell a wrong key from a damaged secret row. Never log a key; a check is not secret
// but there is no reason to log it either.
import type { Keyring } from '../../security/types.ts'
import type { KeyState } from './types.ts'
import { Buffer } from 'node:buffer'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { deriveSubkey } from '../../security/keyring.ts'
import { KEY_CHECK_INFO } from './types.ts'

/** The key check of an `encryption` subkey. */
export function keyCheckOfSubkey(encryptionKey: Uint8Array): string {
  return createHmac('sha256', encryptionKey).update(KEY_CHECK_INFO).digest('base64url')
}

/** The key check of a keyring (its current `encryption` subkey). */
export function keyCheckOf(keyring: Keyring): string {
  const key = keyring.subkey('encryption')
  try {
    return keyCheckOfSubkey(key)
  }
  finally {
    key.fill(0)
  }
}

/** The key check of a raw 32-byte master key (`secret.key`, `secret.key.next`, `HF_MASTER_KEY`). */
export function keyCheckOfMasterKey(masterKey: Uint8Array): string {
  const key = deriveSubkey(masterKey, 'encryption')
  try {
    return keyCheckOfSubkey(key)
  }
  finally {
    key.fill(0)
  }
}

/** Constant-time comparison of two key checks. */
export function sameKeyCheck(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

const timestamp = z.int().min(0).max(Number.MAX_SAFE_INTEGER)

/** Shape of `_keys` (a stored value that does not match is treated as absent and logged). */
export const keyStateSchema = z.object({
  version: z.int().min(1).max(Number.MAX_SAFE_INTEGER),
  check: z.string().regex(/^[\w-]{43}$/),
  rotatedAt: timestamp.nullable(),
})

/** A valid `KeyState`, else null. */
export function parseKeyState(value: unknown): KeyState | null {
  const parsed = keyStateSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
