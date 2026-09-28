// Settings -> Appearance choices (docs/UI.md 3.5, 9.5). The theme lives in `useColorMode().preference` (stored by
// @nuxtjs/color-mode as `hf-color-mode`); density, text size and reading font are server settings applied to <html>.
import type { Density, ReadingFont, TextSize } from '@harness-forge/shared'
import type { SettingChoice } from './general'

export const READING_FONT_OPTIONS: ReadonlyArray<SettingChoice<ReadingFont> & { fontClass: string }> = [
  { value: 'sans', label: 'Sans', fontClass: 'font-sans' },
  { value: 'serif', label: 'Serif', fontClass: 'font-serif' },
]

export const TEXT_SIZE_OPTIONS: ReadonlyArray<SettingChoice<TextSize>> = [
  { value: 'sm', label: 'Small' },
  { value: 'md', label: 'Medium' },
  { value: 'lg', label: 'Large' },
]

export const DENSITY_OPTIONS: ReadonlyArray<SettingChoice<Density>> = [
  { value: 'comfortable', label: 'Comfortable' },
  { value: 'compact', label: 'Compact' },
]

export const READING_SAMPLE = 'The quick brown fox jumps over the lazy dog.'

/** True when `value` is one of `options` (a single ToggleGroup emits '' when its active item is clicked again). */
export function isChoice<T extends string>(options: ReadonlyArray<SettingChoice<T>>, value: unknown): value is T {
  return typeof value === 'string' && options.some(option => option.value === value)
}
