// Settings -> Models rules (docs/UI.md 9.3): per-provider sections, the filter, table order and price labels.
import type { CatalogModel, ModelCost, ProviderSummary } from '@harness-forge/shared'

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
