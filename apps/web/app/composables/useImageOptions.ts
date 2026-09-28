// Image options of the composer (docs/UI.md 7.7, 11.3; ADR-028): the aspect ratio, the number of images and "Edit the
// previous image", remembered per browser for every chat in localStorage['hf-image-options'] and sent as the chat
// request's `imageOptions` only with image-capable models (useChatSession: `forModel(model)`). One state for the whole
// app: ImageOptionsMenu writes it (v-model), the chat request reads it. Storage that is missing, full or blocked
// degrades to options kept in memory.
// Stub (C12, P6-0b): implemented by W6.9 in P6-A; the signature of useImageOptions is frozen. This minimal version is
// already complete: defaults, validated persistence and the forModel() rules.
import type { CatalogModel, ImageOptions } from '@harness-forge/shared'
import type { Ref } from 'vue'
import { imageOptionsSchema } from '@harness-forge/shared'
import { readonly, ref } from 'vue'
import { readStoredJson, writeStoredJson } from '~/utils/storage'

export const IMAGE_OPTIONS_KEY = 'hf-image-options'

/**
 * Which image options a model takes: `image` = an image model (`kind: 'image'`: Images 1-4, aspect ratio, "Edit the
 * previous image"); `image-output` = a chat model with `capabilities.imageOutput` (the aspect ratio only).
 */
export type ImageOptionsScope = 'image' | 'image-output'

export interface ComposerImageOptions {
  /** The remembered options; default `{}` (= 1 image, Auto, edit the previous image). */
  options: Readonly<Ref<ImageOptions>>
  /**
   * Merges `patch` into the options (an `undefined` value clears that option, e.g. back to Auto), validates the result
   * with `imageOptionsSchema` and persists it; an invalid result changes nothing.
   */
  set: (patch: Partial<ImageOptions>) => void
  /**
   * What the next chat request sends as `imageOptions`: an image model -> `{ n?, aspectRatio?, editPrevious? }`; a chat
   * model with `capabilities.imageOutput` -> `{ aspectRatio }` when one is chosen, else undefined; any other model (or
   * none) -> undefined.
   */
  forModel: (model: CatalogModel | null | undefined) => ImageOptions | undefined
}

/** The image options `model` takes, or null (no ImageOptionsMenu, no `imageOptions` in the request). */
export function imageOptionsScope(model: CatalogModel | null | undefined): ImageOptionsScope | null {
  if (!model)
    return null
  if (model.kind === 'image')
    return 'image'
  if (model.kind === 'chat' && model.capabilities.imageOutput)
    return 'image-output'
  return null
}

/** Drops keys whose value is undefined (a JSON-clean copy). */
function compact(options: ImageOptions): ImageOptions {
  return Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) as ImageOptions
}

/** The `forModel()` rule as a pure function of the options and the model. */
export function imageOptionsForModel(options: ImageOptions, model: CatalogModel | null | undefined): ImageOptions | undefined {
  const scope = imageOptionsScope(model)
  if (scope === 'image')
    return compact({ n: options.n, aspectRatio: options.aspectRatio, editPrevious: options.editPrevious })
  if (scope === 'image-output' && options.aspectRatio)
    return { aspectRatio: options.aspectRatio }
  return undefined
}

function forgetStoredOptions(): void {
  try {
    globalThis.localStorage?.removeItem(IMAGE_OPTIONS_KEY)
  }
  catch {
    // Blocked storage: nothing to forget.
  }
}

/** The stored options; a missing, unreadable or invalid stored value gives `{}` (and is removed). */
export function readStoredImageOptions(): ImageOptions {
  const parsed = imageOptionsSchema.safeParse(readStoredJson(IMAGE_OPTIONS_KEY))
  if (parsed.success)
    return compact(parsed.data)
  forgetStoredOptions()
  return {}
}

function createImageOptions(): ComposerImageOptions {
  const options = ref<ImageOptions>(readStoredImageOptions())

  function set(patch: Partial<ImageOptions>): void {
    const parsed = imageOptionsSchema.safeParse(compact({ ...options.value, ...patch }))
    if (!parsed.success)
      return
    options.value = compact(parsed.data)
    writeStoredJson(IMAGE_OPTIONS_KEY, options.value)
  }

  return {
    options: readonly(options),
    set,
    forModel: model => imageOptionsForModel(options.value, model),
  }
}

let shared: ComposerImageOptions | undefined

/** The app-wide image options (created on first use from localStorage). */
export function useImageOptions(): ComposerImageOptions {
  shared ??= createImageOptions()
  return shared
}
