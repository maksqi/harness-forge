// Provides `$api` (docs/UI.md 11, docs/API.md 3.4): the typed client from @harness-forge/shared on the same origin
// (`/api`, proxied to the server by Nitro in dev, served by the server in production) with session cookies, and
// `$apiFetch`, the fetch wrapper behind it. A 401 whose envelope code is `unauthorized` marks the session as gone
// and redirects to /login?redirect=<current path>; nothing else redirects (docs/API.md 2.2). The public share page
// (`/share/<token>`, ADR-025) is left alone: a visitor has no session to lose, so it never touches the auth store or
// leaves the page (its only request, `GET /api/share/:token`, is public anyway).
import { createApiClient } from '@harness-forge/shared'
import { defineNuxtPlugin, useRouter } from '#imports'
import { useAuthStore } from '~/stores/auth'
import { createApiFetch } from '~/utils/api'
import { isLoginPath, isSharePath, loginPath } from '~/utils/redirect'

/** The share page is the current route, or the page being loaded (before the first navigation settles). */
function onSharePage(currentPath: string): boolean {
  return isSharePath(currentPath) || (typeof window !== 'undefined' && isSharePath(window.location.pathname))
}

export default defineNuxtPlugin(() => {
  const router = useRouter()
  let redirecting = false

  // Runs after an awaited request, outside any component: the router is captured above.
  function onUnauthorized() {
    const current = router.currentRoute.value
    if (onSharePage(current.path))
      return
    useAuthStore().markUnauthenticated()
    if (redirecting || isLoginPath(current.path))
      return
    redirecting = true
    router.replace(loginPath(current.fullPath))
      .catch(() => {})
      .finally(() => {
        redirecting = false
      })
  }

  const apiFetch = createApiFetch({ onUnauthorized })
  const api = createApiClient({ baseUrl: '/api', fetch: apiFetch, credentials: 'same-origin' })

  return {
    provide: { api, apiFetch },
  }
})
