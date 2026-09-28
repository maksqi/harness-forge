// Sanitizing of model lists that come from provider or plugin code (live listings, seeds, plugin models): every entry
// must pass `modelInfoSchema`, unknown keys are dropped instead of failing the entry, ids are unique (first wins).
// Phase 6: `capabilities.imageOutput` and `voices` are kept (voices cleaned: valid names, unique, at most 100).
import type { ModelInfo } from '@harness-forge/shared'
import { modelIdSchema, modelInfoSchema } from '@harness-forge/shared'
import { cleanVoices } from './merge.ts'

/** Upper bound of a stored listing (`modelInfoListSchema`). */
export const MAX_LISTED_MODELS = 5000

const MODEL_KEYS = ['id', 'name', 'kind', 'contextWindow', 'maxOutputTokens', 'capabilities', 'reasoningEfforts', 'cost', 'voices'] as const
const CAPABILITY_KEYS = ['tools', 'vision', 'pdf', 'reasoning', 'structuredOutput', 'imageOutput'] as const
const COST_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pick(record: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of keys) {
    if (record[key] !== undefined)
      out[key] = record[key]
  }
  return out
}

/** A valid `ModelInfo`, keeping the valid fields of a partially invalid entry; null without a valid id. */
export function sanitizeModelInfo(value: unknown): ModelInfo | null {
  if (!isRecord(value) || !modelIdSchema.safeParse(value.id).success)
    return null
  const candidate = pick(value, MODEL_KEYS)
  if (isRecord(candidate.capabilities))
    candidate.capabilities = pick(candidate.capabilities, CAPABILITY_KEYS)
  if (isRecord(candidate.cost))
    candidate.cost = pick(candidate.cost, COST_KEYS)
  if (Array.isArray(candidate.voices))
    candidate.voices = cleanVoices(candidate.voices)
  const parsed = modelInfoSchema.safeParse(candidate)
  if (parsed.success)
    return parsed.data
  // Drop the invalid fields one by one (a bad price must not hide the model).
  const salvaged: Record<string, unknown> = { id: candidate.id }
  for (const key of MODEL_KEYS) {
    if (key === 'id' || candidate[key] === undefined)
      continue
    const attempt = { ...salvaged, [key]: candidate[key] }
    if (modelInfoSchema.safeParse(attempt).success)
      salvaged[key] = candidate[key]
  }
  const result = modelInfoSchema.safeParse(salvaged)
  return result.success ? result.data : null
}

/** Valid, unique models (first id wins), at most `MAX_LISTED_MODELS`. */
export function sanitizeListing(models: unknown): ModelInfo[] {
  if (!Array.isArray(models))
    return []
  const seen = new Set<string>()
  const result: ModelInfo[] = []
  for (const item of models) {
    const model = sanitizeModelInfo(item)
    if (model === null || seen.has(model.id))
      continue
    seen.add(model.id)
    result.push(model)
    if (result.length >= MAX_LISTED_MODELS)
      break
  }
  return result
}
