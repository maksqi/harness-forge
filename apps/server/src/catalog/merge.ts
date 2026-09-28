// Field precedence of a catalog entry (ARCHITECTURE.md 9): user custom -> live provider data -> models.dev -> plugin
// models / seeds. Each field (and each capability flag and price) comes from the first layer that defines it;
// unknown capabilities are false.
import type {
  CatalogModel,
  ModelCapabilities,
  ModelCost,
  ModelInfo,
  ModelKind,
  ModelSource,
  ReasoningEffort,
} from '@harness-forge/shared'
import type { ModalityHints } from './classify.ts'
import type { ModelsDevModel } from './models-dev.ts'
import { classify } from './classify.ts'

/** Display order of the effort menu. */
export const EFFORT_ORDER: readonly ReasoningEffort[] = ['auto', 'off', 'low', 'medium', 'high', 'max']

/** Efforts offered on a reasoning model that lists none (PLUGINS.md `ModelInfo.reasoningEfforts`). */
export const DEFAULT_REASONING_EFFORTS: readonly ReasoningEffort[] = ['off', 'low', 'medium', 'high']

const CAPABILITY_KEYS = ['tools', 'vision', 'pdf', 'reasoning', 'structuredOutput'] as const satisfies readonly (keyof ModelCapabilities)[]
const COST_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const satisfies readonly (keyof ModelCost)[]

/** A metadata layer: a `ModelInfo` whose fields may be missing. */
export type ModelLayer = Partial<ModelInfo>

/** User preferences of one model (`model_prefs`). */
export interface ModelPrefsState {
  hidden: boolean | null
  favorite: boolean
  alias: string | null
  custom: boolean
  lastUsedAt: number | null
}

export interface CatalogEntryInput {
  providerId: string
  id: string
  /** Layers in precedence order (custom, live, models.dev, plugin, seed); `undefined` layers are skipped. */
  layers: readonly (ModelLayer | undefined)[]
  /** models.dev modalities for `classify()`. */
  modalities?: ModalityHints
  prefs?: ModelPrefsState
  source: ModelSource
}

/** models.dev metadata as a layer (`vision` / `pdf` from the input modalities). */
export function modelsDevLayer(model: ModelsDevModel | undefined): ModelLayer | undefined {
  if (model === undefined)
    return undefined
  const layer: ModelLayer = {}
  if (model.name !== undefined)
    layer.name = model.name
  if (model.contextWindow !== undefined)
    layer.contextWindow = model.contextWindow
  if (model.maxOutputTokens !== undefined)
    layer.maxOutputTokens = model.maxOutputTokens
  const capabilities: Partial<ModelCapabilities> = {}
  if (model.tools !== undefined)
    capabilities.tools = model.tools
  if (model.reasoning !== undefined)
    capabilities.reasoning = model.reasoning
  if (model.structuredOutput !== undefined)
    capabilities.structuredOutput = model.structuredOutput
  if (model.input !== undefined) {
    capabilities.vision = model.input.includes('image')
    capabilities.pdf = model.input.includes('pdf')
  }
  layer.capabilities = capabilities
  if (model.cost !== undefined)
    layer.cost = { ...model.cost }
  return layer
}

/** Unique efforts without `auto`, in menu order. */
export function sortEfforts(efforts: Iterable<ReasoningEffort>): ReasoningEffort[] {
  const set = new Set(efforts)
  return EFFORT_ORDER.filter(effort => effort !== 'auto' && set.has(effort))
}

function first<T>(layers: readonly ModelLayer[], pick: (layer: ModelLayer) => T | undefined): T | undefined {
  for (const layer of layers) {
    const value = pick(layer)
    if (value !== undefined)
      return value
  }
  return undefined
}

/** The merged `ModelInfo` of the layers (fields absent when no layer defines them). */
export function mergeLayers(id: string, input: readonly (ModelLayer | undefined)[]): ModelInfo {
  const layers = input.filter((layer): layer is ModelLayer => layer !== undefined)
  const merged: ModelInfo = { id }
  const name = first(layers, layer => (layer.name?.trim() ? layer.name.trim() : undefined))
  if (name !== undefined)
    merged.name = name
  const kind = first(layers, layer => layer.kind)
  if (kind !== undefined)
    merged.kind = kind
  const contextWindow = first(layers, layer => layer.contextWindow)
  if (contextWindow !== undefined)
    merged.contextWindow = contextWindow
  const maxOutputTokens = first(layers, layer => layer.maxOutputTokens)
  if (maxOutputTokens !== undefined)
    merged.maxOutputTokens = maxOutputTokens
  const capabilities: Partial<ModelCapabilities> = {}
  for (const key of CAPABILITY_KEYS) {
    const value = first(layers, layer => layer.capabilities?.[key])
    if (value !== undefined)
      capabilities[key] = value
  }
  if (Object.keys(capabilities).length > 0)
    merged.capabilities = capabilities
  const efforts = first(layers, layer => layer.reasoningEfforts)
  if (efforts !== undefined)
    merged.reasoningEfforts = [...efforts]
  const cost: ModelCost = {}
  for (const key of COST_KEYS) {
    const value = first(layers, layer => layer.cost?.[key])
    if (value !== undefined)
      cost[key] = value
  }
  if (Object.keys(cost).length > 0)
    merged.cost = cost
  return merged
}

/** The effort menu of a merged model: `[]` without reasoning, else `auto` + the offered efforts. */
export function effortMenu(info: ModelInfo, reasoning: boolean): ReasoningEffort[] {
  if (!reasoning)
    return []
  const offered = sortEfforts(info.reasoningEfforts ?? DEFAULT_REASONING_EFFORTS)
  return offered.length === 0 ? [] : ['auto', ...offered]
}

/** The `CatalogModel` of an entry. */
export function buildCatalogModel(entry: CatalogEntryInput): CatalogModel {
  const info = mergeLayers(entry.id, entry.layers)
  const kind: ModelKind = info.kind ?? classify(entry.id, entry.modalities)
  // A model that lists efforts reasons even when no layer says so.
  const reasoning = info.capabilities?.reasoning
    ?? (info.reasoningEfforts !== undefined && info.reasoningEfforts.some(effort => effort !== 'auto'))
  const capabilities: ModelCapabilities = {
    tools: info.capabilities?.tools ?? false,
    vision: info.capabilities?.vision ?? false,
    pdf: info.capabilities?.pdf ?? false,
    reasoning,
    structuredOutput: info.capabilities?.structuredOutput ?? false,
    // Image output of chat models (ADR-028) is not derived from the layers yet (P6-A, W6.2).
    imageOutput: false,
  }
  const prefs = entry.prefs
  const alias = prefs?.alias ?? null
  return {
    ref: `${entry.providerId}:${entry.id}`,
    providerId: entry.providerId,
    id: entry.id,
    name: alias ?? info.name ?? entry.id,
    alias,
    kind,
    contextWindow: info.contextWindow ?? null,
    maxOutputTokens: info.maxOutputTokens ?? null,
    capabilities,
    reasoningEfforts: effortMenu(info, reasoning),
    cost: info.cost ?? null,
    favorite: prefs?.favorite ?? false,
    hidden: prefs?.hidden ?? kind !== 'chat',
    custom: prefs?.custom ?? false,
    source: entry.source,
    lastUsedAt: prefs?.lastUsedAt ?? null,
  }
}

/** The effective metadata of a catalog entry as `ModelInfo` (`ResolvedModel.info`, input of `reasoning()`). */
export function catalogModelInfo(model: CatalogModel): ModelInfo {
  const info: ModelInfo = {
    id: model.id,
    name: model.name,
    kind: model.kind,
    capabilities: { ...model.capabilities },
    reasoningEfforts: model.reasoningEfforts.filter(effort => effort !== 'auto'),
  }
  if (model.contextWindow !== null)
    info.contextWindow = model.contextWindow
  if (model.maxOutputTokens !== null)
    info.maxOutputTokens = model.maxOutputTokens
  if (model.cost !== null)
    info.cost = { ...model.cost }
  return info
}
