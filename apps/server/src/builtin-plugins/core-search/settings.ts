// The settings of `core-search` (Phase 14, ADR-063; the manifest's settings schema is in `index.ts`): the selected
// backend, one secret key per backend (`format: 'secret'`, stored in scope `plugin:core-search` as `settings.<key>`,
// decrypted only in `ctx.settings.get()` / `PluginHost.settingsValues`) and the default result count. Kept apart from
// `index.ts` so the tool and the "Test search" route read them without an import cycle; `index.ts` re-exports every
// member. Keys are never logged and never part of an error.
import type { WebSearchBackend } from '@harness-forge/shared'
import { SEARCH_WEB_RESULTS_MAX, WEB_SEARCH_BACKENDS } from '@harness-forge/shared'

/** The default of the `backend` setting. */
export const DEFAULT_SEARCH_BACKEND: WebSearchBackend = 'brave'

/** The default of the `maxResults` setting (the `count` of a call that names none). */
export const DEFAULT_SEARCH_MAX_RESULTS = 5

/** The secret setting that holds each backend's key (`format: 'secret'`, scope `plugin:core-search`, `settings.<key>`). */
export const SEARCH_KEY_SETTINGS = {
  brave: 'braveApiKey',
  tavily: 'tavilyApiKey',
  exa: 'exaApiKey',
} as const satisfies Record<WebSearchBackend, string>

/** Settings of `core-search` (`ctx.settings.get()`; the keys are decrypted values, never logged). */
export interface CoreSearchSettings {
  backend?: WebSearchBackend
  braveApiKey?: string
  tavilyApiKey?: string
  exaApiKey?: string
  maxResults?: number
}

/** The settings a search needs, read defensively from the stored values. */
export interface SearchSettings {
  /** The selected backend (an unknown value falls back to `brave`). */
  readonly backend: WebSearchBackend
  /** The key of each backend; null = not set (an empty or blank value counts as not set). */
  readonly keys: Readonly<Record<WebSearchBackend, string | null>>
  /** The default result count, 1 … 10. */
  readonly maxResults: number
}

/** True for one of the three backends. */
export function isSearchBackend(value: unknown): value is WebSearchBackend {
  return typeof value === 'string' && (WEB_SEARCH_BACKENDS as readonly string[]).includes(value)
}

function keyOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/** The search settings of the stored values (`ctx.settings.get()`, an `onChange` payload, `settingsValues`). */
export function readSearchSettings(values: unknown): SearchSettings {
  const record = typeof values === 'object' && values !== null && !Array.isArray(values) ? values as Record<string, unknown> : {}
  const backend = isSearchBackend(record.backend) ? record.backend : DEFAULT_SEARCH_BACKEND
  const max = record.maxResults
  const maxResults = typeof max === 'number' && Number.isFinite(max)
    ? Math.min(SEARCH_WEB_RESULTS_MAX, Math.max(1, Math.trunc(max)))
    : DEFAULT_SEARCH_MAX_RESULTS
  return {
    backend,
    keys: {
      brave: keyOf(record[SEARCH_KEY_SETTINGS.brave]),
      tavily: keyOf(record[SEARCH_KEY_SETTINGS.tavily]),
      exa: keyOf(record[SEARCH_KEY_SETTINGS.exa]),
    },
    maxResults,
  }
}

/** True while the selected backend has a key (the rule that registers `search_web`). */
export function selectedBackendHasKey(settings: SearchSettings): boolean {
  return settings.keys[settings.backend] !== null
}
