// Opaque keyset cursor of `GET /chats` (order `updated_at` desc, `id` desc): base64url of `[updatedAt, id]` of the last
// chat of the previous page. Keyset pagination never repeats or skips a chat whose position did not change, however
// many chats are inserted (they sort before the cursor) or updated meanwhile.
import { Buffer } from 'node:buffer'
import { CHAT_ID_PATTERN, HarnessError } from '@harness-forge/shared'

export interface ChatCursor {
  updatedAt: number
  id: string
}

const BASE64URL = /^[\w-]{1,1024}$/

export function encodeChatCursor(cursor: ChatCursor): string {
  return Buffer.from(JSON.stringify([cursor.updatedAt, cursor.id]), 'utf8').toString('base64url')
}

function invalidCursor(): HarnessError {
  const message = 'Invalid cursor.'
  return new HarnessError({
    code: 'validation_error',
    message: `cursor: ${message}`,
    details: { issues: [{ path: ['cursor'], message, code: 'custom' }] },
  })
}

/** Decodes a cursor of `encodeChatCursor`; anything else throws `validation_error` (path `cursor`). */
export function decodeChatCursor(value: string): ChatCursor {
  if (!BASE64URL.test(value))
    throw invalidCursor()
  let decoded: unknown
  try {
    decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
  }
  catch {
    throw invalidCursor()
  }
  if (!Array.isArray(decoded) || decoded.length !== 2)
    throw invalidCursor()
  const [updatedAt, id] = decoded as [unknown, unknown]
  if (typeof updatedAt !== 'number' || !Number.isSafeInteger(updatedAt) || updatedAt < 0)
    throw invalidCursor()
  if (typeof id !== 'string' || !CHAT_ID_PATTERN.test(id))
    throw invalidCursor()
  return { updatedAt, id }
}
