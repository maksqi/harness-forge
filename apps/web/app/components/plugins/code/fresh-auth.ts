// Fresh authentication for the code plugin screens (ADR-017, docs/UI.md 7.4 and 8.4): a request answered with
// `403 forbidden` + `action: 'login'` opens `ConfirmPasswordDialog`; its password goes to `auth.login()` (which makes
// the session fresh for 10 minutes) and the request runs once more. Concurrent requests share one prompt.
import type { Ref } from 'vue'
import { ref } from 'vue'
import { loginFailure, rateLimitMessage } from '~/components/settings/login'
import { useAuthStore } from '~/stores/auth'
import { toHarnessError } from '~/utils/errors'

/** The user closed the password prompt: the action was cancelled, not failed (callers show nothing). */
export class FreshAuthCancelledError extends Error {
  constructor() {
    super('Password confirmation cancelled.')
    this.name = 'FreshAuthCancelledError'
  }
}

export function isFreshAuthCancelled(error: unknown): boolean {
  return error instanceof FreshAuthCancelledError
}

/** `403 forbidden` with `action: 'login'`: the session is valid but not fresh. */
export function isFreshAuthRequired(error: unknown): boolean {
  const failure = toHarnessError(error)
  return failure.code === 'forbidden' && failure.action === 'login'
}

export interface FreshAuthPrompt {
  /** Bind to `ConfirmPasswordDialog`. */
  open: Ref<boolean>
  pending: Ref<boolean>
  error: Ref<string | null>
  /** Runs `task`; after a fresh-auth refusal asks for the password, logs in and runs it once more. */
  run: <T>(task: () => Promise<T>) => Promise<T>
  /** `ConfirmPasswordDialog` `submit`. */
  submit: (password: string) => Promise<void>
  /** `ConfirmPasswordDialog` `update:open`. */
  setOpen: (value: boolean) => void
}

export function useFreshAuth(): FreshAuthPrompt {
  const auth = useAuthStore()
  const open = ref(false)
  const pending = ref(false)
  const error = ref<string | null>(null)
  let waiting: Promise<boolean> | null = null
  let settle: ((confirmed: boolean) => void) | null = null

  /** Opens the prompt (or joins the open one); resolves true after a successful login, false when cancelled. */
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
    settle?.(false)
  }

  async function run<T>(task: () => Promise<T>): Promise<T> {
    try {
      return await task()
    }
    catch (failure) {
      if (!isFreshAuthRequired(failure))
        throw failure
      if (!await ask())
        throw new FreshAuthCancelledError()
      return await task()
    }
  }

  return { open, pending, error, run, submit, setOpen }
}
