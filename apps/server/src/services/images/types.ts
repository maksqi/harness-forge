// Frozen interface of image generation (ADR-028, ARCHITECTURE.md 6.11, API.md 4.18). Implementation:
// `createImageService(deps)` in `services/images/index.ts` (W6.4; a stub that answers `not_implemented` until then).
// Consumers: the image turns of the chat pipeline (`chat/images.ts`, W6.1) and `ctx.images.generate` of plugins (the
// builtin `generate_image` tool of `core-tools`, W6.4). There is no image route and no image table: every image is
// stored as a file (`FilesService.saveGenerated`) and referenced by its `/api/files/<id>` URL.
import type { ImageAspectRatio } from '@harness-forge/shared'
import type { ResolvedImageModel } from '../../providers/types.ts'
import type { StoredFile } from '../files/types.ts'

/** Input of `ImageService.generate`: one image request. */
export interface ImageGenerationInput {
  /**
   * The image model, already resolved (image turns: `providers.resolveImageModel` in `chat/prepare.ts`). Wins over
   * `modelRef`.
   */
  resolved?: ResolvedImageModel
  /**
   * An image model ref resolved by the service with `providers.resolveImageModel` (`ctx.images.generate`). Without
   * `resolved` and `modelRef` the `imageModelRef` setting is used; when that is null too -> `validation_error`
   * "Choose an image model in Settings → Media.".
   */
  modelRef?: string
  /**
   * The prompt: the text of an image turn after slash-command expansion, or the `generate_image` prompt. Trimmed;
   * empty or longer than `LIMITS.imagePromptMaxChars` -> `validation_error`. Never logged.
   */
  prompt: string
  /**
   * Stored files sent as input images (an edit): `files` ids of images, read with `FilesService.read`. At most
   * `LIMITS.imageInputsMax`; an unknown id -> `not_found`; empty or omitted = a new image.
   */
  inputFileIds?: readonly string[]
  /** Images to generate: 1..`LIMITS.imagesPerTurnMax` (else `validation_error`). */
  n: number
  /** Omitted = the provider default ("Auto"); mapped by `ProviderDefinition.imageParams`. */
  aspectRatio?: ImageAspectRatio
  /**
   * Aborts the provider call (the run signal of an image turn, the tool call signal of `generate_image`). An aborted
   * call rejects with the abort reason and records no provider outcome.
   */
  signal: AbortSignal
  /** The chat of the usage row (`null`: none, e.g. a plugin call without a chat). */
  chatId: string | null
  /** The assistant message of the usage row (`null`: none, e.g. a tool call or a plugin). */
  messageId: string | null
}

/** One generated image, stored as a file. */
export interface StoredImage {
  /** The `files` row: `mime` is one of `GENERATED_IMAGE_MIME_TYPES`, `name` e.g. `image-1.png`. */
  file: StoredFile
  /** `/api/files/<file.id>`: the `url` of the UI `file` part. */
  url: string
}

/** Token usage of one generation, as reported by the provider. */
export interface ImageGenerationUsage {
  /** Prompt tokens (0 when the provider reports usage without this field). */
  inputTokens: number
  /** Image output tokens (0 when not reported). */
  outputTokens: number
  /** As reported, else `inputTokens + outputTokens`. */
  totalTokens: number
}

/** Result of `ImageService.generate`. */
export interface ImageGenerationResult {
  /** The image model used (`providerId:modelId`). */
  modelRef: string
  /**
   * Phase 7 (plugin API 1.2.0, W7.6): the display name of the model, the catalog name, else the model id; passed on as
   * `ImageGenerateResult.modelName` and the `generate_image` output `modelName`. The image service always sets it;
   * optional only so that results built by hand (test doubles written before Phase 7) stay valid: readers fall back to
   * the model id of `modelRef` (`resultModelName`).
   */
  modelName?: string
  /** The stored images, in the order the provider returned them (may be empty when every image was dropped). */
  images: StoredImage[]
  /** `null` when the provider reports no token usage (xAI). */
  usage: ImageGenerationUsage | null
  /**
   * Estimated cost: `usage` times the catalog's per-1M-token input and output prices of the model; `null` when the usage
   * or a price is unknown (the web labels it "estimated").
   */
  costUsd: number | null
  /** The prompt as rewritten by the provider (the first image's `revisedPrompt` in the provider metadata), if any. */
  revisedPrompt?: string
  /** Images the provider returned that `saveGenerated` refused (not an allowed raster type, too large, bad bytes). */
  dropped: number
}

/**
 * Image generation through the user's own image models (ADR-028). `generate` resolves the model (see
 * `ImageGenerationInput`), maps the request with `definition.imageParams({ n, aspectRatio, inputs }, info)` to `size` /
 * `aspectRatio` / `providerOptions`, runs `generateImage` (the prompt with the input images read from `files`), stores
 * every image with `files.saveGenerated` (refused ones counted in `dropped`), writes one usage row (`purpose: 'image'`,
 * `chats.addUsage`, the input's `chatId` / `messageId`) and records the provider outcome (`providers.recordOutcome`).
 * Errors: `validation_error` (input, no model, and the resolver errors of `resolveImageModel`), `not_found` (an input
 * file), provider errors mapped with `providers.mapError` (API.md 2.3). Logs carry provider, model, `n`, bytes and ms,
 * never the prompt.
 */
export interface ImageService {
  readonly generate: (input: ImageGenerationInput) => Promise<ImageGenerationResult>
}
