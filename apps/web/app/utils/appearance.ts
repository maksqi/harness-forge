// Density, text size and reading font (docs/UI.md 3.5): attributes on <html> (`data-density`, `data-text-size`,
// `data-reading-font`), cached in localStorage['hf-appearance'] so `plugins/appearance.client.ts` can apply them
// before the app mounts. Auto-imported (utils/).
import type { Settings } from '@harness-forge/shared'
import { densitySchema, readingFontSchema, textSizeSchema } from '@harness-forge/shared'
import { z } from 'zod'
import { readStoredJson, writeStoredJson } from './storage'

export type AppearanceSettings = Pick<Settings, 'density' | 'textSize' | 'readingFont'>

export const APPEARANCE_STORAGE_KEY = 'hf-appearance'

/** Settings keys that change the appearance (`settings.update()` re-applies them). */
export const APPEARANCE_KEYS = ['density', 'textSize', 'readingFont'] as const satisfies ReadonlyArray<keyof Settings>

const appearanceSchema = z.object({
  density: densitySchema,
  textSize: textSizeSchema,
  readingFont: readingFontSchema,
})

/** The appearance part of the settings. */
export function pickAppearance(settings: AppearanceSettings): AppearanceSettings {
  return { density: settings.density, textSize: settings.textSize, readingFont: settings.readingFont }
}

/** Sets the three attributes on `root` (default `<html>`). */
export function applyAppearanceToDocument(appearance: AppearanceSettings, root?: HTMLElement): void {
  const element = root ?? (typeof document === 'undefined' ? undefined : document.documentElement)
  if (!element)
    return
  element.dataset.density = appearance.density
  element.dataset.textSize = appearance.textSize
  element.dataset.readingFont = appearance.readingFont
}

/** The cached appearance, or null when missing or invalid. */
export function readCachedAppearance(): AppearanceSettings | null {
  const parsed = appearanceSchema.safeParse(readStoredJson(APPEARANCE_STORAGE_KEY))
  return parsed.success ? parsed.data : null
}

export function cacheAppearance(appearance: AppearanceSettings): void {
  writeStoredJson(APPEARANCE_STORAGE_KEY, pickAppearance(appearance))
}
