// Image generation DTOs (API.md section 4.18, ADR-028): the options and the metadata of image turns, and the input and
// output of the builtin `generate_image` tool of `core-tools`.
import { z } from 'zod'
import { fileIdSchema, modelRefSchema } from '../ids.ts'
import { LIMITS } from '../limits.ts'

/** Aspect ratios offered for generated images (the composer's "Auto" sends none). */
export const IMAGE_ASPECT_RATIOS = ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16'] as const

export const imageAspectRatioSchema = z.enum(IMAGE_ASPECT_RATIOS)
export type ImageAspectRatio = z.infer<typeof imageAspectRatioSchema>

/** Raster types a generated image is stored as; other generated files are dropped (notice `generated-file-dropped`). */
export const GENERATED_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

export const generatedImageMimeTypeSchema = z.enum(GENERATED_IMAGE_MIME_TYPES)
export type GeneratedImageMimeType = z.infer<typeof generatedImageMimeTypeSchema>

/** Images of one request: 1..`LIMITS.imagesPerTurnMax`. */
const imageCountSchema = z.int().min(1).max(LIMITS.imagesPerTurnMax)

/**
 * `ChatRequestBody.imageOptions`. The server accepts it only for an image model or a chat model with
 * `capabilities.imageOutput`, and `n` / `editPrevious` only for image models (`400` on `['imageOptions']` otherwise).
 */
export const imageOptionsSchema = z.strictObject({
  /** Images to generate; default 1. */
  n: imageCountSchema.optional(),
  /** Omitted = the provider default ("Auto"). */
  aspectRatio: imageAspectRatioSchema.optional(),
  /**
   * Image models: without attached images, the generated images of the parent reply are the input images (an edit of
   * the previous image); default true. `false` always generates a new image.
   */
  editPrevious: z.boolean().optional(),
})
export type ImageOptions = z.infer<typeof imageOptionsSchema>

/** `MessageMetadata.image` of an image-turn reply: set in the `start` metadata, completed in the `finish` metadata. */
export const imageTurnMetadataSchema = z.object({
  /** Images requested (placeholder tiles while generating). */
  n: imageCountSchema,
  aspectRatio: imageAspectRatioSchema.optional(),
  /** Input images sent with the prompt (0 = a new image). */
  inputs: z.int().min(0).max(LIMITS.imageInputsMax).optional(),
  /** The prompt as rewritten by the provider, when it reports one. */
  revisedPrompt: z.string().max(LIMITS.imagePromptMaxChars).optional(),
})
export type ImageTurnMetadata = z.infer<typeof imageTurnMetadataSchema>

/** Name of the builtin image tool (`core-tools`, policy `ask`). */
export const GENERATE_IMAGE_TOOL_NAME = 'generate_image'

/** Input of the `generate_image` tool. */
export const generateImageToolInputSchema = z.object({
  /** 1..32000 characters, trimmed. */
  prompt: z.string().trim().min(1).max(LIMITS.imagePromptMaxChars),
  /** Default 1. */
  n: imageCountSchema.optional(),
  aspectRatio: imageAspectRatioSchema.optional(),
})
export type GenerateImageToolInput = z.infer<typeof generateImageToolInputSchema>

/** One generated image stored as a file: the reference the `generate_image` tool returns. */
export const generatedImageRefSchema = z.object({
  fileId: fileIdSchema,
  /** `/api/files/<fileId>`. */
  url: z.string().startsWith('/api/files/'),
  mediaType: generatedImageMimeTypeSchema,
  /** File name, e.g. `image-1.png`. */
  name: z.string().min(1).max(255),
})
export type GeneratedImageRef = z.infer<typeof generatedImageRefSchema>

/**
 * Output of the `generate_image` tool (well under the 64 KB tool output cap: file references, never image bytes). The
 * chat pipeline appends one `file` part per image after the tool call, only for this output of `core-tools`.
 */
export const generateImageToolOutputSchema = z.object({
  /** The image model used. */
  modelRef: modelRefSchema,
  /**
   * Display name of the image model (the catalog name, else the model id; plugin API 1.2.0). Absent in outputs stored
   * before Phase 7: the model-facing text then names `modelRef`.
   */
  modelName: z.string().max(200).optional(),
  images: z.array(generatedImageRefSchema).min(1).max(LIMITS.imagesPerTurnMax),
  /** Estimated cost, added to the cost of the message. */
  costUsd: z.number().min(0).optional(),
  revisedPrompt: z.string().max(LIMITS.imagePromptMaxChars).optional(),
})
export type GenerateImageToolOutput = z.infer<typeof generateImageToolOutputSchema>
