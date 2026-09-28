// Theme choices shared by ThemeToggle (and reusable by the palette and Settings -> Appearance).
import type { Component } from 'vue'
import { MonitorIcon, MoonIcon, SunIcon } from '@lucide/vue'
import { testIds } from '~/utils/testids'

export type ThemePreference = 'dark' | 'light' | 'system'

export interface ThemeOption {
  value: ThemePreference
  label: string
  icon: Component
  testId: string
}

export const THEME_OPTIONS: readonly ThemeOption[] = [
  { value: 'dark', label: 'Dark', icon: MoonIcon, testId: testIds.themeDark },
  { value: 'light', label: 'Light', icon: SunIcon, testId: testIds.themeLight },
  { value: 'system', label: 'System', icon: MonitorIcon, testId: testIds.themeSystem },
]

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'dark' || value === 'light' || value === 'system'
}

/** Unknown stored values read as dark, the default theme. */
export function normalizeThemePreference(value: unknown): ThemePreference {
  return isThemePreference(value) ? value : 'dark'
}
