// Fresh authentication (ADR-017; docs/UI.md 8.4, 11.3; docs/API.md "Fresh auth"): the one password prompt behind every
// fresh-auth action of the web app. The server keeps no proof token: a password login (`auth.login()`, `POST
// /api/auth/login`) makes the session fresh for 10 minutes, and outside that window a fresh-auth route answers
// `403 forbidden` + `action: 'login'`. One behavior for every call site:
// - `run(task, { required })`: with `required` (the action is known to need fresh auth) and a session that is not
//   fresh (`needed`), the prompt comes first; otherwise the task runs and a fresh-auth refusal opens the prompt.
// - After a prompt the task runs exactly once more: a second refusal is thrown, for the caller to show.
// - Concurrent tasks share one prompt. Closing it rejects every waiting task with FreshAuthCancelledError, which callers
//   never show; the end of the caller's scope (an unmounted component) cancels too.
// - Prompt errors: 401 "Wrong password", 429 "Too many attempts. Try again in {n}s." counting down, anything else (a
//   403 from the login itself included) the server message.
// Bind `open` / `pending` / `error` / `submit` / `setOpen` to ConfirmPasswordDialog. Inline password fields (the install
// and trust dialogs) call `login(password)`; the "Log in" action of an error alert calls `confirm()`.
import type { ComputedRef, Ref } from 'vue'
import type { LoginFailure } from '~/components/settings/login'
import { computed, onScopeDispose, readonly, ref } from 'vue'
import { loginFailure, rateLimitMessage, secondsUntil } from '~/components/settings/login'
import { useAuthStore } from '~/stores/auth'
import { toHarnessError } from '~/utils/errors'

/** The user closed the password prompt: the action was cancelled, not failed (callers show nothing). */
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
export function isFreshAuthRequired(error: unknown): boolean {
  const failure = toHarnessError(error)
  return failure.code === 'forbidden' && failure.action === 'login'
}

/**
 * Text for a failed `auth.login()`: 401 "Wrong password", 429 "Too many attempts. Try again in {n}s." (the wait left
 * at `now`), anything else, a 403 included, the server message.
 */
export function loginErrorText(error: unknown, now: number = Date.now()): string {
  const failure = loginFailure(error, now)
  return failure.retryAt === null ? failure.message : rateLimitMessage((failure.retryAt - now) / 1000)
}

export interface FreshAuth {
  /** Bind to ConfirmPasswordDialog `open`. */
  open: Readonly<Ref<boolean>>
  /** Bind to ConfirmPasswordDialog `pending`: the prompt's login runs. */
  pending: Readonly<Ref<boolean>>
  /** Bind to ConfirmPasswordDialog `error`; a rate limit counts down and clears itself when the wait is over. */
  error: Readonly<Ref<string | null>>
  /** A password is set and the session is not fresh: a fresh-auth route would be refused now. */
  needed: ComputedRef<boolean>
  /** ConfirmPasswordDialog `submit`: logs in; success closes the prompt and releases the waiting tasks. */
  submit: (password: string) => Promise<void>
  /** ConfirmPasswordDialog `update:open`: closing cancels every waiting task (ignored while the login runs). */
  setOpen: (value: boolean) => void
  /** Runs `task`, prompting first (`required` and not fresh) or after a fresh-auth refusal; one more run per prompt. */
  run: <T>(task: () => Promise<T>, opts?: { required?: boolean }) => Promise<T>
  /** Logs in with the password of an inline field: null when it worked, else the error text for the field. */
  login: (password: string) => Promise<string | null>
  /** Opens the prompt now (or joins the open one): resolves after a login, rejects with the cancel error when closed. */
  confirm: () => Promise<void>
  /** Closes the prompt and rejects every waiting task with FreshAuthCancelledError. */
  cancel: () => void
}

interface Prompt {
  done: Promise<void>
  resolve: () => void
  reject: (reason: unknown) => void
}

export function useFreshAuth(): FreshAuth {
  const auth = useAuthStore()
  const open = ref(false)
  const pending = ref(false)
  /** The last failed login of the prompt. */
  const failure = ref<LoginFailure | null>(null)
  /** Clock of the rate-limit countdown. */
  const now = ref(Date.now())
  let ticker: ReturnType<typeof setInterval> | undefined
  /** The open prompt, shared by every task waiting for it. */
  let prompt: Prompt | null = null

  const needed = computed(() => auth.status?.enabled === true && !auth.fresh)

  const error = computed(() => {
    const current = failure.value
    if (current === null)
      return null
    if (current.retryAt === null)
      return current.message
    const seconds = secondsUntil(current.retryAt, now.value)
    return seconds > 0 ? rateLimitMessage(seconds) : null
  })

  function stopTicker(): void {
    clearInterval(ticker)
    ticker = undefined
  }

  function showFailure(next: LoginFailure | null): void {
    stopTicker()
    failure.value = next
    now.value = Date.now()
    const retryAt = next?.retryAt ?? null
    if (retryAt === null)
      return
    ticker = setInterval(() => {
      now.value = Date.now()
      if (secondsUntil(retryAt, now.value) === 0)
        showFailure(null)
    }, 250)
  }

  function confirm(): Promise<void> {
    if (!prompt) {
      showFailure(null)
      open.value = true
      let resolve!: () => void
      let reject!: (reason: unknown) => void
      const done = new Promise<void>((onResolve, onReject) => {
        resolve = onResolve
        reject = onReject
      })
      prompt = { done, resolve, reject }
    }
    return prompt.done
  }

  /** Closes the prompt and settles every task waiting for it. */
  function close(confirmed: boolean): void {
    const current = prompt
    prompt = null
    open.value = false
    showFailure(null)
    if (confirmed)
      current?.resolve()
    else
      current?.reject(new FreshAuthCancelledError())
  }

  async function submit(password: string): Promise<void> {
    if (pending.value)
      return
    const current = prompt
    pending.value = true
    showFailure(null)
    try {
      await auth.login(password)
    }
    catch (failed) {
      if (prompt === current)
        showFailure(loginFailure(failed))
      return
    }
    finally {
      pending.value = false
    }
    // A prompt cancelled while the login ran stays cancelled.
    if (prompt === current)
      close(true)
  }

  function setOpen(value: boolean): void {
    if (value || pending.value)
      return
    close(false)
  }

  function cancel(): void {
    close(false)
  }

  async function run<T>(task: () => Promise<T>, opts: { required?: boolean } = {}): Promise<T> {
    let prompted = false
    if (opts.required === true && needed.value) {
      await confirm()
      prompted = true
    }
    try {
      return await task()
    }
    catch (failed) {
      // A refusal right after a successful prompt is not solved by asking again: report it.
      if (prompted || !isFreshAuthRequired(failed))
        throw failed
      await confirm()
      return await task()
    }
  }

  async function login(password: string): Promise<string | null> {
    try {
      await auth.login(password)
      return null
    }
    catch (failed) {
      return loginErrorText(failed)
    }
  }

  // Leaving the page (the caller's scope ends) cancels a waiting prompt; outside a scope nothing is registered.
  onScopeDispose(cancel, true)

  return {
    open: readonly(open),
    pending: readonly(pending),
    error,
    needed,
    submit,
    setOpen,
    run,
    login,
    confirm,
    cancel,
  }
}
