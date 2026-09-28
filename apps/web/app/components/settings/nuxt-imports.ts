// Nuxt runtime composables used by the settings and login components, re-exported through one module so unit tests
// can vi.mock() it: Vitest runs without Nuxt, where '#imports' does not resolve. Import first, then export: Nuxt does
// not transform `export ... from '#imports'`.
import { navigateTo, useColorMode, useHead, useRoute, useRouter } from '#imports'

export { navigateTo, useColorMode, useHead, useRoute, useRouter }
