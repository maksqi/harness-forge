// Image options menu helpers (docs/UI.md 7.7; ADR-028): the aspect ratio choices (Auto + the 7 ratios), the image
// counts, the trigger summary ("16:9 · 2", "Auto") with its accessible name, and the shape preview of a ratio.
import type { ImageAspectRatio, ImageOptions } from '@harness-forge/shared'
import type { ImageOptionsScope } from '~/composables/useImageOptions'
import { IMAGE_ASPECT_RATIOS, LIMITS } from '@harness-forge/shared'

/** An "Aspect ratio" choice: `auto` sends none (the provider default). */
export type AspectChoice = 'auto' | ImageAspectRatio

export const ASPECT_CHOICES: readonly AspectChoice[] = ['auto', ...IMAGE_ASPECT_RATIOS]

/** "Images": 1 .. LIMITS.imagesPerTurnMax. */
export const IMAGE_COUNTS: readonly number[] = Array.from({ length: LIMITS.imagesPerTurnMax }, (_, index) => index + 1)

export function isAspectRatio(value: unknown): value is ImageAspectRatio {
  return typeof value === 'string' && (IMAGE_ASPECT_RATIOS as readonly string[]).includes(value)
}

export function aspectChoiceLabel(choice: AspectChoice): string {
  return choice === 'auto' ? 'Auto' : choice
}

/** Trigger text: "16:9 · 2", "Auto · 3", "Auto"; a chat model with image output shows the aspect ratio only. */
export function imageOptionsSummary(options: ImageOptions, scope: ImageOptionsScope): string {
  const aspect = options.aspectRatio ?? 'Auto'
  const count = options.n ?? 1
  return scope === 'image' && count > 1 ? `${aspect} · ${count}` : aspect
}

/** Accessible name of the trigger: "Image options: 16:9, 2 images" (image-output chat models: the ratio only). */
export function imageOptionsLabel(options: ImageOptions, scope: ImageOptionsScope): string {
  const aspect = options.aspectRatio ?? 'Auto'
  if (scope !== 'image')
    return `Image options: ${aspect}`
  const count = options.n ?? 1
  return `Image options: ${aspect}, ${count} ${count === 1 ? 'image' : 'images'}`
}

/** Pixel size of the preview of `choice` inside a `box` px square (Auto: the full square). */
export function aspectShape(choice: AspectChoice, box = 16): { width: number, height: number } {
  if (choice === 'auto')
    return { width: box, height: box }
  const [width = 1, height = 1] = choice.split(':').map(Number)
  return width >= height
    ? { width: box, height: Math.max(1, Math.round((box * height) / width)) }
    : { width: Math.max(1, Math.round((box * width) / height)), height: box }
}
