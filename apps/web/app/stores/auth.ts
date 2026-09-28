// Auth store (docs/UI.md 11, docs/API.md 5.2): the password status, login / logout, password changes and the
// fresh-auth window of ADR-017. Signatures are frozen after Phase 0.
import type { AuthStatus } from '@harness-forge/shared'
import { defineStore } from 'pinia'
import { computed, onScopeDispose, ref, watch } from 'vue'
import { useApi } from '~/composables/useApi'
import { withHarnessErrors } from '~/utils/errors'

export interface PasswordChange {
  /** The current password; required when a password is set (also used to refresh a stale session first). */
  current?: string
  /** The new password (8..1024 characters), or null to remove the password. */
  next: string | null
}

/** setTimeout cannot wait longer than 2^31 - 1 ms. */
const MAX_TIMER_MS = 2_147_483_647

export const useAuthStore = defineStore('auth', () => {
  const api = useApi()

  // ---------- state ----------

  /** Last known status. Null until `fetchStatus()` succeeds; a failed fetch keeps it null (auth not required). */
  const status = ref<AuthStatus | null>(null)
  /** `fetchStatus()` finished at least once, successfully or not. */
  const loaded = ref(false)

  // ---------- getters ----------

  /** A password is configured and there is no session: pages redirect to /login. */
  const requiresLogin = computed(() => status.value !== null && status.value.enabled && !status.value.authenticated)
  /** The status is known and grants access (true when no password is set). */
  const authenticated = computed(() => status.value?.authenticated === true)
  /** The password comes from `HF_PASSWORD` (read-only in Settings). */
  const passwordFromEnv = computed(() => status.value?.source === 'env')

  // `fresh` depends on the clock: re-evaluated when the fresh-auth window ends.
  const clock = ref(Date.now())
  let expiryTimer: ReturnType<typeof setTimeout> | undefined
  watch(() => status.value?.freshUntil ?? null, (freshUntil) => {
    clearTimeout(expiryTimer)
    clock.value = Date.now()
    if (freshUntil !== null && freshUntil > clock.value) {
      expiryTimer = setTimeout(() => {
        clock.value = Date.now()
      }, Math.min(MAX_TIMER_MS, freshUntil - clock.value + 50))
    }
  })
  onScopeDispose(() => clearTimeout(expiryTimer))

  /**
   * Fresh-auth routes pass without a password prompt: no password, or `freshUntil` in the future. Also true while
   * the status is unknown; the server then answers 403 `forbidden` + action `login` and the caller prompts.
   */
  const fresh = computed(() => {
    const current = status.value
    if (!current || !current.enabled)
      return true
    return current.freshUntil !== null && current.freshUntil > clock.value
  })

  // ---------- actions ----------

  // Bumped by every change of the session, so a status request that started before it cannot overwrite it.
  let generation = 0
  let pendingStatus: Promise<AuthStatus> | null = null

  function setStatus(next: AuthStatus) {
    generation += 1
    status.value = next
    loaded.value = true
  }

  /** `GET /auth/status`. Concurrent calls share one request. Throws `HarnessError`; `loaded` is set either way. */
  function fetchStatus(): Promise<AuthStatus> {
    if (pendingStatus)
      return pendingStatus
    const startedAt = generation
    const request = withHarnessErrors(api.auth.status())
      .then((next) => {
        if (generation === startedAt)
          status.value = next
        return next
      })
      .finally(() => {
        loaded.value = true
        pendingStatus = null
      })
    pendingStatus = request
    return request
  }

  /** `POST /auth/login`: starts a session and refreshes the fresh-auth window. Wrong password: `unauthorized`. */
  async function login(password: string): Promise<AuthStatus> {
    const next = await withHarnessErrors(api.auth.login({ body: { password } }))
    setStatus(next)
    return next
  }

  /** `POST /auth/logout`, then the status is reloaded. */
  async function logout(): Promise<void> {
    await withHarnessErrors(api.auth.logout())
    const current = status.value
    if (current)
      setStatus({ ...current, authenticated: !current.enabled, freshUntil: null })
    await fetchStatus().catch(() => {})
  }

  /**
   * `PUT /auth/password` (a fresh-auth route): logs in with `current` first when the session is not fresh.
   * `next: null` removes the password.
   */
  async function changePassword({ current, next }: PasswordChange): Promise<AuthStatus> {
    if (status.value?.enabled && !fresh.value && current)
      await login(current)
    const result = await withHarnessErrors(api.auth.setPassword({
      body: { ...(current ? { currentPassword: current } : {}), newPassword: next },
    }))
    setStatus(result)
    return result
  }

  /** The API answered 401 `unauthorized`: the session is gone (called by the `$api` plugin before redirecting). */
  function markUnauthenticated(): void {
    setStatus({ enabled: true, authenticated: false, source: status.value?.source ?? null, freshUntil: null })
  }

  return {
    status,
    loaded,
    requiresLogin,
    authenticated,
    passwordFromEnv,
    fresh,
    fetchStatus,
    login,
    logout,
    changePassword,
    markUnauthenticated,
  }
})
