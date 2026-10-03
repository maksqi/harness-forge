// Settings -> General rules (docs/UI.md 9.4, 9.11, docs/API.md 4.3 `Settings`): choices, labels and validation of the
// fields that save on blur, and the draft of such a field (shared with the Agent section). Limits come from the shared
// settings schema.
import type { ReasoningEffort, SendKey, ToolMode } from '@harness-forge/shared'
import type { Ref } from 'vue'
import { LIMITS, settingsSchema } from '@harness-forge/shared'
import { ref, watch } from 'vue'
import { TOOL_MODE_OPTIONS as PERMISSION_MENU_OPTIONS } from '~/components/chat/composer/permission'

export interface SettingChoice<T extends string> {
  value: T
  label: string
  description?: string
}

/**
 * The options of the composer's permission menu (docs/UI.md 7.11), same order, labels and descriptions: Ask · Accept
 * edits · Plan · Auto · Off. Accept edits and Plan (Phase 9) are valid defaults too: a new chat without a project treats
 * Accept edits like Ask and starts in Plan, which the server enforces (no workspace tools exist there).
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
 * A typed step limit: "Max steps per response" (`maxSteps`, chats without a project), "Max steps in project chats"
 * (`projectMaxSteps`) and, since Phase 9, "Sub-agent max steps" (`subagentMaxSteps`) are whole numbers from 1 to 200
 * (Phase 7, ADR-032; `maxSteps` was 1 to 100 before).
 */
export function parseMaxSteps(text: string): { value: number } | { error: string } {
  const trimmed = text.trim()
  const value = /^\d{1,3}$/.test(trimmed) ? Number(trimmed) : Number.NaN
  // The three settings share the bound `LIMITS.stepsMax`.
  return settingsSchema.shape.projectMaxSteps.safeParse(value).success
    ? { value }
    : { error: STEPS_ERROR }
}

// ---------- fields that save on blur ----------

/** The draft of a text field that saves on blur or Enter; Esc restores the saved value (docs/UI.md 9.4). */
export interface DraftField {
  draft: Ref<string>
  /** The user is editing: server updates do not replace the draft meanwhile. */
  focused: Ref<boolean>
  error: Ref<string | null>
  /** Back to the saved value, without an error. */
  restore: () => void
}

/** A draft that follows the saved value (`read`) unless the user is editing. */
export function useDraftField(read: () => string): DraftField {
  const draft = ref(read())
  const focused = ref(false)
  const error = ref<string | null>(null)
  watch(read, (value) => {
    if (!focused.value)
      draft.value = value
  })
  return {
    draft,
    focused,
    error,
    restore: () => {
      draft.value = read()
      error.value = null
    },
  }
}

/**
 * Commits a step limit (`maxSteps`, `projectMaxSteps`, `subagentMaxSteps`): an invalid value shows the error and keeps
 * the saved value; an unchanged value saves nothing; a failed save (`save` resolves false) restores the saved value.
 */
export async function commitStepsField(field: DraftField, saved: number, save: (value: number) => Promise<boolean>): Promise<void> {
  field.focused.value = false
  const parsed = parseMaxSteps(String(field.draft.value ?? ''))
  if ('error' in parsed) {
    field.error.value = parsed.error
    return
  }
  field.error.value = null
  field.draft.value = String(parsed.value)
  if (parsed.value !== saved && !(await save(parsed.value)))
    field.restore()
}

/** Enter in a field that saves on blur: leave the field (its blur handler saves). */
export function blurTarget(event: Event): void {
  (event.target as HTMLElement | null)?.blur()
}

/** Esc in a field that saves on blur: restore the saved value and leave the field without saving. */
export function cancelDraftEdit(field: DraftField, event: Event): void {
  field.restore()
  field.focused.value = false
  blurTarget(event)
}
