// Share link tokens (ADR-025, DECISIONS.md "Identifiers", ARCHITECTURE.md 6.10). Owner: W5.4 (W5.4-T1).
//
// token = the 16-character suffix of the share id (`shr_` + 16 chars) + the first 22 base64url characters of
// `HMAC-SHA256(keyring subkey 'share', 'harness-forge/share/v1:' + shareId)`, i.e. `SHARE_TOKEN_PATTERN`. Nothing
// token-like is stored: the owner's list recomputes it, revoking deletes the row, a new master key invalidates every
// link. Verification recomputes the token from its id suffix and compares the whole string in constant time. Tokens are
// credentials: never log them.
import { Buffer } from 'node:buffer'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { SHARE_ID_PATTERN, SHARE_TOKEN_PATTERN } from '@harness-forge/shared'

/** Domain separation prefix of the MAC input (versioned: a new token format gets a new prefix). */
export const SHARE_TOKEN_MAC_CONTEXT = 'harness-forge/share/v1:'
/** Prefix of share ids. */
export const SHARE_ID_PREFIX = 'shr_'
/** Characters of the share id suffix at the start of a token. */
export const SHARE_TOKEN_ID_CHARS = 16
/** Base64url characters of the MAC at the end of a token (132 bits). */
export const SHARE_TOKEN_MAC_CHARS = 22

export interface ShareTokens {
  /** The token of a share id; throws for a malformed id (a programming error, never request input). */
  readonly tokenOf: (shareId: string) => string
  /** The share id of a well-formed token whose MAC is valid (timing-safe comparison), else null. */
  readonly shareIdOf: (token: string) => string | null
}

/** Token codec over the keyring subkey `share` (`deps.keyring.subkey('share')`). */
export function createShareTokens(key: Uint8Array): ShareTokens {
  const secret = Buffer.from(key)

  function mac(shareId: string): string {
    return createHmac('sha256', secret)
      .update(`${SHARE_TOKEN_MAC_CONTEXT}${shareId}`, 'utf8')
      .digest('base64url')
      .slice(0, SHARE_TOKEN_MAC_CHARS)
  }

  function tokenOf(shareId: string): string {
    if (!SHARE_ID_PATTERN.test(shareId))
      throw new TypeError('Expected a share id "shr_" + 16 characters.')
    return `${shareId.slice(SHARE_ID_PREFIX.length)}${mac(shareId)}`
  }

  function shareIdOf(token: string): string | null {
    if (typeof token !== 'string' || !SHARE_TOKEN_PATTERN.test(token))
      return null
    const shareId = `${SHARE_ID_PREFIX}${token.slice(0, SHARE_TOKEN_ID_CHARS)}`
    // Both strings are 38 ASCII characters here (the pattern), so the buffers have the same length.
    const expected = Buffer.from(tokenOf(shareId), 'utf8')
    const actual = Buffer.from(token, 'utf8')
    return actual.length === expected.length && timingSafeEqual(actual, expected) ? shareId : null
  }

  return { tokenOf, shareIdOf }
}

/** `ShareSummary.path` of a token: the share page of the SPA. */
export function sharePagePath(token: string): string {
  return `/share/${token}`
}

/** The URL of a file of a share (`GET /api/share/:token/files/:fileId`), used in `ShareView` file parts. */
export function shareFileUrl(token: string, fileId: string): string {
  return `/api/share/${token}/files/${fileId}`
}
