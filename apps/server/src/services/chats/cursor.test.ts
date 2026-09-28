import { Buffer } from 'node:buffer'
import { HarnessError } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { decodeChatCursor, encodeChatCursor } from './cursor.ts'

const CHAT_ID = '0199a8f0-0000-7000-8000-000000000001'

function encodeRaw(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

describe('chat cursor', () => {
  it('round-trips and is an opaque base64url string', () => {
    const cursor = encodeChatCursor({ updatedAt: 1_759_000_000_000, id: CHAT_ID })
    expect(cursor).toMatch(/^[\w-]+$/)
    expect(decodeChatCursor(cursor)).toEqual({ updatedAt: 1_759_000_000_000, id: CHAT_ID })
  })

  it.each([
    ['not base64url', 'a+b/c='],
    ['not JSON', Buffer.from('nope').toString('base64url')],
    ['an object', encodeRaw({ updatedAt: 1, id: CHAT_ID })],
    ['a negative timestamp', encodeRaw([-1, CHAT_ID])],
    ['a fractional timestamp', encodeRaw([1.5, CHAT_ID])],
    ['a bad chat id', encodeRaw([1, 'x'])],
    ['extra entries', encodeRaw([1, CHAT_ID, 3])],
  ])('rejects %s with validation_error on `cursor`', (_label, value) => {
    let error: unknown
    try {
      decodeChatCursor(value)
    }
    catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(HarnessError)
    expect((error as HarnessError).code).toBe('validation_error')
    expect((error as HarnessError).details).toEqual({ issues: [{ path: ['cursor'], message: 'Invalid cursor.', code: 'custom' }] })
  })
})
