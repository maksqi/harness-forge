// Typed API access (docs/UI.md 11, docs/API.md 3.4): `$api` is `createApiClient()` from @harness-forge/shared,
// provided by plugins/api.ts with a fetch wrapper that sends the user to /login on 401 `unauthorized`.
// Unit tests vi.mock() this module ('#imports' does not resolve outside Nuxt).
import type { ApiClient } from '@harness-forge/shared'
import { useNuxtApp } from '#imports'

/** The typed API client: `useApi().chats.list({ query: { q } })`. Every non-2xx response throws a `HarnessError`. */
export function useApi(): ApiClient {
  return useNuxtApp().$api as ApiClient
}

/**
 * The fetch behind `$api` (same-origin cookies, 401 `unauthorized` -> /login), for requests the typed client does
 * not cover, e.g. `DefaultChatTransport({ fetch })`.
 */
export function useApiFetch(): typeof globalThis.fetch {
  return useNuxtApp().$apiFetch as typeof globalThis.fetch
}
