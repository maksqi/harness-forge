// Image generation (ADR-028, ARCHITECTURE.md 6.11, API.md 4.18). Owner: W6.4. Implements `ImageService` (./types.ts)
// behind `createImageService(deps)`.
//
// `generate(input)`:
//   1. checks the input: prompt (trimmed, 1..`LIMITS.imagePromptMaxChars` characters), `n` (1..`imagesPerTurnMax`),
//      aspect ratio, at most `imageInputsMax` input files (`validation_error`);
//   2. resolves the model: `input.resolved`, else `providers.resolveImageModel(input.modelRef ?? settings.imageModelRef)`
//      (neither -> `validation_error` "Choose an image model in Settings → Media.");
//   3. reads the input images from `files` (`not_found`; a file that is not a raster image -> `validation_error`);
//   4. maps the request with `definition.imageParams({ n, aspectRatio, inputs }, info)` (checked plugin data; a throw is
//      ignored); a provider without `imageParams` gets the aspect ratio as is;
//   5. runs `generateImage` with the caller's signal (an abort rejects with the signal's reason and records no provider
//      outcome) and `IMAGE_MAX_RETRIES`; failures go through `providers.mapError` (an empty result is a
//      `provider_error`) and provider failures are recorded as the provider outcome;
//   6. writes one usage row (`purpose: 'image'`, estimated cost from the catalog prices), records the outcome and stores
//      every image through `files.saveGenerated`: a refused image (type, size, bytes) counts in `dropped`.
// The log line carries provider, model, `n`, aspect ratio, input count, stored / dropped counts, bytes, usage, cost and
// milliseconds; never the prompt.
import type { ImageParamsRequest, ImageParamsResult } from '@harness-forge/plugin-sdk'
import type { ImageAspectRatio } from '@harness-forge/shared'
import type { GeneratedFile, GenerateImageResult } from 'ai'
import type { Logger } from '../../logger.ts'
import type { ProviderCallOutcome, ResolvedImageModel } from '../../providers/types.ts'
import type { AppDeps } from '../../types.ts'
import type { ImageGenerationInput, ImageGenerationResult, ImageGenerationUsage, ImageService, StoredImage } from './types.ts'
import { performance } from 'node:perf_hooks'
import { HarnessError, IMAGE_ASPECT_RATIOS, isHarnessError, LIMITS, validationError } from '@harness-forge/shared'
import { generateImage, NoImageGeneratedError } from 'ai'
import { fileUrl } from '../files/index.ts'
import { canonicalMime, extensionForMime } from '../files/sniff.ts'
import { imageCost, imageUsage, revisedPromptOf, sanitizeImageParams } from './generation.ts'

/** The error of a generation without a model (the `generate_image` error text of ADR-028). */
export const NO_IMAGE_MODEL_MESSAGE = 'Choose an image model in Settings → Media.'

/** Retries of a failed image model call (`generateImage` retries 429 / 5xx / network errors; each try may be billed). */
export const IMAGE_MAX_RETRIES = 1

/** Codes that come from the provider call (recorded as the provider's call outcome). */
const PROVIDER_ERROR_CODES: ReadonlySet<string> = new Set([
  'auth_invalid',
  'rate_limited',
  'model_not_found',
  'context_overflow',
  'provider_unreachable',
  'provider_error',
])

interface CheckedInput {
  prompt: string
  n: number
  aspectRatio?: ImageAspectRatio
  inputFileIds: readonly string[]
}

interface StoredImages {
  images: StoredImage[]
  dropped: number
  /** Bytes of the stored images. */
  bytes: number
}

function invalid(path: string, message: string): HarnessError {
  return validationError([{ path: [path], message, code: 'custom' }], message)
}

/** The reason of an aborted signal (an `AbortError` `DOMException` when it has none). */
function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')
}

function isImageAspectRatio(value: unknown): value is ImageAspectRatio {
  return typeof value === 'string' && (IMAGE_ASPECT_RATIOS as readonly string[]).includes(value)
}

/** Step 1 of `generate` (see the header). */
function checkInput(input: ImageGenerationInput): CheckedInput {
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
  if (prompt === '' || Array.from(prompt).length > LIMITS.imagePromptMaxChars)
    throw invalid('prompt', `The image prompt must have 1-${LIMITS.imagePromptMaxChars} characters.`)
  if (!Number.isInteger(input.n) || input.n < 1 || input.n > LIMITS.imagesPerTurnMax)
    throw invalid('n', `Generate 1-${LIMITS.imagesPerTurnMax} images.`)
  if (input.aspectRatio !== undefined && !isImageAspectRatio(input.aspectRatio))
    throw invalid('aspectRatio', `The aspect ratio must be one of ${IMAGE_ASPECT_RATIOS.join(', ')}.`)
  const inputFileIds = input.inputFileIds ?? []
  if (!Array.isArray(inputFileIds) || inputFileIds.some(id => typeof id !== 'string'))
    throw invalid('inputFileIds', 'Input images must be file ids.')
  if (inputFileIds.length > LIMITS.imageInputsMax)
    throw invalid('inputFileIds', `At most ${LIMITS.imageInputsMax} input images.`)
  return { prompt, n: input.n, ...(input.aspectRatio === undefined ? {} : { aspectRatio: input.aspectRatio }), inputFileIds }
}

/** A refusal of `saveGenerated` (the image is dropped); any other failure fails the generation. */
function isRefusal(error: unknown): boolean {
  return isHarnessError(error) && (error.code === 'validation_error' || error.code === 'payload_too_large')
}

export function createImageService(deps: AppDeps): ImageService {
  async function resolveModel(input: ImageGenerationInput): Promise<ResolvedImageModel> {
    if (input.resolved !== undefined)
      return input.resolved
    const modelRef = input.modelRef ?? (await deps.settings.get()).imageModelRef
    if (modelRef === null || modelRef === undefined)
      throw invalid('modelRef', NO_IMAGE_MODEL_MESSAGE)
    return deps.providers.resolveImageModel(modelRef, { signal: input.signal })
  }

  /** Step 3: the bytes of the input images. */
  async function readInputImages(ids: readonly string[]): Promise<Uint8Array[]> {
    const images: Uint8Array[] = []
    for (const id of ids) {
      const { file, data } = await deps.files.read(id)
      if (!file.mime.startsWith('image/') || file.mime === 'image/svg+xml')
        throw invalid('inputFileIds', `The file "${file.name}" is not a raster image, so it cannot be sent to an image model.`)
      images.push(data)
    }
    return images
  }

  /** Step 4: `size` / `aspectRatio` / `providerOptions` of the call. */
  function callParams(resolved: ResolvedImageModel, request: ImageParamsRequest, log: Logger): ImageParamsResult {
    const definition = resolved.provider.definition
    if (definition.imageParams === undefined)
      return request.aspectRatio === undefined ? {} : { aspectRatio: request.aspectRatio }
    try {
      return sanitizeImageParams(definition.imageParams(request, resolved.info))
    }
    catch (error) {
      log.warn('provider imageParams() failed', { providerId: resolved.providerId, err: error })
      return {}
    }
  }

  function mapError(resolved: ResolvedImageModel, error: unknown): HarnessError {
    if (isHarnessError(error))
      return error instanceof HarnessError ? error : HarnessError.from(error)
    if (NoImageGeneratedError.isInstance(error)) {
      return new HarnessError(
        { code: 'provider_error', message: `${resolved.provider.definition.name} returned no image.`, providerId: resolved.providerId, action: 'retry' },
        { cause: error },
      )
    }
    return deps.providers.mapError(resolved.providerId, error)
  }

  async function recordOutcome(providerId: string, outcome: ProviderCallOutcome, log: Logger): Promise<void> {
    try {
      await deps.providers.recordOutcome(providerId, outcome)
    }
    catch (error) {
      log.warn('cannot record the provider outcome', { providerId, err: error })
    }
  }

  async function recordUsage(input: ImageGenerationInput, resolved: ResolvedImageModel, usage: ImageGenerationUsage | null, costUsd: number | null, log: Logger): Promise<void> {
    try {
      await deps.chats.addUsage({
        chatId: input.chatId,
        messageId: input.messageId,
        purpose: 'image',
        providerId: resolved.providerId,
        modelId: resolved.modelId,
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd,
      })
    }
    catch (error) {
      log.error('cannot record the image usage', { providerId: resolved.providerId, modelId: resolved.modelId, err: error })
    }
  }

  /** Step 6: every image through `saveGenerated`, in the order the provider returned them. */
  async function storeImages(resolved: ResolvedImageModel, generated: readonly GeneratedFile[], log: Logger): Promise<StoredImages> {
    const images: StoredImage[] = []
    let dropped = 0
    let bytes = 0
    for (const [index, image] of generated.entries()) {
      const mediaType = canonicalMime(image.mediaType)
      const drop = (size: number, reason: string): void => {
        dropped += 1
        log.warn('generated image dropped', { providerId: resolved.providerId, modelId: resolved.modelId, mediaType: mediaType || 'unknown', bytes: size, reason })
      }
      let data: Uint8Array
      try {
        data = image.uint8Array
      }
      catch {
        drop(0, 'undecodable')
        continue
      }
      try {
        const file = await deps.files.saveGenerated({ data, mediaType: image.mediaType, name: `image-${index + 1}${extensionForMime(mediaType)}` })
        images.push({ file, url: fileUrl(file.id) })
        bytes += file.size
      }
      catch (error) {
        if (!isRefusal(error))
          throw isHarnessError(error) ? error : new HarnessError({ code: 'internal_error', message: 'The generated images could not be stored.' }, { cause: error })
        drop(data.byteLength, (error as HarnessError).code)
      }
    }
    return { images, dropped, bytes }
  }

  async function generate(input: ImageGenerationInput): Promise<ImageGenerationResult> {
    const { signal } = input
    if (signal.aborted)
      throw abortReason(signal)
    const checked = checkInput(input)
    const resolved = await resolveModel(input)
    const inputImages = await readInputImages(checked.inputFileIds)
    if (signal.aborted)
      throw abortReason(signal)
    const log = input.chatId === null ? deps.logger : deps.logger.child({ chatId: input.chatId })
    const facts = { providerId: resolved.providerId, modelId: resolved.modelId, n: checked.n, aspectRatio: checked.aspectRatio ?? 'auto', inputs: inputImages.length }
    const request: ImageParamsRequest = {
      n: checked.n,
      ...(checked.aspectRatio === undefined ? {} : { aspectRatio: checked.aspectRatio }),
      inputs: inputImages.length,
    }
    const params = callParams(resolved, request, log)
    const started = performance.now()
    const elapsed = (): number => Math.round(performance.now() - started)

    let result: GenerateImageResult
    try {
      result = await generateImage({
        model: resolved.imageModel,
        prompt: inputImages.length === 0 ? checked.prompt : { text: checked.prompt, images: inputImages },
        n: checked.n,
        ...(params.size === undefined ? {} : { size: params.size }),
        ...(params.aspectRatio === undefined ? {} : { aspectRatio: params.aspectRatio }),
        ...(params.providerOptions === undefined ? {} : { providerOptions: params.providerOptions }),
        abortSignal: signal,
        maxRetries: IMAGE_MAX_RETRIES,
      })
    }
    catch (error) {
      if (signal.aborted)
        throw abortReason(signal)
      const mapped = mapError(resolved, error)
      log.warn('image generation failed', { ...facts, code: mapped.code, ...(mapped.status === undefined ? {} : { status: mapped.status }), ms: elapsed() })
      if (PROVIDER_ERROR_CODES.has(mapped.code))
        await recordOutcome(resolved.providerId, { ok: false, error: mapped.toJSON().error }, log)
      throw mapped
    }

    // The provider answered (and billed): the usage row is written even when the caller stopped meanwhile.
    const usage = imageUsage(result.usage)
    const costUsd = imageCost(result.usage, resolved.entry.cost)
    await recordUsage(input, resolved, usage, costUsd, log)
    if (signal.aborted)
      throw abortReason(signal)
    await recordOutcome(resolved.providerId, { ok: true }, log)
    const stored = await storeImages(resolved, result.images, log)
    const revisedPrompt = revisedPromptOf(result.images)
    log.info('image generated', {
      ...facts,
      stored: stored.images.length,
      dropped: stored.dropped,
      bytes: stored.bytes,
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      costUsd,
      ms: elapsed(),
    })
    return {
      modelRef: resolved.modelRef,
      // Phase 7 (plugin API 1.2.0): the display name of the catalog entry, else the model id (W7.6 owns the rule).
      modelName: resolved.entry.name || resolved.modelId,
      images: stored.images,
      usage,
      costUsd,
      ...(revisedPrompt === undefined ? {} : { revisedPrompt }),
      dropped: stored.dropped,
    }
  }

  return { generate }
}
