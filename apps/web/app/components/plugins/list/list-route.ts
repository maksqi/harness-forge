// The last state of the plugin list (`/plugins?filter=&q=`), so "← Plugins" on a detail page returns to the same
// filter and search (docs/UI.md 8.7). Session-scoped, like the sidebar's last routes.
import type { RemovableRef } from '@vueuse/core'
import { useSessionStorage } from '@vueuse/core'
import { effectScope } from 'vue'

export const LIST_ROUTE_KEY = 'hf-plugins-list-route'
export const DEFAULT_LIST_ROUTE = '/plugins'

/** `/plugins` or `/plugins?...` (never a detail page, never another origin). */
export function isPluginsListRoute(value: unknown): value is string {
  return typeof value === 'string' && (value === DEFAULT_LIST_ROUTE || value.startsWith(`${DEFAULT_LIST_ROUTE}?`))
}

let shared: RemovableRef<string> | undefined

function listRouteRef(): RemovableRef<string> {
  shared ??= effectScope(true).run(() => useSessionStorage<string>(LIST_ROUTE_KEY, DEFAULT_LIST_ROUTE))!
  return shared
}

/** Records the current list route (called by the list page on every route change). */
export function rememberListRoute(fullPath: string): void {
  if (isPluginsListRoute(fullPath))
    listRouteRef().value = fullPath
}

/** Where "← Plugins" leads: the last list route of this session, else `/plugins`. */
export function lastListRoute(): string {
  const value = listRouteRef().value
  return isPluginsListRoute(value) ? value : DEFAULT_LIST_ROUTE
}
