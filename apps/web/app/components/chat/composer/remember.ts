// Remember (docs/UI.md 7.30, 11.7, 15; docs/API.md 4.30, 5.29; ADR-047): the "Save to" targets of RememberDialog with
// their copy, the default target, the counter, the success toast and the inline error text. Pure: no Vue, no stores.
// Signatures frozen from Gate P10-0b (C33); W10.9 owns the copy and the details.
import type { HarnessError, ProjectSummary, RememberResult, RememberTarget } from '@harness-forge/shared'
import { LIMITS, rememberTargetSchema } from '@harness-forge/shared'

/** The targets in display order; the project ones need a saved project chat. */
export const REMEMBER_TARGETS: readonly { value: RememberTarget, needsProject: boolean }[] = [
  { value: 'project-file', needsProject: true },
  { value: 'project-instructions', needsProject: true },
  { value: 'global', needsProject: false },
]

/** `localStorage` key of the last chosen target (the raw target value). */
export const REMEMBER_TARGET_KEY = 'hf-remember-target'

/** The reason shown on a disabled project target. */
export const REMEMBER_NEEDS_PROJECT = 'Open a chat in a project to use this.'

/** The note's length cap (`LIMITS.rememberTextMaxChars`, counted after trimming like the server does). */
export const REMEMBER_TEXT_MAX = LIMITS.rememberTextMaxChars

/** The inline message of a note over the cap. */
export const REMEMBER_TOO_LONG = `Use at most ${REMEMBER_TEXT_MAX.toLocaleString('en-US')} characters.`

/** The counter under the note: "{n} / 2,000". */
export function rememberCounter(length: number): string {
  return `${length.toLocaleString('en-US')} / ${REMEMBER_TEXT_MAX.toLocaleString('en-US')}`
}

/** The project a target names (null outside a project, or before the projects store knows it). */
export type RememberProject = Pick<ProjectSummary, 'name' | 'instructionsFile'>

/**
 * The label and the description of a target: "{file} in {project}" ("AGENTS.md in {project} (new file)" when the
 * project has neither file), "Instructions of {project}", "Custom instructions". Without a known project the label
 * names "a project" (the target is disabled then).
 */
export function rememberTargetCopy(target: RememberTarget, project: RememberProject | null): { label: string, description: string } {
  const name = project?.name ?? 'a project'
  switch (target) {
    case 'project-file':
      return {
        label: project?.instructionsFile ? `${project.instructionsFile} in ${name}` : `AGENTS.md in ${name} (new file)`,
        description: 'Added as a line at the end of the file.',
      }
    case 'project-instructions':
      return { label: `Instructions of ${name}`, description: 'Kept by harness-forge and sent with this project\'s chats.' }
    case 'global':
      return { label: 'Custom instructions', description: 'Sent with every chat.' }
  }
}

/**
 * The selected target when the dialog opens: the last choice (`last`, from `localStorage`) when it is a target that is
 * enabled here; otherwise `project-file` in project chats and `global` elsewhere.
 */
export function defaultTarget(projectChat: boolean, last: string | null): RememberTarget {
  const parsed = rememberTargetSchema.safeParse(last)
  if (parsed.success) {
    const target = REMEMBER_TARGETS.find(item => item.value === parsed.data)
    if (target && (projectChat || !target.needsProject))
      return target.value
  }
  return projectChat ? 'project-file' : 'global'
}

/**
 * The toast after a save: "Saved to AGENTS.md" (the file the server names; "Created AGENTS.md in {project}" when it
 * was created), "Saved to the instructions of {project}", "Saved to your custom instructions".
 */
export function rememberToast(result: RememberResult, projectName: string | null): string {
  const project = result.project?.name ?? projectName ?? 'the project'
  switch (result.target) {
    case 'project-file': {
      const file = result.file ?? 'AGENTS.md'
      return result.created ? `Created ${file} in ${project}` : `Saved to ${file}`
    }
    case 'project-instructions':
      return `Saved to the instructions of ${project}`
    case 'global':
      return 'Saved to your custom instructions'
  }
}

export const REMEMBER_INSTRUCTIONS_CAP = `The instructions would be longer than ${LIMITS.instructionsMaxChars.toLocaleString('en-US')} characters. Shorten them in Settings first.`
export const REMEMBER_FILE_CAP = 'The file would be larger than 1 MB.'
export const REMEMBER_FOLDER_UNAVAILABLE = 'The project folder is unavailable.'

/** The paths of the zod-style issues of a `validation_error` (`details.issues[].path`, joined with dots). */
function issuePaths(error: HarnessError): string[] {
  const details = error.details as { issues?: unknown } | undefined
  if (!details || !Array.isArray(details.issues))
    return []
  return details.issues.flatMap((issue: unknown) => {
    const path = (issue as { path?: unknown } | null)?.path
    return Array.isArray(path) ? [path.join('.')] : []
  })
}

const INSTRUCTIONS_CAP_TEXT = /\binstructions\b.+?(?:20[\s,.]?000|too long|longer than|at most)/is
const FOLDER_UNAVAILABLE_TEXT = /\bproject folder\b.+?(?:not available|unavailable|missing|does not exist)/is

/**
 * The inline error of the dialog (API.md 5.29): 413 -> "The file would be larger than 1 MB."; a 400 on the instructions
 * cap (an issue on `instructions`, or a message about the instructions' length) -> "The instructions would be longer than
 * 20,000 characters. Shorten them in Settings first."; a 400 for an unavailable project folder -> "The project folder is
 * unavailable."; anything else the server's message (a linked `AGENTS.md`, a chat without a project, …).
 */
export function rememberErrorText(error: HarnessError): string {
  if (error.code === 'payload_too_large')
    return REMEMBER_FILE_CAP
  if (error.code === 'validation_error') {
    if (issuePaths(error).some(path => path === 'instructions' || path.endsWith('.instructions')) || INSTRUCTIONS_CAP_TEXT.test(error.message))
      return REMEMBER_INSTRUCTIONS_CAP
    if (FOLDER_UNAVAILABLE_TEXT.test(error.message))
      return REMEMBER_FOLDER_UNAVAILABLE
  }
  return error.message
}
