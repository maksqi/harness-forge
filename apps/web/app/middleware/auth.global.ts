// Auth guard (docs/UI.md 6): loads the auth status once; when a password is required and there is no session,
// pages redirect to /login?redirect=<path>, and /login redirects to its target when already authenticated.
// A status that cannot be loaded (network, or the 501 stub of Phase 0) means auth is not required: the `$api`
// plugin still redirects on any 401 `unauthorized`.
import { defineNuxtRouteMiddleware, navigateTo } from '#imports'
import { useAuthStore } from '~/stores/auth'
import { authRedirectFor } from '~/utils/redirect'

export default defineNuxtRouteMiddleware(async (to) => {
  const auth = useAuthStore()
  if (!auth.loaded)
    await auth.fetchStatus().catch(() => {})
  const target = authRedirectFor(to, { requiresLogin: auth.requiresLogin, authenticated: auth.authenticated })
  if (target && target !== to.fullPath)
    return navigateTo(target, { replace: true })
})
