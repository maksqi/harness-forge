// Settings -> General rules (docs/UI.md 9.4, docs/API.md 4.3 `Settings`): choices, labels and validation of the
// fields that save on blur. Limits come from the shared settings schema.
import type { ReasoningEffort, SendKey, ToolMode } from '@harness-forge/shared'
import { LIMITS, settingsSchema } from '@harness-forge/shared'
import { TOOL_MODE_OPTIONS as PERMISSION_MENU_OPTIONS } from '~/components/chat/composer/permission'

export interface SettingChoice<T extends string> {
  value: T
  label: string
  description?: string
}

/**
 * The options of the composer's permission menu (docs/UI.md 7.11), same order, labels and descriptions: Ask · Accept
 * edits · Auto · Off. Accept edits is a valid default too; a new chat without a project treats it like Ask.
 */
export const TOOL_MODE_OPTIONS: ReadonlyArray<SettingChoice<ToolMode>> = PERMISSION_MENU_OPTIONS
  .map(({ value, label, description }) => ({ value, label, description }))

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

export const STEPS_MAX = LIMITS.stepsMax
export const STEPS_ERROR = `Enter a whole number from 1 to ${STEPS_MAX}.`

/**
 * A typed step limit: "Max steps per response" (`maxSteps`, chats without a project) and "Max steps in project chats"
 * (`projectMaxSteps`) are both whole numbers from 1 to 200 (Phase 7, ADR-032; `maxSteps` was 1 to 100 before).
 */
export function parseMaxSteps(text: string): { value: number } | { error: string } {
  const trimmed = text.trim()
  const value = /^\d{1,3}$/.test(trimmed) ? Number(trimmed) : Number.NaN
  // Both settings share the bound `LIMITS.stepsMax`.
  return settingsSchema.shape.projectMaxSteps.safeParse(value).success
    ? { value }
    : { error: STEPS_ERROR }
}
