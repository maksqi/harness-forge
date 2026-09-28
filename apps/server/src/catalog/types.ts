// Frozen interface of the model catalog (ARCHITECTURE.md section 9, PROVIDERS.md 3 / 5, API.md 5.7).
// Implementation: `createModelCatalog(deps)` in `catalog/index.ts` (W1.4).
import type { CatalogModel, CustomModelInput, CustomModelKey, ModelPrefsUpdate } from '@harness-forge/shared'

export interface CatalogQuery {
  /** Only this provider (`not_found` for an unknown provider). */
  providerId?: string
  /** Default false. */
  includeHidden?: boolean
}

/**
 * Entries per provider: live listing (24 h cache in `model_cache`, last good kept; seeds when there is none) + plugin
 * models (registry) + custom ids; field precedence custom -> live -> models.dev -> seed; `classify()` hides non-chat
 * models; prefs from `model_prefs`. Emits `catalog.changed` on every change (listing refresh, prefs, custom models,
 * registry changes, models.dev refresh).
 */
export interface ModelCatalog {
  /** Boot: loads the models.dev snapshot (+ `data/cache` refresh) and `model_cache`; starts background refreshes. */
  readonly start: () => Promise<void>
  /** Stops background timers. */
  readonly stop: () => Promise<void>
  /**
   * Models of enabled providers (regardless of credential status), hidden ones only with `includeHidden`.
   * Order: favorites, recent (`lastUsedAt`), then provider registry order and name.
   */
  readonly list: (query?: CatalogQuery) => Promise<CatalogModel[]>
  /** One entry (hidden included), or null. */
  readonly get: (providerId: string, modelId: string) => Promise<CatalogModel | null>
  /**
   * Forces a live listing now (TTL bypassed; the last good listing is kept on failure) and returns the provider's
   * models, hidden included. `not_found`, `provider_not_configured`, mapped upstream errors.
   */
  readonly refresh: (providerId: string) => Promise<CatalogModel[]>
  /** Favorite / hidden (`null` = classify default) / alias. `not_found` (unknown provider or model). */
  readonly updatePrefs: (update: ModelPrefsUpdate) => Promise<CatalogModel>
  /** Creates or replaces a custom model id. `not_found` (unknown provider). */
  readonly addCustom: (input: CustomModelInput) => Promise<CatalogModel>
  /** `not_found` when there is no custom model with that key. */
  readonly removeCustom: (key: CustomModelKey) => Promise<void>
  /** Records a use (`model_prefs.last_used_at`, "recent" in the picker); called by the chat pipeline. */
  readonly markUsed: (providerId: string, modelId: string, at?: number) => Promise<void>
  /** Visible chat model count and last successful listing of a provider (`ProviderSummary`). */
  readonly stats: (providerId: string) => Promise<{ modelCount: number, fetchedAt: number | null }>
}
