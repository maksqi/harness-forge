// Fresh authentication for sensitive plugin actions (ADR-017, docs/API.md "Fresh auth", docs/UI.md 8.4): when a
// request fails with `403 forbidden` + `action: 'login'`, ask for the password in ConfirmPasswordDialog, log in
// (`auth.login`, which refreshes `AuthStatus.freshUntil`) and retry the request once. Closing the dialog cancels.
import type { Ref } from 'vue'
import { ref } from 'vue'
import { useAuthStore } from '~/stores/auth'
import { toHarnessError } from '~/utils/errors'

/** Thrown by `run()` when the user closed the password prompt instead of confirming. */
export class FreshAuthCancelledError extends Error {
  constructor() {
    super('Password confirmation was cancelled.')
    this.name = 'FreshAuthCancelledError'
  }
}

export function isFreshAuthCancelled(error: unknown): error is FreshAuthCancelledError {
  return error instanceof FreshAuthCancelledError
}

/** The server asks for a recent login before it runs the request. */
export function needsFreshAuth(error: unknown): boolean {
  const failure = toHarnessError(error)
  return failure.code === 'forbidden' && failure.action === 'login'
}

/** Message under the password field for a failed login ("Wrong password", rate limit). */
export function loginFailureMessage(error: unknown): string {
  const failure = toHarnessError(error)
  if (failure.code === 'unauthorized' || failure.code === 'forbidden')
    return 'Wrong password'
  if (failure.code === 'rate_limited') {
    const seconds = Math.max(1, Math.ceil((failure.retryAfterMs ?? 1000) / 1000))
    return `Too many attempts. Try again in ${seconds}s.`
  }
  return failure.message
}

export interface FreshAuth {
  /** State for ConfirmPasswordDialog. */
  open: Ref<boolean>
  pending: Ref<boolean>
  error: Ref<string | null>
  /** Runs `task`; on a fresh-auth failure asks for the password, logs in and runs it once more. */
  run: <T>(task: () => Promise<T>) => Promise<T>
  /** ConfirmPasswordDialog `submit`. */
  submit: (password: string) => Promise<void>
  /** ConfirmPasswordDialog `update:open`; closing it cancels the waiting `run()`. */
  setOpen: (value: boolean) => void
}

export function useFreshAuth(): FreshAuth {
  const auth = useAuthStore()
  const open = ref(false)
  const pending = ref(false)
  const error = ref<string | null>(null)
  let waiting: { resolve: () => void, reject: (reason: unknown) => void } | null = null

  function prompt(): Promise<void> {
    waiting?.reject(new FreshAuthCancelledError())
    error.value = null
    open.value = true
    return new Promise<void>((resolve, reject) => {
      waiting = { resolve, reject }
    })
  }

  async function run<T>(task: () => Promise<T>): Promise<T> {
    try {
      return await task()
    }
    catch (failure) {
      if (!needsFreshAuth(failure))
        throw failure
      await prompt()
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
    }
    catch (failure) {
      error.value = loginFailureMessage(failure)
      return
    }
    finally {
      pending.value = false
    }
    open.value = false
    const current = waiting
    waiting = null
    current?.resolve()
  }

  function setOpen(value: boolean) {
    if (value || pending.value)
      return
    open.value = false
    error.value = null
    const current = waiting
    waiting = null
    current?.reject(new FreshAuthCancelledError())
  }

  return { open, pending, error, run, submit, setOpen }
}
