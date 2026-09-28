// Fresh authentication for share links (ADR-017, ADR-025, docs/UI.md 7.14 and 8.4): creating and changing a link are
// fresh-auth routes. When the auth store says the session is not fresh, the password prompt (ConfirmPasswordDialog)
// comes first; a `403 forbidden` + `action: 'login'` answer (the window ran out meanwhile) prompts the same way and
// retries once. The password goes to `auth.login()`, which renews the window. Concurrent requests share one prompt;
// closing it cancels them with FreshAuthCancelledError (a cancellation, never shown as an error).
import type { Ref } from 'vue'
import { ref } from 'vue'
import { loginFailure, rateLimitMessage } from '~/components/settings/login'
import { useAuthStore } from '~/stores/auth'
import { toHarnessError } from '~/utils/errors'

/** The user closed the password prompt: the action was cancelled, not failed. */
export class FreshAuthCancelledError extends Error {
  constructor() {
    super('Password confirmation cancelled.')
    this.name = 'FreshAuthCancelledError'
  }
}

export function isFreshAuthCancelled(error: unknown): error is FreshAuthCancelledError {
  return error instanceof FreshAuthCancelledError
}

/** `403 forbidden` with `action: 'login'`: the session is valid but not fresh. */
export function needsFreshAuth(error: unknown): boolean {
  const failure = toHarnessError(error)
  return failure.code === 'forbidden' && failure.action === 'login'
}

export interface ShareFreshAuth {
  /** Bind to ConfirmPasswordDialog `open`. */
  open: Ref<boolean>
  /** Bind to ConfirmPasswordDialog `pending`. */
  pending: Ref<boolean>
  /** Bind to ConfirmPasswordDialog `error` ("Wrong password", the rate-limit text). */
  error: Ref<string | null>
  /** Runs a fresh-auth request: prompts first when the session is not fresh, and once more after a 403 `login`. */
  run: <T>(task: () => Promise<T>) => Promise<T>
  /** ConfirmPasswordDialog `submit`. */
  submit: (password: string) => Promise<void>
  /** ConfirmPasswordDialog `update:open`; closing cancels every waiting request. */
  setOpen: (value: boolean) => void
}

export function useShareFreshAuth(): ShareFreshAuth {
  const auth = useAuthStore()
  const open = ref(false)
  const pending = ref(false)
  const error = ref<string | null>(null)
  let waiting: Promise<boolean> | null = null
  let settle: ((confirmed: boolean) => void) | null = null

  /** Opens the prompt (or joins the open one); resolves true after a successful login, false when closed. */
  function ask(): Promise<boolean> {
    if (waiting)
      return waiting
    error.value = null
    open.value = true
    waiting = new Promise<boolean>((resolve) => {
      settle = (confirmed) => {
        waiting = null
        settle = null
        resolve(confirmed)
      }
    })
    return waiting
  }

  async function confirm(): Promise<void> {
    if (!await ask())
      throw new FreshAuthCancelledError()
  }

  async function run<T>(task: () => Promise<T>): Promise<T> {
    let prompted = false
    if (!auth.fresh) {
      await confirm()
      prompted = true
    }
    try {
      return await task()
    }
    catch (failure) {
      // A refusal right after a successful prompt is not solved by asking again: report it.
      if (prompted || !needsFreshAuth(failure))
        throw failure
      await confirm()
      return await task()
    }
  }

  async function submit(password: string): Promise<void> {
    if (pending.value)
      return
    pending.value = true
    error.value = null
    try {
      await auth.login(password)
      open.value = false
      settle?.(true)
    }
    catch (failure) {
      const view = loginFailure(failure)
      error.value = view.retryAt === null ? (view.message || 'Wrong password') : rateLimitMessage((view.retryAt - Date.now()) / 1000)
    }
    finally {
      pending.value = false
    }
  }

  function setOpen(value: boolean): void {
    if (value || pending.value)
      return
    open.value = false
    error.value = null
    settle?.(false)
  }

  return { open, pending, error, run, submit, setOpen }
}
