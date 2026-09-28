// Subresource integrity (SRI) checks of downloaded archives: npm tarballs are verified against `dist.integrity`
// (sha512), URL installs against the `integrity` the user supplied (`sha256-` or `sha512-`). Verification happens on
// the downloaded bytes, before anything is decompressed or extracted.
import { Buffer } from 'node:buffer'
import { createHash, timingSafeEqual } from 'node:crypto'

export type SriAlgorithm = 'sha256' | 'sha384' | 'sha512'

const DIGEST_BYTES: Record<SriAlgorithm, number> = { sha256: 32, sha384: 48, sha512: 64 }
const STRENGTH: Record<SriAlgorithm, number> = { sha256: 1, sha384: 2, sha512: 3 }

export interface SriHash {
  algorithm: SriAlgorithm
  digest: Buffer
}

function isAlgorithm(value: string): value is SriAlgorithm {
  return Object.hasOwn(DIGEST_BYTES, value)
}

/**
 * The hashes of an SRI string (`sha512-<base64>`, several separated by whitespace, `?options` ignored) whose algorithm
 * is in `allowed` and whose digest has the right length. Malformed tokens are skipped.
 */
export function parseIntegrity(value: string, allowed: readonly SriAlgorithm[]): SriHash[] {
  const hashes: SriHash[] = []
  for (const token of value.trim().split(/\s+/)) {
    const dash = token.indexOf('-')
    if (dash <= 0)
      continue
    const algorithm = token.slice(0, dash).toLowerCase()
    if (!isAlgorithm(algorithm) || !allowed.includes(algorithm))
      continue
    const encoded = token.slice(dash + 1).split('?')[0] ?? ''
    if (!/^[\d+/a-z]+={0,2}$/i.test(encoded))
      continue
    const digest = Buffer.from(encoded, 'base64')
    if (digest.length !== DIGEST_BYTES[algorithm])
      continue
    hashes.push({ algorithm, digest })
  }
  return hashes
}

/**
 * True when `data` matches the strongest allowed algorithm of `integrity` (SRI semantics: any hash of that algorithm
 * may match). False when `integrity` has no usable hash.
 */
export function verifyIntegrity(data: Uint8Array, integrity: string, allowed: readonly SriAlgorithm[]): boolean {
  const hashes = parseIntegrity(integrity, allowed)
  if (hashes.length === 0)
    return false
  const strongest = Math.max(...hashes.map(hash => STRENGTH[hash.algorithm]))
  const candidates = hashes.filter(hash => STRENGTH[hash.algorithm] === strongest)
  const actual = createHash(candidates[0]!.algorithm).update(data).digest()
  return candidates.some(hash => hash.digest.length === actual.length && timingSafeEqual(hash.digest, actual))
}

/** The SRI string of `data` (tests and diagnostics). */
export function integrityOf(data: Uint8Array, algorithm: SriAlgorithm = 'sha512'): string {
  return `${algorithm}-${createHash(algorithm).update(data).digest('base64')}`
}
