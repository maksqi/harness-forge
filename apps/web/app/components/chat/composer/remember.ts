// Remember (docs/UI.md 7.30, 11.7; docs/API.md 5.29; ADR-047): the "Save to" targets of RememberDialog, the default
// target, the success toast and the inline error text. Pure: no Vue, no stores.
// Signatures frozen from Gate P10-0b (C33); W10.9 owns the copy and the details in P10-A.
import type { HarnessError, RememberResult, RememberTarget } from '@harness-forge/shared'
import { rememberTargetSchema } from '@harness-forge/shared'

/** The targets in display order; the project ones need a saved project chat. */
export const REMEMBER_TARGETS: readonly { value: RememberTarget, needsProject: boolean }[] = [
  { value: 'project-file', needsProject: true },
  { value: 'project-instructions', needsProject: true },
  { value: 'global', needsProject: false },
]

/** `localStorage` key of the last chosen target. */
export const REMEMBER_TARGET_KEY = 'hf-remember-target'

/** The reason shown on a disabled project target. */
export const REMEMBER_NEEDS_PROJECT = 'Open a chat in a project to use this.'

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

/** The inline error of the dialog: 413 -> "The file would be larger than 1 MB."; anything else the server's message. */
export function rememberErrorText(error: HarnessError): string {
  if (error.code === 'payload_too_large')
    return 'The file would be larger than 1 MB.'
  return error.message
}
