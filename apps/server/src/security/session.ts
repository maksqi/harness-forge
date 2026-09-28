// Stateless `hf_session` tokens (ARCHITECTURE.md 10.1, `SessionService` of ./types.ts). Owner: W1.1 (W1.1-T3).
//
// Token: `v1.<payload b64url>.<HMAC-SHA256 b64url>`; the MAC covers `v1.<payload b64url>` and is keyed with the
// keyring `session` subkey. Payload `{ iat, exp, authAt, epoch }` (ms): `exp = iat + 30 days`; `authAt` is the time of
// the password login of the session chain (fresh auth, ADR-017); `epoch` must equal the internal setting
// `_auth.sessionEpoch`, which `revokeAll()` increments (password change or removal ends every session).
// Cookie attributes and the rolling re-issue live in the HTTP layer (`http/middleware/session-auth.ts`).
import type { AppDeps } from '../types.ts'
import type { SessionPayload, SessionService } from './types.ts'
import { Buffer } from 'node:buffer'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { SESSION_EPOCH_KEY } from '../services/settings/types.ts'

/** Token format version (first dot-separated part). */
export const SESSION_TOKEN_VERSION = 'v1'
/** Lifetime of a token (and `Max-Age` of the cookie): 30 days. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** Longer cookie values are rejected without parsing. */
const MAX_TOKEN_LENGTH = 1024

const BASE64URL = /^[\w-]+$/
const timestamp = z.int().min(0).max(Number.MAX_SAFE_INTEGER)
const payloadSchema = z.strictObject({ iat: timestamp, exp: timestamp, authAt: timestamp, epoch: timestamp })

function sameBytes(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

function parsePayload(encoded: string): SessionPayload | null {
  try {
    const parsed = payloadSchema.safeParse(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')))
    return parsed.success ? parsed.data : null
  }
  catch {
    return null
  }
}

export function createSessionService(deps: AppDeps): SessionService {
  // Resolved on first use: the keyring may not be usable while the server boots without a password.
  let key: Uint8Array | null = null
  const sessionKey = (): Uint8Array => (key ??= deps.keyring.subkey('session'))

  const sign = (data: string): string => createHmac('sha256', sessionKey()).update(data).digest('base64url')

  // The current epoch, cached: `revokeAll()` is its only writer. A failing read is not cached and fails the request.
  let epoch: Promise<number> | null = null

  async function readEpoch(): Promise<number> {
    const value = await deps.settings.getInternal<unknown>(SESSION_EPOCH_KEY)
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
  }

  function currentEpoch(): Promise<number> {
    epoch ??= readEpoch().catch((error: unknown) => {
      epoch = null
      throw error
    })
    return epoch
  }

  async function issue(input: { authAt: number, now?: number }): Promise<string> {
    const now = input.now ?? Date.now()
    const payload: SessionPayload = { iat: now, exp: now + SESSION_TTL_MS, authAt: input.authAt, epoch: await currentEpoch() }
    const body = `${SESSION_TOKEN_VERSION}.${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`
    return `${body}.${sign(body)}`
  }

  async function verify(token: string, now: number = Date.now()): Promise<SessionPayload | null> {
    if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH)
      return null
    const parts = token.split('.')
    if (parts.length !== 3)
      return null
    const [version = '', encodedPayload = '', signature = ''] = parts
    if (version !== SESSION_TOKEN_VERSION || !BASE64URL.test(encodedPayload) || !BASE64URL.test(signature))
      return null
    // The canonical signature string is compared (not the decoded bytes), so no character of it can be altered.
    if (!sameBytes(signature, sign(`${version}.${encodedPayload}`)))
      return null
    const payload = parsePayload(encodedPayload)
    if (payload === null || payload.exp <= now)
      return null
    return payload.epoch === await currentEpoch() ? payload : null
  }

  async function revokeAll(): Promise<number> {
    const next = (await currentEpoch()) + 1
    await deps.settings.setInternal(SESSION_EPOCH_KEY, next)
    epoch = Promise.resolve(next)
    return next
  }

  return { issue, verify, revokeAll }
}
