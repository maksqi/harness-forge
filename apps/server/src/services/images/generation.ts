// Pure helpers of one image generation (ADR-028): the checked call options of `ProviderDefinition.imageParams`, the token
// usage and the estimated cost of a `generateImage` result, the prompt as revised by the provider, and the display name
// of the image model (Phase 7, plugin API 1.2.0).
import type { ImageParamsResult, ProviderOptions } from '@harness-forge/plugin-sdk'
import type { ModelCost } from '@harness-forge/shared'
import type { GeneratedFile, ImageModelUsage } from 'ai'
import type { ImageGenerationResult, ImageGenerationUsage } from './types.ts'
import { LIMITS, safeParseModelRef } from '@harness-forge/shared'

/** Maximum characters of an image model display name (`generateImageToolOutputSchema.modelName`: `max(200)`). */
export const IMAGE_MODEL_NAME_MAX_CHARS = 200

/**
 * The display name of an image model (Phase 7, plugin API 1.2.0): the catalog name (`CatalogModel.name`: the user's
 * alias, else the catalog name, else the id), else the model id; trimmed and cut to `IMAGE_MODEL_NAME_MAX_CHARS`.
 */
export function imageModelDisplayName(catalogName: string | null | undefined, modelId: string): string {
  const name = typeof catalogName === 'string' ? catalogName.trim() : ''
  return cutUtf16(name === '' ? modelId : name, IMAGE_MODEL_NAME_MAX_CHARS)
}

/**
 * The display name of an image generation result: its `modelName` (the image service always sets it), else the model id
 * of `modelRef` (results built without it, e.g. test doubles written before Phase 7).
 */
export function resultModelName(result: Pick<ImageGenerationResult, 'modelRef' | 'modelName'>): string {
  return imageModelDisplayName(result.modelName, safeParseModelRef(result.modelRef)?.modelId ?? result.modelRef)
}

/** `WxH` with positive integers (`generateImage({ size })`). */
const SIZE_PATTERN = /^[1-9]\d{0,4}x[1-9]\d{0,4}$/
/** `W:H` with positive integers (`generateImage({ aspectRatio })`). */
const RATIO_PATTERN = /^[1-9]\d{0,3}:[1-9]\d{0,3}$/

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function isProviderOptions(value: unknown): value is ProviderOptions {
  return isPlainObject(value) && Object.values(value).every(isPlainObject)
}

/**
 * The usable part of an `imageParams()` result (plugin data): `size` as `WxH`, `aspectRatio` as `W:H` and provider
 * options as an object of objects; anything else is dropped (a non-object result gives no additions).
 */
export function sanitizeImageParams(value: unknown): ImageParamsResult {
  if (!isPlainObject(value))
    return {}
  const params: ImageParamsResult = {}
  if (typeof value.size === 'string' && SIZE_PATTERN.test(value.size))
    params.size = value.size as `${number}x${number}`
  if (typeof value.aspectRatio === 'string' && RATIO_PATTERN.test(value.aspectRatio))
    params.aspectRatio = value.aspectRatio as `${number}:${number}`
  if (isProviderOptions(value.providerOptions))
    params.providerOptions = value.providerOptions
  return params
}

/** A reported token count as stored (an integer >= 0), or undefined when not reported. */
function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : undefined
}

/**
 * The usage of a generation: `null` when the provider reports no token count at all (xAI); else the reported counts, 0
 * for a missing input or output count, and the total as reported (else input + output).
 */
export function imageUsage(usage: ImageModelUsage | undefined): ImageGenerationUsage | null {
  const inputTokens = tokenCount(usage?.inputTokens)
  const outputTokens = tokenCount(usage?.outputTokens)
  const totalTokens = tokenCount(usage?.totalTokens)
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined)
    return null
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    totalTokens: totalTokens ?? (inputTokens ?? 0) + (outputTokens ?? 0),
  }
}

/** USD amounts are rounded to 1e-10 (sums of per-token prices otherwise show floating point noise). */
export function roundUsd(value: number): number {
  return Math.round(value * 1e10) / 1e10
}

/**
 * The estimated cost in USD: input tokens times the catalog's input price plus output tokens times its output price
 * (USD per 1M tokens). `null` when the model has no catalog price, when the provider reports neither an input nor an
 * output count (no usage, or a total only), or when a used token kind has no price.
 */
export function imageCost(usage: ImageModelUsage | undefined, cost: ModelCost | null | undefined): number | null {
  if (cost === null || cost === undefined)
    return null
  const inputTokens = tokenCount(usage?.inputTokens)
  const outputTokens = tokenCount(usage?.outputTokens)
  if (inputTokens === undefined && outputTokens === undefined)
    return null
  const lines: [number, number | undefined][] = [[inputTokens ?? 0, cost.input], [outputTokens ?? 0, cost.output]]
  let total = 0
  for (const [tokens, price] of lines) {
    if (tokens === 0)
      continue
    if (price === undefined)
      return null
    total += tokens * price
  }
  return roundUsd(total / 1_000_000)
}

/** The first `maxLength` UTF-16 code units of `text`, never ending inside a surrogate pair. */
export function cutUtf16(text: string, maxLength: number): string {
  if (text.length <= maxLength)
    return text
  let end = Math.max(0, maxLength)
  const code = text.charCodeAt(end - 1)
  if (end > 0 && code >= 0xD800 && code <= 0xDBFF)
    end -= 1
  return text.slice(0, end)
}

/**
 * The prompt as rewritten by the provider: the first `revisedPrompt` string in the per-image provider metadata (OpenAI
 * and the mock provider report one per image), trimmed and cut to `LIMITS.imagePromptMaxChars` UTF-16 code units (the
 * limit of `imageTurnMetadataSchema` and `generateImageToolOutputSchema`); undefined when there is none.
 */
export function revisedPromptOf(images: readonly GeneratedFile[]): string | undefined {
  for (const image of images) {
    for (const metadata of Object.values(image.providerMetadata ?? {})) {
      const value = isPlainObject(metadata) ? metadata.revisedPrompt : undefined
      if (typeof value === 'string' && value.trim() !== '')
        return cutUtf16(value.trim(), LIMITS.imagePromptMaxChars)
    }
  }
  return undefined
}
