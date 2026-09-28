// Helpers that turn vendor model listings into `ModelInfo` objects that pass `modelInfoSchema`.
import type { ModelInfo, ReasoningEffort } from '@harness-forge/plugin-sdk'
import { modelInfoSchema } from '@harness-forge/plugin-sdk'

type Capability = 'tools' | 'vision' | 'pdf' | 'reasoning' | 'structuredOutput'
type CostKey = 'input' | 'output' | 'cacheRead' | 'cacheWrite'

/** A `ModelInfo` draft whose unknown fields may be `undefined` (they are dropped). */
export interface ModelDraft {
  id: string
  name?: string
  contextWindow?: number
  maxOutputTokens?: number
  capabilities?: Partial<Record<Capability, boolean | undefined>>
  reasoningEfforts?: readonly ReasoningEffort[]
  cost?: Partial<Record<CostKey, number | undefined>>
}

/** Display order of the effort menu. */
const EFFORT_ORDER: readonly ReasoningEffort[] = ['auto', 'off', 'low', 'medium', 'high', 'max']

/** Unique efforts in menu order. */
export function sortEfforts(efforts: Iterable<ReasoningEffort>): ReasoningEffort[] {
  const set = new Set(efforts)
  return EFFORT_ORDER.filter(effort => set.has(effort))
}

function definedEntries<K extends string, V>(record: Partial<Record<K, V | undefined>> | undefined): [K, V][] {
  if (!record)
    return []
  return (Object.entries(record) as [K, V | undefined][]).filter((entry): entry is [K, V] => entry[1] !== undefined)
}

/** Builds a `ModelInfo` without `undefined` fields, empty capability objects or empty cost objects. */
export function modelInfo(draft: ModelDraft): ModelInfo {
  const info: ModelInfo = { id: draft.id }
  const name = draft.name?.trim().slice(0, 256)
  if (name && name !== draft.id)
    info.name = name
  if (draft.contextWindow !== undefined)
    info.contextWindow = draft.contextWindow
  if (draft.maxOutputTokens !== undefined)
    info.maxOutputTokens = draft.maxOutputTokens
  const capabilities: NonNullable<ModelInfo['capabilities']> = {}
  for (const [key, value] of definedEntries(draft.capabilities))
    capabilities[key] = value
  if (Object.keys(capabilities).length > 0)
    info.capabilities = capabilities
  if (draft.reasoningEfforts !== undefined)
    info.reasoningEfforts = sortEfforts(draft.reasoningEfforts)
  const cost: NonNullable<ModelInfo['cost']> = {}
  for (const [key, value] of definedEntries(draft.cost))
    cost[key] = value
  if (Object.keys(cost).length > 0)
    info.cost = cost
  return info
}

/** Drops entries that fail `modelInfoSchema` (bad ids) and duplicate ids (the first one wins). */
export function finalizeListing(models: readonly ModelInfo[]): ModelInfo[] {
  const seen = new Set<string>()
  const result: ModelInfo[] = []
  for (const model of models) {
    if (seen.has(model.id) || !modelInfoSchema.safeParse(model).success)
      continue
    seen.add(model.id)
    result.push(model)
  }
  return result
}

/**
 * USD per token (a decimal string or number, as OpenRouter reports prices) -> USD per 1M tokens. Negative values
 * (`"-1"` marks router models) and unparsable values are unknown.
 */
export function perMillionTokens(value: unknown): number | undefined {
  const perToken = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (typeof perToken !== 'number' || !Number.isFinite(perToken) || perToken < 0)
    return undefined
  return Number((perToken * 1_000_000).toPrecision(12))
}
