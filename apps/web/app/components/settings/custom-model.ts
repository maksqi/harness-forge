// CustomModelDialog form rules (docs/UI.md 9.3, docs/API.md 4.5 `CustomModelInput`).
import type { CustomModelInput } from '@harness-forge/shared'
import { z } from 'zod'

/** The kinds a custom model can have (docs/UI.md 9.3), in the order of the "Kind" select; `chat` is the default. */
export const CUSTOM_MODEL_KINDS = [
  { value: 'chat', label: 'Chat' },
  { value: 'image', label: 'Image' },
  { value: 'transcription', label: 'Speech to text' },
  { value: 'speech', label: 'Text to speech' },
] as const

export type CustomModelKind = (typeof CUSTOM_MODEL_KINDS)[number]['value']

/** Narrows a select value to a custom model kind. */
export function isCustomModelKind(value: unknown): value is CustomModelKind {
  return CUSTOM_MODEL_KINDS.some(option => option.value === value)
}

export interface CustomModelFormValues {
  modelId: string
  name: string
  kind: CustomModelKind
  /** As typed: "128000", "128K", "1M" or empty. Chat models only. */
  contextWindow: string
  /** Capabilities: chat models only. */
  tools: boolean
  vision: boolean
  reasoning: boolean
  pdf: boolean
  imageOutput: boolean
}

export const CAPABILITY_OPTIONS = [
  { key: 'tools', label: 'Tools' },
  { key: 'vision', label: 'Vision' },
  { key: 'reasoning', label: 'Reasoning' },
  { key: 'pdf', label: 'PDF input' },
  { key: 'imageOutput', label: 'Image output' },
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

const CONTEXT_WINDOW_ERROR = 'Enter a number of tokens, e.g. 128000 or 128K.'

export const contextWindowRule = z.string().refine(
  value => value.trim() === '' || parseTokenCount(value) !== null,
  CONTEXT_WINDOW_ERROR,
)

/**
 * The error of the typed context window, or undefined when it is valid (empty counts as valid). Only chat models have
 * a context window: for the other kinds the field is hidden and never blocks saving.
 */
export function contextWindowError(value: string, kind: CustomModelKind): string | undefined {
  if (kind !== 'chat' || value.trim() === '' || parseTokenCount(value) !== null)
    return undefined
  return CONTEXT_WINDOW_ERROR
}

/**
 * The request body for `POST /custom-models`: blank optional fields are left out; `kind` is always sent. The context
 * window and the capabilities apply to chat models only (docs/UI.md 9.3), so the other kinds send neither.
 */
export function customModelInput(providerId: string, values: CustomModelFormValues): CustomModelInput {
  const name = values.name.trim()
  const base: CustomModelInput = {
    providerId,
    modelId: values.modelId.trim(),
    ...(name ? { name } : {}),
    kind: values.kind,
  }
  if (values.kind !== 'chat')
    return base
  const contextWindow = parseTokenCount(values.contextWindow)
  return {
    ...base,
    ...(contextWindow ? { contextWindow } : {}),
    capabilities: {
      tools: values.tools,
      vision: values.vision,
      reasoning: values.reasoning,
      pdf: values.pdf,
      imageOutput: values.imageOutput,
    },
  }
}
