import { createHmac } from 'node:crypto'
import { createShareId, SHARE_TOKEN_PATTERN } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { createFakeKeyring } from '../../testing/fakes.ts'
import { createShareTokens, SHARE_TOKEN_MAC_CONTEXT, shareFileUrl, sharePagePath } from './token.ts'

const SHARE_ID = 'shr_AbCdEf0123456789'

function keyOf(seed: string): Uint8Array {
  return createFakeKeyring(seed).subkey('share')
}

describe('share tokens', () => {
  it('are the id suffix + the first 22 base64url characters of the HMAC of the share id', () => {
    const key = keyOf('token-a')
    const token = createShareTokens(key).tokenOf(SHARE_ID)
    const mac = createHmac('sha256', key).update(`${SHARE_TOKEN_MAC_CONTEXT}${SHARE_ID}`).digest('base64url').slice(0, 22)
    expect(SHARE_TOKEN_MAC_CONTEXT).toBe('harness-forge/share/v1:')
    expect(token).toBe(`AbCdEf0123456789${mac}`)
    expect(token).toMatch(SHARE_TOKEN_PATTERN)
    expect(token).toHaveLength(38)
  })

  it('are deterministic per key and differ between keys and ids', () => {
    const first = createShareTokens(keyOf('token-a'))
    const again = createShareTokens(keyOf('token-a'))
    const other = createShareTokens(keyOf('token-b'))
    expect(first.tokenOf(SHARE_ID)).toBe(again.tokenOf(SHARE_ID))
    expect(first.tokenOf(SHARE_ID)).not.toBe(other.tokenOf(SHARE_ID))
    expect(first.tokenOf(SHARE_ID)).not.toBe(first.tokenOf('shr_AbCdEf0123456788'))
    // A token of another master key never verifies (a new master key invalidates every link).
    expect(first.shareIdOf(other.tokenOf(SHARE_ID))).toBeNull()
  })

  it('verify to their share id; any altered character, format or key fails', () => {
    const tokens = createShareTokens(keyOf('token-a'))
    for (let index = 0; index < 20; index++) {
      const id = createShareId()
      const token = tokens.tokenOf(id)
      expect(tokens.shareIdOf(token)).toBe(id)
    }
    const token = tokens.tokenOf(SHARE_ID)
    for (let index = 0; index < token.length; index++) {
      const char = token[index] === 'A' ? 'B' : 'A'
      const altered = `${token.slice(0, index)}${char}${token.slice(index + 1)}`
      expect(tokens.shareIdOf(altered), `position ${index}`).toBeNull()
    }
    for (const malformed of ['', token.slice(0, -1), `${token}A`, `${token.slice(0, -1)}=`, `${token.slice(0, 15)}!${token.slice(16)}`, token.toLowerCase() === token ? token.toUpperCase() : token.toLowerCase()])
      expect(tokens.shareIdOf(malformed)).toBeNull()
    expect(tokens.shareIdOf(42 as unknown as string)).toBeNull()
  })

  it('refuse to derive a token for a malformed share id', () => {
    const tokens = createShareTokens(keyOf('token-a'))
    for (const id of ['shr_short', 'share_AbCdEf0123456789', 'shr_AbCdEf012345678!', ''])
      expect(() => tokens.tokenOf(id), id).toThrow(TypeError)
  })

  it('build the share page path and the share file URL', () => {
    expect(sharePagePath('tok')).toBe('/share/tok')
    expect(shareFileUrl('tok', 'file_0000000000000001')).toBe('/api/share/tok/files/file_0000000000000001')
  })
})
