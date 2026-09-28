// Nuxt runtime composables used by the shell, re-exported through one module so unit tests can vi.mock() it:
// Vitest runs without Nuxt, where '#imports' does not resolve.
export { navigateTo, useColorMode, useRoute } from '#imports'
