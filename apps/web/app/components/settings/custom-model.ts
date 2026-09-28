// CustomModelDialog form rules (docs/UI.md 9.3, docs/API.md 4.5 `CustomModelInput`).
import type { CustomModelInput } from '@harness-forge/shared'
import { z } from 'zod'

export interface CustomModelFormValues {
  modelId: string
  name: string
  /** As typed: "128000", "128K", "1M" or empty. */
  contextWindow: string
  tools: boolean
  vision: boolean
  reasoning: boolean
  pdf: boolean
}

export const CAPABILITY_OPTIONS = [
  { key: 'tools', label: 'Tools' },
  { key: 'vision', label: 'Vision' },
  { key: 'reasoning', label: 'Reasoning' },
  { key: 'pdf', label: 'PDF input' },
] as const satisfies ReadonlyArray<{ key: keyof CustomModelFormValues, label: string }>

const TOKENS = /^(\d+(?:\.\d+)?)\s*([km])?$/i

/** "128000" -> 128000, "128K" -> 128000, "1.5M" -> 1500000; null when empty or not a positive whole number. */
export function parseTokenCount(text: string): number | null {
  const match = text.trim().match(TOKENS)
  if (!match)
    return null
  const unit = match[2]?.toLowerCase()
  const scale = unit === 'm' ? 1_000_000 : unit === 'k' ? 1000 : 1
  const value = Number(match[1]) * scale
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

export const modelNameRule = z.string().refine(value => value.trim().length <= 100, 'Use at most 100 characters.')

export const contextWindowRule = z.string().refine(
  value => value.trim() === '' || parseTokenCount(value) !== null,
  'Enter a number of tokens, e.g. 128000 or 128K.',
)

/** The request body for `POST /custom-models`: blank optional fields are left out. */
export function customModelInput(providerId: string, values: CustomModelFormValues): CustomModelInput {
  const name = values.name.trim()
  const contextWindow = parseTokenCount(values.contextWindow)
  return {
    providerId,
    modelId: values.modelId.trim(),
    ...(name ? { name } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    capabilities: { tools: values.tools, vision: values.vision, reasoning: values.reasoning, pdf: values.pdf },
  }
}
