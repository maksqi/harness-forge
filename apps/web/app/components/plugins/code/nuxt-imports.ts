// Nuxt runtime composables used by the code plugin components, re-exported through one module so unit tests can
// vi.mock() it: Vitest runs without Nuxt, where '#imports' does not resolve. Import first, then export: Nuxt does not
// transform `export ... from '#imports'`.
import { onBeforeRouteLeave, onBeforeRouteUpdate, useColorMode } from '#imports'

export { onBeforeRouteLeave, onBeforeRouteUpdate, useColorMode }
