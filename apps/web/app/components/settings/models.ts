// Settings -> Models rules (docs/UI.md 9.3): per-provider sections, the filter, table order and price labels; the
// model lists of SettingsModelSelect per kind (docs/UI.md 9.3, 9.9, 10.4) and the kind labels of the models table.
import type { CatalogModel, ModelCost, ModelKind, ProviderSummary } from '@harness-forge/shared'

/**
 * What a SettingsModelSelect lists (docs/UI.md 10.4): `chat` = the visible chat models (Settings -> Models: default and
 * title model); `image` = the visible image models (Settings -> Media, the model of the generate_image tool);
 * `transcription` / `speech` = every speech-to-text / text-to-speech model, hidden ones included (they never appear in
 * the chat model picker, so they are hidden by default).
 */
export type SettingsModelKind = 'chat' | 'image' | 'transcription' | 'speech'

/** One group of a SettingsModelSelect: a connected provider and its models of the requested kind. */
export interface ModelSelectGroup {
  provider: ProviderSummary
  models: CatalogModel[]
}

/** Kinds whose hidden models stay out of the select (hidden = never shown in the chat model picker either). */
const VISIBLE_ONLY_KINDS: ReadonlySet<SettingsModelKind> = new Set(['chat', 'image'])

/**
 * The models of `kind` grouped by connected provider, in the order of `providers` (the connected ones, settings
 * order); providers without such models are skipped. Inside a group the catalog order is kept (favorites, recent, then
 * name). Models of providers that are not in `providers` are left out.
 */
export function modelSelectGroups(
  providers: readonly ProviderSummary[],
  models: readonly CatalogModel[],
  kind: SettingsModelKind,
): ModelSelectGroup[] {
  const visibleOnly = VISIBLE_ONLY_KINDS.has(kind)
  const byProvider = new Map<string, CatalogModel[]>()
  for (const model of models) {
    if (model.kind !== kind || (visibleOnly && model.hidden))
      continue
    const list = byProvider.get(model.providerId)
    if (list)
      list.push(model)
    else
      byProvider.set(model.providerId, [model])
  }
  const groups: ModelSelectGroup[] = []
  for (const provider of providers) {
    const list = byProvider.get(provider.id)
    if (list)
      groups.push({ provider, models: list })
  }
  return groups
}

/** The text of a SettingsModelSelect popover without any model of its kind. */
export const MODEL_SELECT_EMPTY_TEXT: Readonly<Record<SettingsModelKind, string>> = {
  chat: 'No chat models from your connected providers.',
  image: 'No image models from your connected providers.',
  transcription: 'No speech-to-text models from your connected providers.',
  speech: 'No text-to-speech models from your connected providers.',
}

/** The muted kind badge of a non-chat model in the models table (docs/UI.md 9.3). */
export const MODEL_KIND_LABELS: Readonly<Record<ModelKind, string>> = {
  chat: 'Chat',
  image: 'Image',
  transcription: 'Speech to text',
  speech: 'Text to speech',
  embedding: 'Embedding',
  audio: 'Audio',
  other: 'Other',
}

/** A connected provider and its catalog models (hidden ones included) that match the filter. */
export interface ModelSection {
  provider: ProviderSummary
  /** Models matching the filter, by name. */
  models: CatalogModel[]
  /** Every model of the provider in the catalog. */
  total: number
}

/** Sections with more models than this start collapsed (unless a filter is active). */
export const LARGE_SECTION = 60

/** By display name (natural order), then id. */
export function sortModels(models: readonly CatalogModel[]): CatalogModel[] {
  return [...models].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    || a.id.localeCompare(b.id))
}

/** Every whitespace-separated term appears in the name, id or alias (case-insensitive). */
export function matchesModelQuery(model: Pick<CatalogModel, 'name' | 'id' | 'alias'>, query: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0)
    return true
  const haystack = `${model.name} ${model.id} ${model.alias ?? ''}`.toLowerCase()
  return terms.every(term => haystack.includes(term))
}

/** One section per connected provider (settings order), even without models, so custom models can be added. */
export function modelSections(
  providers: readonly ProviderSummary[],
  models: readonly CatalogModel[],
  query: string,
): ModelSection[] {
  const byProvider = new Map<string, CatalogModel[]>()
  for (const model of models) {
    const list = byProvider.get(model.providerId)
    if (list)
      list.push(model)
    else
      byProvider.set(model.providerId, [model])
  }
  const filtering = query.trim() !== ''
  const sections: ModelSection[] = []
  for (const provider of providers) {
    const all = byProvider.get(provider.id) ?? []
    const matching = all.filter(model => matchesModelQuery(model, query))
    if (filtering && matching.length === 0)
      continue
    sections.push({ provider, models: sortModels(matching), total: all.length })
  }
  return sections
}

/** "$3", "$2.50", "$0.15", "$0.075" (USD per 1M tokens). */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value < 0)
    return '—'
  if (Number.isInteger(value))
    return `$${value}`
  if (value >= 1)
    return `$${value.toFixed(2)}`
  return `$${Number(value.toPrecision(3))}`
}

/** "$3 / $15" (input / output per 1M tokens); null when both are unknown. */
export function formatPrice(cost: ModelCost | null | undefined): string | null {
  if (!cost || (cost.input === undefined && cost.output === undefined))
    return null
  const part = (value: number | undefined) => (value === undefined ? '—' : formatUsd(value))
  return `${part(cost.input)} / ${part(cost.output)}`
}
