// Nuxt runtime composables used by the workspace components and the chat page that mounts them, re-exported through
// one module so unit tests can vi.mock() it: Vitest runs without Nuxt, where '#imports' does not resolve. Import first,
// then export: Nuxt does not transform `export ... from '#imports'`.
import { useHead } from '#imports'

export { useHead }
