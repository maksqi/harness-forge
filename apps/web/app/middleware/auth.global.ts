// Auth guard (docs/UI.md 6): loads the auth status once; when a password is required and there is no session,
// pages redirect to /login?redirect=<path>, and /login redirects to its target when already authenticated.
// A status that cannot be loaded (network, or the 501 stub of Phase 0) means auth is not required: the `$api`
// plugin still redirects on any 401 `unauthorized`. A server that refuses the app outright (`403 forbidden`, e.g. a
// password-less server reached through a non-local host name) gets the full-page error with the server's message
// instead of an app whose every request fails.
// The public share page (`/share/<token>`, ADR-025) is exempt: it returns before the status is loaded, so a visitor is
// never sent to /login, and the event stream and the settings (which wait for a loaded status) never start.
import { abortNavigation, defineNuxtRouteMiddleware, navigateTo } from '#imports'
import { useAuthStore } from '~/stores/auth'
import { accessBlockedMessage, authRedirectFor, isSharePath } from '~/utils/redirect'

export default defineNuxtRouteMiddleware(async (to) => {
  if (isSharePath(to.path))
    return
  const auth = useAuthStore()
  if (!auth.loaded) {
    try {
      await auth.fetchStatus()
    }
    catch (error) {
      const blocked = accessBlockedMessage(error)
      if (blocked)
        return abortNavigation({ status: 403, statusText: 'Access blocked', message: blocked, fatal: true })
    }
  }
  const target = authRedirectFor(to, { requiresLogin: auth.requiresLogin, authenticated: auth.authenticated })
  if (target && target !== to.fullPath)
    return navigateTo(target, { replace: true })
})
