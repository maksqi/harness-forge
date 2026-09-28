import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { HarnessError } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { DECRYPT_FAILED_MESSAGE, decryptSecret, encryptSecret, IV_BYTES, secretAad, TAG_BYTES } from './crypto.ts'

const key = randomBytes(32)
const aad = secretAad('provider:openai', 'apiKey')
const plaintext = 'sk-proj-crypto-test-0123456789abcdefghij'

function expectDecryptFailure(run: () => unknown): void {
  let caught: unknown
  try {
    run()
  }
  catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(HarnessError)
  const error = caught as HarnessError
  expect(error.code).toBe('internal_error')
  expect(error.message).toBe(DECRYPT_FAILED_MESSAGE)
  expect(JSON.stringify(error.toJSON())).not.toContain(plaintext)
  expect(error.cause).toBeUndefined()
}

describe('secret encryption (AES-256-GCM)', () => {
  it('round-trips and stores iv || ciphertext || tag', () => {
    const blob = encryptSecret(key, aad, plaintext)
    expect(blob.length).toBe(IV_BYTES + Buffer.byteLength(plaintext) + TAG_BYTES)
    expect(blob.includes(Buffer.from(plaintext))).toBe(false)
    expect(decryptSecret(key, aad, blob)).toBe(plaintext)
  })

  it('round-trips empty and non-ASCII values', () => {
    for (const value of ['', 'päss wörd ✓ 🔑', 'x'.repeat(4096)])
      expect(decryptSecret(key, aad, encryptSecret(key, aad, value))).toBe(value)
  })

  it('uses a fresh random IV for every write', () => {
    const first = encryptSecret(key, aad, plaintext)
    const second = encryptSecret(key, aad, plaintext)
    expect(first.subarray(0, IV_BYTES).equals(second.subarray(0, IV_BYTES))).toBe(false)
    expect(first.equals(second)).toBe(false)
  })

  it('binds the ciphertext to <scope>/<name> (AAD)', () => {
    const blob = encryptSecret(key, aad, plaintext)
    expectDecryptFailure(() => decryptSecret(key, secretAad('provider:openai', 'baseURL'), blob))
    expectDecryptFailure(() => decryptSecret(key, secretAad('provider:anthropic', 'apiKey'), blob))
    expectDecryptFailure(() => decryptSecret(key, secretAad('plugin:openai', 'apiKey'), blob))
  })

  it('detects tampering with the iv, the ciphertext or the tag', () => {
    const blob = encryptSecret(key, aad, plaintext)
    for (const index of [0, IV_BYTES + 1, blob.length - 1]) {
      const tampered = Buffer.from(blob)
      tampered[index] = (tampered[index] ?? 0) ^ 0x01
      expectDecryptFailure(() => decryptSecret(key, aad, tampered))
    }
    expectDecryptFailure(() => decryptSecret(key, aad, blob.subarray(0, blob.length - 1)))
    expectDecryptFailure(() => decryptSecret(key, aad, blob.subarray(0, IV_BYTES + TAG_BYTES - 1)))
    expectDecryptFailure(() => decryptSecret(key, aad, Buffer.concat([blob, Buffer.from([0])])))
  })

  it('fails with another key', () => {
    const blob = encryptSecret(key, aad, plaintext)
    expectDecryptFailure(() => decryptSecret(randomBytes(32), aad, blob))
  })

  it('rejects keys that are not 32 bytes', () => {
    expect(() => encryptSecret(randomBytes(16), aad, plaintext)).toThrow(HarnessError)
    expect(() => decryptSecret(randomBytes(31), aad, encryptSecret(key, aad, plaintext))).toThrow(HarnessError)
  })
})
