// Pure helpers of "Rewind files to here" (docs/UI.md 7.22, 15; docs/API.md 4.23, 5.24; ADR-036): the view model of a
// rewind preview, the text of the result toast, which failures close the dialog, and the optional host the
// RewindDialog hands those failures to (ChatView provides it: the toasts, following the run, reloading the path).
import type { HarnessError, RestoreResult, RewindPreview } from '@harness-forge/shared'
import type { InjectionKey } from 'vue'

/** Shell commands listed in the dialog's warning; the rest reads "and {n} more". */
export const REWIND_SHELL_COMMANDS_MAX = 10

/** docs/UI.md 7.22: a `409 conflict` (`run-active`) answer to a rewind. */
export const REWIND_RUN_ACTIVE_MESSAGE = 'Wait for the responses in this project to finish before rewinding files.'

/** One listed file of the preview (`unchanged` files are left out: they already match). */
export interface RewindFileRow {
  path: string
  action: 'restore' | 'delete' | 'unavailable'
  /** The file changed outside this chat after its last recorded change. */
  conflict: boolean
}

export interface RewindShellRow {
  /** The full command (the row's `title`). */
  command: string
  /** Its first line (shown in mono, truncated). */
  firstLine: string
}

export interface RewindView {
  files: RewindFileRow[]
  /** The server cut the file list: "and more files". */
  moreFiles: boolean
  /** A listed file changed outside this chat: "Also restore files changed outside this chat" is offered. */
  hasConflict: boolean
  /** Every shell command in the range (the warning shows when there is one). */
  shellCount: number
  /** The latest commands, at most `REWIND_SHELL_COMMANDS_MAX`. */
  commands: RewindShellRow[]
  /** "and {n} more": commands in the range beyond the listed ones. */
  moreCommands: number
  /** Other workspace tools that changed files in the range (unique names, latest first). */
  tools: string[]
}

/** The dialog's view of a preview: the files to list, the conflict option and the changes a rewind cannot undo. */
export function rewindView(preview: RewindPreview): RewindView {
  const files: RewindFileRow[] = []
  for (const file of preview.files) {
    if (file.action !== 'unchanged')
      files.push({ path: file.path, action: file.action, conflict: file.conflict })
  }
  const commands = preview.untracked.shell.slice(0, REWIND_SHELL_COMMANDS_MAX).map(item => ({
    command: item.command,
    firstLine: item.command.split('\n', 1)[0]!,
  }))
  const shellCount = Math.max(preview.untracked.shellCount, preview.untracked.shell.length)
  return {
    files,
    moreFiles: preview.truncated,
    hasConflict: files.some(file => file.conflict),
    shellCount,
    commands,
    moreCommands: Math.max(0, shellCount - commands.length),
    tools: [...new Set(preview.untracked.tools.map(call => call.tool))],
  }
}

function files(count: number): string {
  return count === 1 ? '1 file' : `${count} files`
}

/** The toast after a rewind (or its undo): title, description lines and whether Undo is offered. */
export interface RewindResultText {
  title: string
  lines: string[]
  /** The answer wrote something (`batchId`): Undo restores the state before it. */
  undoable: boolean
}

/**
 * "Restored {n} files" (n = restored + deleted) with "Skipped {k} files changed outside this chat" and / or "Skipped {k}
 * files that can't be restored"; nothing written: "Nothing was restored." with the same lines, or "The files already
 * match." when nothing was skipped either (docs/UI.md 7.22).
 */
export function rewindResultText(result: RestoreResult): RewindResultText {
  const written = result.restored.length + result.deleted.length
  const conflicts = result.skipped.filter(skip => skip.reason === 'conflict').length
  const others = result.skipped.length - conflicts
  const lines: string[] = []
  if (conflicts > 0)
    lines.push(`Skipped ${files(conflicts)} changed outside this chat`)
  if (others > 0)
    lines.push(`Skipped ${files(others)} that can't be restored`)
  let title: string
  if (written > 0)
    title = `Restored ${files(written)}`
  else
    title = lines.length > 0 ? 'Nothing was restored.' : 'The files already match.'
  return { title, lines, undoable: result.batchId !== null }
}

/** The running chat of a `409 conflict` (`details.chatId`), when the server named one. */
export function runningChatOf(failure: HarnessError): string | null {
  const chatId = (failure.details as { chatId?: unknown } | undefined)?.chatId
  return typeof chatId === 'string' ? chatId : null
}

/**
 * Failures that close the dialog and go to its host: `404 not_found` (the chat or the message is gone: the shown path
 * is stale) and `409 conflict` (`run-active`, or no reason: a chat of the project runs). Everything else is shown inside
 * the dialog.
 */
export function isRewindRefusal(failure: HarnessError): boolean {
  if (failure.code === 'not_found')
    return true
  if (failure.code !== 'conflict')
    return false
  const reason = (failure.details as { reason?: unknown } | undefined)?.reason
  return reason === undefined || reason === 'run-active'
}

/**
 * The owner of a RewindDialog (ChatView) reports what the dialog cannot: a refused preview or restore
 * (`isRewindRefusal`). Without a host the dialog shows those failures inline like any other.
 */
export interface RewindDialogHost {
  refused: (failure: HarnessError) => void
}

export const REWIND_DIALOG_HOST: InjectionKey<RewindDialogHost> = Symbol('hf-rewind-dialog-host')
