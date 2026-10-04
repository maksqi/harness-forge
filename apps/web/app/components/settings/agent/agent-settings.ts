// Rules of the Agent section of Settings -> General (docs/UI.md 9.11): the "none" label of its model selects, the
// warning of a sub-agent model that can't call tools and (Phase 10, ADR-047) the check of the plan folder, which uses
// the shared settings schema, so the inline errors are the server's rules.
import type { CatalogModel } from '@harness-forge/shared'
import { DEFAULT_SETTINGS, PLAN_DIRECTORY_MAX_CHARS, settingsSchema } from '@harness-forge/shared'

/** The "none" choice of the compaction and sub-agent model selects (the setting is null). */
export const SAME_MODEL_LABEL = 'Same model as the chat'

/**
 * The warning of the Sub-agent model field: a sub-agent works through tools, so a catalog model without
 * `capabilities.tools` can't run one. Null for a model that can call tools and for one the catalog does not know (the
 * select shows its unknown state; the server falls back to the chat's model).
 */
export function subagentModelWarning(model: Pick<CatalogModel, 'name' | 'capabilities'> | undefined): string | null {
  if (!model || model.capabilities.tools)
    return null
  return `${model.name} can't call tools, so sub-agents can't use it.`
}

// ---------- plan files (Phase 10) ----------

/** The placeholder of the Plan folder field: the default folder (`.harness/plans`). */
export const PLAN_DIRECTORY_PLACEHOLDER = DEFAULT_SETTINGS.planDirectory

export const PLAN_DIRECTORY_FOLDER_ERROR = 'Use a folder inside the project, like .harness/plans.'
export const PLAN_DIRECTORY_LENGTH_ERROR = `Use at most ${PLAN_DIRECTORY_MAX_CHARS} characters.`

/**
 * An error message, or null when `value` is a valid plan folder (`planDirectory`): the shared schema trims it and
 * accepts a relative path inside the project (not empty, not absolute, no drive letter, no `.` / `..` / `.git`
 * segment, no control characters) of at most 200 characters.
 */
export function planDirectoryError(value: string): string | null {
  const result = settingsSchema.shape.planDirectory.safeParse(value)
  if (result.success)
    return null
  return result.error.issues.some(issue => issue.code === 'too_big') ? PLAN_DIRECTORY_LENGTH_ERROR : PLAN_DIRECTORY_FOLDER_ERROR
}
