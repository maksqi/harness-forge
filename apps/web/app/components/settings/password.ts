// Password rules of Settings -> General (docs/UI.md 9.4, 8.4; docs/API.md 5.2; ADR-017). `PUT /auth/password` is a
// fresh-auth route: the auth store logs in with the current password first when the session is not fresh, and a
// `403 forbidden` + `action: 'login'` that still slips through (e.g. the window ended in between) is answered by one
// login with the current password and one retry.
import type { AuthStatus } from '@harness-forge/shared'
import type { PasswordChange } from '~/stores/auth'
import { z } from 'zod'
import { toHarnessError } from '~/utils/errors'

export type PasswordDialogMode = 'set' | 'change' | 'remove'

export const PASSWORD_MIN = 8
export const PASSWORD_MAX = 1024

export const newPasswordRule = z
  .string()
  .min(PASSWORD_MIN, `Use at least ${PASSWORD_MIN} characters.`)
  .max(PASSWORD_MAX, `Use at most ${PASSWORD_MAX} characters.`)

export const currentPasswordRule = z.string().min(1, 'Enter your current password.')

/** Where the password stands, for the status line of the password section. */
export function passwordState(status: AuthStatus | null): 'none' | 'settings' | 'env' | 'unknown' {
  if (!status)
    return 'unknown'
  if (!status.enabled)
    return 'none'
  return status.source === 'env' ? 'env' : 'settings'
}

export interface PasswordAuthActions {
  changePassword: (change: PasswordChange) => Promise<AuthStatus>
  login: (password: string) => Promise<AuthStatus>
}

/** `changePassword`, with one login + retry when the server still asks for fresh authentication. */
export async function changePasswordWithFreshAuth(auth: PasswordAuthActions, change: PasswordChange): Promise<AuthStatus> {
  try {
    return await auth.changePassword(change)
  }
  catch (error) {
    const failure = toHarnessError(error)
    if (failure.code !== 'forbidden' || failure.action !== 'login' || !change.current)
      throw error
    await auth.login(change.current)
    return await auth.changePassword(change)
  }
}

/** Seconds to wait from a `rate_limited` error (at least 1). */
export function retryAfterSeconds(retryAfterMs: number | undefined): number {
  return Math.max(1, Math.ceil((retryAfterMs ?? 1000) / 1000))
}

export interface PasswordFailure {
  /** The field the message belongs to, or null for the whole form. */
  field: 'current' | null
  message: string
}

/** User-facing text for a failed password change (docs/UI.md 15: "Wrong password", no blame). */
export function passwordFailure(error: unknown): PasswordFailure {
  const failure = toHarnessError(error)
  switch (failure.code) {
    case 'unauthorized':
    case 'forbidden':
      return { field: 'current', message: 'Wrong password' }
    case 'rate_limited':
      return { field: 'current', message: `Too many attempts. Try again in ${retryAfterSeconds(failure.retryAfterMs)}s.` }
    case 'conflict': {
      const details = failure.details as { reason?: unknown } | undefined
      if (details?.reason === 'env-password')
        return { field: null, message: 'The password is set by HF_PASSWORD on the server. Change it there.' }
      if (details?.reason === 'insecure-bind')
        return { field: null, message: 'This server accepts connections from the network, so it keeps a password. Set HF_INSECURE=1 to allow removing it.' }
      return { field: null, message: failure.message }
    }
    default:
      return { field: null, message: failure.message }
  }
}
