// Settings -> General rules (docs/UI.md 9.4, docs/API.md 4.3 `Settings`): choices, labels and validation of the
// fields that save on blur. Limits come from the shared settings schema.
import type { ReasoningEffort, SendKey, ToolMode } from '@harness-forge/shared'
import { LIMITS, settingsSchema } from '@harness-forge/shared'

export interface SettingChoice<T extends string> {
  value: T
  label: string
  description?: string
}

/** Same labels and descriptions as the composer's permission menu (docs/UI.md 7.11). */
export const TOOL_MODE_OPTIONS: ReadonlyArray<SettingChoice<ToolMode>> = [
  { value: 'ask', label: 'Ask', description: 'Ask before tools that can change things' },
  { value: 'auto', label: 'Auto', description: 'Run tools without asking, except ones marked always-ask' },
  { value: 'off', label: 'Off', description: 'Don\'t use tools' },
]

/** Same order as the composer's effort menu (docs/UI.md 7.10); models without reasoning ignore it. */
export const EFFORT_OPTIONS: ReadonlyArray<SettingChoice<ReasoningEffort>> = [
  { value: 'auto', label: 'Auto', description: 'Provider default' },
  { value: 'off', label: 'Off' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'max', label: 'Max' },
]

/** "Enter" and "⌘ Enter" (macOS) / "Ctrl Enter" (elsewhere). */
export function sendKeyOptions(mac: boolean): ReadonlyArray<SettingChoice<SendKey>> {
  return [
    { value: 'enter', label: 'Enter' },
    { value: 'mod-enter', label: mac ? '⌘ Enter' : 'Ctrl Enter' },
  ]
}

export const DISPLAY_NAME_MAX = 64
export const INSTRUCTIONS_MAX = LIMITS.instructionsMaxChars

/** An error message, or null when `value` (already trimmed) is a valid display name. */
export function displayNameError(value: string): string | null {
  return settingsSchema.shape.displayName.safeParse(value).success
    ? null
    : `Use at most ${DISPLAY_NAME_MAX} characters.`
}

/** An error message, or null when the instructions fit. */
export function instructionsError(value: string): string | null {
  return settingsSchema.shape.instructions.safeParse(value).success
    ? null
    : `Use at most ${INSTRUCTIONS_MAX.toLocaleString('en-US')} characters.`
}

/**
 * The typed "Max steps per response": a whole number from 1 to 100. The setting accepts up to 200 since Phase 7; the
 * field keeps its v1.2 bound of 100 until W7.12 raises it with the `projectMaxSteps` field.
 */
export function parseMaxSteps(text: string): { value: number } | { error: string } {
  const trimmed = text.trim()
  const value = /^\d{1,3}$/.test(trimmed) ? Number(trimmed) : Number.NaN
  return value <= 100 && settingsSchema.shape.maxSteps.safeParse(value).success
    ? { value }
    : { error: 'Enter a whole number from 1 to 100.' }
}
