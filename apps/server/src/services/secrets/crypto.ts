// AES-256-GCM sealing of secret values (ARCHITECTURE.md 10.3). Stored blob: `iv (12 B) || ciphertext || tag (16 B)`;
// the additional authenticated data is the UTF-8 of `<scope>/<name>`, so a blob copied to another row fails to decrypt.
// A blob that fails authentication (other key, other row, tampered bytes) throws `internal_error` with a generic message:
// neither the value nor any key material is ever part of an error.
import { Buffer } from 'node:buffer'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { HarnessError } from '@harness-forge/shared'

export const SECRET_CIPHER = 'aes-256-gcm'
/** Random IV per write. */
export const IV_BYTES = 12
export const TAG_BYTES = 16
const KEY_BYTES = 32

/** Message of the `internal_error` thrown when a stored secret cannot be decrypted. */
export const DECRYPT_FAILED_MESSAGE = 'A stored secret could not be decrypted.'

/** Additional authenticated data of a secret: UTF-8 of `<scope>/<name>`. */
export function secretAad(scope: string, name: string): Buffer {
  return Buffer.from(`${scope}/${name}`, 'utf8')
}

function assertKey(key: Uint8Array): void {
  if (key.length !== KEY_BYTES)
    throw new HarnessError({ code: 'internal_error', message: 'The secret encryption key has an invalid length.' })
}

/** Encrypts `plaintext` (UTF-8) with a fresh random IV. */
export function encryptSecret(key: Uint8Array, aad: Uint8Array, plaintext: string): Buffer {
  assertKey(key)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(SECRET_CIPHER, key, iv, { authTagLength: TAG_BYTES })
  cipher.setAAD(aad)
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([iv, body, cipher.getAuthTag()])
}

/** Decrypts a blob of `encryptSecret`; throws `internal_error` when it cannot be authenticated. */
export function decryptSecret(key: Uint8Array, aad: Uint8Array, blob: Uint8Array): string {
  assertKey(key)
  if (blob.length < IV_BYTES + TAG_BYTES)
    throw new HarnessError({ code: 'internal_error', message: DECRYPT_FAILED_MESSAGE })
  try {
    const iv = blob.subarray(0, IV_BYTES)
    const body = blob.subarray(IV_BYTES, blob.length - TAG_BYTES)
    const tag = blob.subarray(blob.length - TAG_BYTES)
    const decipher = createDecipheriv(SECRET_CIPHER, key, iv, { authTagLength: TAG_BYTES })
    decipher.setAAD(aad)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
  }
  catch {
    // The crypto error says nothing useful ("unable to authenticate data"); keep the envelope generic.
    throw new HarnessError({ code: 'internal_error', message: DECRYPT_FAILED_MESSAGE })
  }
}
