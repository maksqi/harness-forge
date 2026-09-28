// Cryptographically random helpers over the Web Crypto API (`globalThis.crypto`: browsers and Node >= 19).

export const ALPHANUMERIC = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/** `size` random bytes from `crypto.getRandomValues`. */
export function randomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size)
  globalThis.crypto.getRandomValues(bytes)
  return bytes
}

/** A random string of `length` characters of `alphabet` (at most 256 characters), without modulo bias. */
export function randomString(length: number, alphabet: string = ALPHANUMERIC): string {
  // Largest multiple of the alphabet size that fits in a byte: bytes at or above it are rejected.
  const limit = 256 - (256 % alphabet.length)
  let result = ''
  while (result.length < length) {
    for (const byte of randomBytes((length - result.length) * 2)) {
      if (byte >= limit)
        continue
      result += alphabet.charAt(byte % alphabet.length)
      if (result.length === length)
        break
    }
  }
  return result
}
