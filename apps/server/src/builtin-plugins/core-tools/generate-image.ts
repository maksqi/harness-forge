// The `generate_image` tool of `core-tools` (ADR-028; policy `ask`, timeout 300 s): generates images with the image
// model of Settings → Media (`imageModelRef`) through `ctx.images.generate`, which stores them as files, and returns file
// references only (`generateImageToolOutputSchema`, never image bytes) plus the model's display name (`modelName`, plugin
// API 1.2.0). The model gets a short text instead of the JSON, built from the stored output ("Generated 2 images with GPT
// Image 1; ..."; outputs stored before Phase 7 name the model ref); the chat pipeline appends the images as `file` parts
// after the call (only for this tool of `core-tools`). The tool is always registered: without an image model a call
// fails with "Choose an image model in Settings → Media.".
import type { PluginImagesApi, ToolDefinition, ToolResultOutput } from '@harness-forge/plugin-sdk'
import type { GenerateImageToolInput, GenerateImageToolOutput } from '@harness-forge/shared'
import type { JSONValue } from 'ai'
import { Buffer } from 'node:buffer'
import { GENERATE_IMAGE_TOOL_NAME, generateImageToolInputSchema, generateImageToolOutputSchema, HarnessError, IMAGE_ASPECT_RATIOS, LIMITS } from '@harness-forge/shared'
import { z } from 'zod'

export { GENERATE_IMAGE_TOOL_NAME } from '@harness-forge/shared'

/** Timeout of one call: image models can take minutes. */
export const GENERATE_IMAGE_TIMEOUT_MS = 300_000

/**
 * Budget of `revisedPrompt` as serialized JSON: the whole output stays far below the 64 KB tool output cap (a truncated
 * output would not parse, so the pipeline could not show the images).
 */
export const GENERATE_IMAGE_REVISED_PROMPT_JSON_BYTES = 16_384

/** `generateImageToolInputSchema` with descriptions for the model (the same validation). */
export const generateImageInputSchema = z.object({
  prompt: generateImageToolInputSchema.shape.prompt.describe(
    `What the image should show: subject, style, composition, colors and any text to render (1-${LIMITS.imagePromptMaxChars} characters).`,
  ),
  n: generateImageToolInputSchema.shape.n.describe(`Number of images to generate, 1-${LIMITS.imagesPerTurnMax} (default 1).`),
  aspectRatio: generateImageToolInputSchema.shape.aspectRatio.describe(
    `Aspect ratio of the images: ${IMAGE_ASPECT_RATIOS.join(', ')}. Default: the model's default.`,
  ),
})

/** Maximum characters of the output's `modelName` (`generateImageToolOutputSchema`). */
export const GENERATE_IMAGE_MODEL_NAME_MAX_CHARS = 200

/**
 * The text the model gets instead of the output: `Generated 2 images with <model>; they are shown to the user below this
 * call.` (`1 image ...; it is shown ...`). `model` is the output's `modelName`, else its `modelRef` (outputs stored before
 * Phase 7): the text depends on the stored output alone, since it is built again whenever the history is converted.
 */
export function generatedImagesText(count: number, model: string): string {
  return count === 1
    ? `Generated 1 image with ${model}; it is shown to the user below this call.`
    : `Generated ${count} images with ${model}; they are shown to the user below this call.`
}

/**
 * The `modelName` of the output: the result's display name, trimmed and cut between code points to
 * `GENERATE_IMAGE_MODEL_NAME_MAX_CHARS`; undefined when the result has none (the text then names the model ref).
 */
export function outputModelName(modelName: unknown): string | undefined {
  if (typeof modelName !== 'string')
    return undefined
  let name = modelName.trim()
  if (name.length > GENERATE_IMAGE_MODEL_NAME_MAX_CHARS) {
    let cut = ''
    for (const char of name) {
      if (cut.length + char.length > GENERATE_IMAGE_MODEL_NAME_MAX_CHARS)
        break
      cut += char
    }
    name = cut
  }
  return name === '' ? undefined : name
}

function jsonBytes(value: string): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

/** The longest prefix of `text` whose JSON string takes at most `maxJsonBytes` bytes (cut between code points). */
export function fitJsonBytes(text: string, maxJsonBytes: number): string {
  if (jsonBytes(text) <= maxJsonBytes)
    return text
  // JSON escapes every code point on its own: sum their sizes after the two quotes.
  let bytes = 2
  let end = 0
  for (const char of text) {
    const size = jsonBytes(char) - 2
    if (bytes + size > maxJsonBytes)
      break
    bytes += size
    end += char.length
  }
  return text.slice(0, end)
}

/** The `generate_image` tool; `images` is `ctx.images` of `core-tools`. */
export function createGenerateImageTool(images: PluginImagesApi): ToolDefinition<GenerateImageToolInput, GenerateImageToolOutput> {
  return {
    name: GENERATE_IMAGE_TOOL_NAME,
    description: 'Generate images from a text prompt with the image model the user chose in Settings → Media. The images are stored and shown to the user below this call; the result lists them. Describe the subject, style, composition and any text to render in the prompt.',
    inputSchema: generateImageInputSchema,
    policy: 'ask',
    timeoutMs: GENERATE_IMAGE_TIMEOUT_MS,
    async execute(input, c) {
      const result = await images.generate({ ...input, chatId: c.chatId, signal: c.signal })
      if (result.images.length === 0)
        throw new HarnessError({ code: 'provider_error', message: 'The image model returned no image.' })
      const revisedPrompt = result.revisedPrompt === undefined ? '' : fitJsonBytes(result.revisedPrompt, GENERATE_IMAGE_REVISED_PROMPT_JSON_BYTES)
      const modelName = outputModelName(result.modelName)
      const output = generateImageToolOutputSchema.safeParse({
        modelRef: result.modelRef,
        ...(modelName === undefined ? {} : { modelName }),
        images: result.images.map(({ fileId, url, mediaType, name }) => ({ fileId, url, mediaType, name })),
        ...(result.costUsd === undefined ? {} : { costUsd: result.costUsd }),
        ...(revisedPrompt === '' ? {} : { revisedPrompt }),
      })
      if (!output.success)
        throw new HarnessError({ code: 'internal_error', message: 'The generated images cannot be listed: the image service returned an unexpected result.' })
      return output.data
    },
    toModelOutput(output): ToolResultOutput {
      const parsed = generateImageToolOutputSchema.safeParse(output)
      if (!parsed.success)
        return { type: 'json', value: (output ?? null) as JSONValue }
      return { type: 'text', value: generatedImagesText(parsed.data.images.length, parsed.data.modelName ?? parsed.data.modelRef) }
    },
  }
}
