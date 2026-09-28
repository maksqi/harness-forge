// Provides `$api` (docs/UI.md 11, docs/API.md 3.4): the typed client from @harness-forge/shared on the same origin
// (`/api`, proxied to the server by Nitro in dev, served by the server in production) with session cookies, and
// `$apiFetch`, the fetch wrapper behind it. A 401 whose envelope code is `unauthorized` marks the session as gone
// and redirects to /login?redirect=<current path>; nothing else redirects (docs/API.md 2.2).
import { createApiClient } from '@harness-forge/shared'
import { defineNuxtPlugin, useRouter } from '#imports'
import { useAuthStore } from '~/stores/auth'
import { createApiFetch } from '~/utils/api'
import { isLoginPath, loginPath } from '~/utils/redirect'

export default defineNuxtPlugin(() => {
  const router = useRouter()
  let redirecting = false

  // Runs after an awaited request, outside any component: the router is captured above.
  function onUnauthorized() {
    useAuthStore().markUnauthenticated()
    const current = router.currentRoute.value
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
