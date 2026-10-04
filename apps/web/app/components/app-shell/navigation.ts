// Sidebar modes and the last route per mode (docs/UI.md 5.2).
import type { RemovableRef } from '@vueuse/core'
import type { Component } from 'vue'
import { BoxesIcon, DatabaseIcon, FoldersIcon, ImagePlayIcon, InfoIcon, KeyRoundIcon, PaletteIcon, SlidersHorizontalIcon, WandSparklesIcon } from '@lucide/vue'
import { useSessionStorage } from '@vueuse/core'
import { effectScope } from 'vue'
import { testIds } from '~/utils/testids'

export type AppMode = 'chat' | 'plugins' | 'settings'

/** Where the Chat tab, the Plugins tab and "Back to app" lead: the last route seen in that mode. */
export interface LastRoutes {
  chat: string
  plugins: string
  /** Last route outside /settings. */
  app: string
}

export const LAST_ROUTES_KEY = 'hf-last-routes'

export const DEFAULT_LAST_ROUTES: Readonly<LastRoutes> = Object.freeze({ chat: '/', plugins: '/plugins', app: '/' })

function isUnder(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`)
}

/** `/plugins*` -> plugins, `/settings*` -> settings, everything else (`/`, `/chat/*`) -> chat. Accepts full paths. */
export function modeOfPath(fullPath: string): AppMode {
  const path = fullPath.split(/[?#]/)[0]!
  if (isUnder(path, '/plugins'))
    return 'plugins'
  if (isUnder(path, '/settings'))
    return 'settings'
  return 'chat'
}

/** An in-app path: starts with a single "/" (no "//" or "/\" that would leave the origin). */
export function isAppPath(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/') && value[1] !== '/' && value[1] !== '\\'
}

/** Drops anything in session storage that is not an in-app path. */
export function sanitizeLastRoutes(value: Partial<LastRoutes> | null | undefined): LastRoutes {
  return {
    chat: isAppPath(value?.chat) && modeOfPath(value.chat) === 'chat' ? value.chat : DEFAULT_LAST_ROUTES.chat,
    plugins: isAppPath(value?.plugins) && modeOfPath(value.plugins) === 'plugins' ? value.plugins : DEFAULT_LAST_ROUTES.plugins,
    app: isAppPath(value?.app) && modeOfPath(value.app) !== 'settings' ? value.app : DEFAULT_LAST_ROUTES.app,
  }
}

/** Records `fullPath` as the last route of its mode (and as the last app route outside settings). */
export function rememberRoute(last: LastRoutes, fullPath: string): LastRoutes {
  if (!isAppPath(fullPath))
    return last
  const mode = modeOfPath(fullPath)
  if (mode === 'settings')
    return last
  return { ...last, [mode]: fullPath, app: fullPath }
}

let sharedLastRoutes: RemovableRef<LastRoutes> | undefined

/** Session-scoped last routes: one ref for the whole app (sidebar, tabs, Back to app), backed by sessionStorage. */
export function useLastRoutes(): RemovableRef<LastRoutes> {
  sharedLastRoutes ??= effectScope(true).run(() =>
    useSessionStorage<LastRoutes>(LAST_ROUTES_KEY, { ...DEFAULT_LAST_ROUTES }, { mergeDefaults: true }),
  )!
  return sharedLastRoutes
}

export interface SettingsLink {
  key: 'providers' | 'models' | 'media' | 'projects' | 'customize' | 'general' | 'appearance' | 'data' | 'about'
  label: string
  to: string
  icon: Component
  testId: string
}

/** The settings pages in sidebar order (docs/UI.md 5.5); the command palette lists them too. */
export const SETTINGS_LINKS: readonly SettingsLink[] = [
  { key: 'providers', label: 'Providers', to: '/settings/providers', icon: KeyRoundIcon, testId: testIds.settingsNavProviders },
  { key: 'models', label: 'Models', to: '/settings/models', icon: BoxesIcon, testId: testIds.settingsNavModels },
  { key: 'media', label: 'Media', to: '/settings/media', icon: ImagePlayIcon, testId: testIds.settingsNavMedia },
  { key: 'projects', label: 'Projects', to: '/settings/projects', icon: FoldersIcon, testId: testIds.settingsNavProjects },
  { key: 'customize', label: 'Customize', to: '/settings/customize', icon: WandSparklesIcon, testId: testIds.settingsNavCustomize },
  { key: 'general', label: 'General', to: '/settings/general', icon: SlidersHorizontalIcon, testId: testIds.settingsNavGeneral },
  { key: 'appearance', label: 'Appearance', to: '/settings/appearance', icon: PaletteIcon, testId: testIds.settingsNavAppearance },
  { key: 'data', label: 'Data', to: '/settings/data', icon: DatabaseIcon, testId: testIds.settingsNavData },
  { key: 'about', label: 'About', to: '/settings/about', icon: InfoIcon, testId: testIds.settingsNavAbout },
]
