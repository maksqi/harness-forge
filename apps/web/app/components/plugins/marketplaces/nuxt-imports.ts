// Nuxt runtime composables used by the Marketplaces page (Phase 12), re-exported through one module so unit tests can
// vi.mock() it: Vitest runs without Nuxt, where '#imports' does not resolve. Import first, then export: Nuxt does not
// transform `export ... from '#imports'`.
import { navigateTo, useHead, useRoute, useRouter } from '#imports'

export { navigateTo, useHead, useRoute, useRouter }
