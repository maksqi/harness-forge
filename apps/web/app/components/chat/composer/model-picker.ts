// Model picker grouping and search (docs/UI.md 7.9): Favorites, then Recent (last 5 used), then one group per
// connected provider in settings order (chat models only: models.groupedByProvider), then "Image models" (Phase 6,
// ADR-028: the visible image models of connected providers). Favorites and Recent hold chat and image models only
// (transcription and speech models are chosen in Settings -> Media). A search matches the display name, the model id
// or the provider name and shows the provider groups and the image models only (no Favorites/Recent duplicates).
// Enabled providers without credentials follow as "Not connected" rows that link to their key dialog.
import type { CatalogModel, ProviderSummary } from '@harness-forge/shared'

export type ModelPickerGroupKey = 'favorites' | 'recent' | 'images' | `provider:${string}`

export interface ModelPickerGroup {
  key: ModelPickerGroupKey
  /** `data-value` of the group: `favorites`, `recent`, `images` or the provider id. */
  value: string
  label: string
  /** Provider groups: their provider (header icon). */
  provider?: ProviderSummary
  models: CatalogModel[]
}

export interface ModelPickerSources {
  favorites: readonly CatalogModel[]
  recent: readonly CatalogModel[]
  byProvider: ReadonlyArray<{ provider: ProviderSummary, models: readonly CatalogModel[] }>
  /** The "Image models" group (`imagePickerModels`); omitted = none. */
  images?: readonly CatalogModel[]
  /** Provider display name of an image model (search); default: the provider id. */
  providerName?: (providerId: string) => string
}

/** Model kinds the chat picker offers: chat models, and image models for image turns. */
export function isPickerModel(model: CatalogModel): boolean {
  return model.kind === 'chat' || model.kind === 'image'
}

/** The visible image models of connected providers, in provider (settings) order, for the "Image models" group. */
export function imagePickerModels(visible: readonly CatalogModel[], connected: readonly ProviderSummary[]): CatalogModel[] {
  const order = new Map(connected.map((provider, index) => [provider.id, index]))
  return visible
    .filter(model => model.kind === 'image' && order.has(model.providerId))
    .map((model, index) => ({ model, index }))
    .sort((a, b) => order.get(a.model.providerId)! - order.get(b.model.providerId)! || a.index - b.index)
    .map(entry => entry.model)
}

function normalize(text: string): string {
  return text.toLocaleLowerCase().normalize('NFKD').replace(/\p{Diacritic}/gu, '')
}

/** Every whitespace-separated term of `query` occurs in the model name, the model id, its ref or the provider name. */
export function modelMatches(model: CatalogModel, providerName: string, query: string): boolean {
  const terms = normalize(query).split(/\s+/).filter(Boolean)
  if (terms.length === 0)
    return true
  const haystack = normalize(`${model.name} ${model.id} ${model.ref} ${providerName}`)
  return terms.every(term => haystack.includes(term))
}

/** The groups to render for a search query (empty groups are dropped). */
export function modelPickerGroups(sources: ModelPickerSources, query: string): ModelPickerGroup[] {
  const providerGroups: ModelPickerGroup[] = sources.byProvider.map(({ provider, models }) => ({
    key: `provider:${provider.id}` as const,
    value: provider.id,
    label: provider.name,
    provider,
    models: [...models],
  }))
  const providerName = sources.providerName ?? ((providerId: string) => providerId)
  const images = sources.images ?? []
  if (query.trim()) {
    const matches = providerGroups
      .map(group => ({ ...group, models: group.models.filter(model => modelMatches(model, group.label, query)) }))
      .filter(group => group.models.length > 0)
    const matchingImages = images.filter(model => modelMatches(model, providerName(model.providerId), query))
    if (matchingImages.length > 0)
      matches.push({ key: 'images', value: 'images', label: 'Image models', models: matchingImages })
    return matches
  }
  const favorites = sources.favorites.filter(isPickerModel)
  const favoriteRefs = new Set(favorites.map(model => model.ref))
  const recent = sources.recent.filter(model => isPickerModel(model) && !favoriteRefs.has(model.ref))
  const groups: ModelPickerGroup[] = []
  if (favorites.length > 0)
    groups.push({ key: 'favorites', value: 'favorites', label: 'Favorites', models: favorites })
  if (recent.length > 0)
    groups.push({ key: 'recent', value: 'recent', label: 'Recent', models: recent })
  groups.push(...providerGroups.filter(group => group.models.length > 0))
  if (images.length > 0)
    groups.push({ key: 'images', value: 'images', label: 'Image models', models: [...images] })
  return groups
}

/** Enabled providers whose credentials are missing, filtered by the search on their name. */
export function unconnectedProviders(providers: readonly ProviderSummary[], query: string): ProviderSummary[] {
  const needle = normalize(query.trim())
  return providers.filter(provider => provider.enabled
    && provider.status === 'not_configured'
    && (!needle || normalize(`${provider.name} ${provider.id}`).includes(needle)))
}

/**
 * Resolves what a user typed after `/model`: an exact ref, else a model id, else a display name (case-insensitive),
 * preferring visible models. Null when nothing matches.
 */
export function resolveModelQuery(query: string, visible: readonly CatalogModel[], byRef: (ref: string) => CatalogModel | undefined): string | null {
  const value = query.trim()
  if (!value)
    return null
  const exact = byRef(value)
  if (exact)
    return exact.ref
  const lower = value.toLowerCase()
  const byId = visible.find(model => model.id.toLowerCase() === lower)
  if (byId)
    return byId.ref
  const byName = visible.find(model => model.name.toLowerCase() === lower)
  return byName?.ref ?? null
}

/**
 * Screen reader text of an item: "{model}, {provider}, vision, tools, reasoning, image output, 200K context"
 * (docs/UI.md 14.2).
 */
export function modelItemLabel(model: CatalogModel, providerName: string, contextLabel: string): string {
  const parts = [model.name, providerName]
  if (model.capabilities.vision)
    parts.push('vision')
  if (model.capabilities.tools)
    parts.push('tools')
  if (model.capabilities.reasoning)
    parts.push('reasoning')
  if (model.capabilities.imageOutput)
    parts.push('image output')
  if (contextLabel)
    parts.push(`${contextLabel} context`)
  return parts.filter(Boolean).join(', ')
}
