// Errors of the share service (ADR-025, API.md 5.20). Owner: W5.4.
//
// Every failure of the public routes is the same `404 not_found` with the same message (a malformed, unknown, bad-MAC,
// revoked or expired token, a deleted chat, a file outside the share). The routes still need to know which failures
// were about the token itself, because those count against the invalid-token rate limit (ARCHITECTURE.md 10.7): the
// service marks them in a private `WeakSet`, so nothing about the reason reaches the response.
import { HarnessError, LIMITS } from '@harness-forge/shared'

/** Message of every `not_found` answered by the public share routes. */
export const SHARE_UNAVAILABLE_MESSAGE = 'This share link is unavailable.'

/** Why a public share request failed: the token (counts as an invalid token) or only the requested file. */
export type ShareUnavailableReason = 'token' | 'file'

const invalidTokenErrors = new WeakSet<object>()

/** The uniform `not_found` of the public share routes. */
export function shareUnavailableError(reason: ShareUnavailableReason): HarnessError {
  const error = new HarnessError({ code: 'not_found', message: SHARE_UNAVAILABLE_MESSAGE })
  if (reason === 'token')
    invalidTokenErrors.add(error)
  return error
}

/** True for a `shareUnavailableError('token')`: the request named no live share (rate-limited per address). */
export function isInvalidShareTokenError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && invalidTokenErrors.has(error)
}

/** `not_found` of the owner routes (`PATCH` / `DELETE /shares/:id`). */
export function shareNotFoundError(id: string): HarnessError {
  return new HarnessError({ code: 'not_found', message: `Share ${id} not found.` })
}

/** `not_found` for a chat that does not exist (same message as the chats service). */
export function chatNotFoundError(chatId: string): HarnessError {
  return new HarnessError({ code: 'not_found', message: `Chat ${chatId} not found.` })
}

/** `payload_too_large` for a snapshot above `LIMITS.shareSnapshotBytes`. */
export function snapshotTooLargeError(): HarnessError {
  return new HarnessError({
    code: 'payload_too_large',
    message: `This chat is too large to share: a snapshot is limited to ${LIMITS.shareSnapshotBytes / 1024 / 1024} MB.`,
    details: { limitBytes: LIMITS.shareSnapshotBytes },
  })
}
