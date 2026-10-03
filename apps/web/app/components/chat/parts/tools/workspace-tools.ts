// Workspace tool registry (docs/UI.md 7.19, 11.4; ADR-032; W7.11): turns the input and output of a `core-workspace`
// tool part into a view for the row (icon, argument, summary) and its expanded body (`WorkspaceToolBody`), and builds
// the approval previews (`ToolApprovalPreview`). Pure and store-free: the share page uses it too. Every function
// returns null for a name outside `WORKSPACE_TOOL_NAMES` or a value that fails the shared schema (a plugin tool with
// the same name, a share value cut to a `[truncated]` string), so the row keeps its generic Input / Output blocks.
// Signatures frozen from Gate P7-0b (C15). Phase 8 additions (C20 in P8-0b, W8.10 in P8-A; docs/UI.md 7.19, 11.5): the
// spoken `label` of a row summary, `diffStatsLabel`, the terminal view's `cwd` and `currentShellCwd(messages)`.
import type { DiffHunk, HarnessUIMessage, ShellOutput, WorkspaceDiff, WorkspaceEntryType, WorkspaceToolName } from '@harness-forge/shared'
import type { Component } from 'vue'
import {
  editFileToolInputSchema,
  editFileToolOutputSchema,
  findFilesToolOutputSchema,
  listDirectoryToolOutputSchema,
  readFileToolOutputSchema,
  searchFilesToolOutputSchema,
  shellToolInputSchema,
  shellToolOutputSchema,
  WORKSPACE_TOOL_NAMES,
  writeFileToolInputSchema,
  writeFileToolOutputSchema,
} from '@harness-forge/shared'
import {
  FilePenLineIcon,
  FilePlusIcon,
  FileSearchIcon,
  FileTextIcon,
  ListTreeIcon,
  SquareTerminalIcon,
  TextSearchIcon,
} from '@lucide/vue'
import { markRaw } from 'vue'
import { diffLines, splitLines } from '~/utils/line-diff'
import { firstStringArg } from '../../chat-format'

/** One item of a `FileList`: a `list_directory` entry (`type`), a `find_files` path or a `search_files` match. */
export interface FileListItem {
  path: string
  /** `list_directory` entries: file | dir | symlink | other. */
  type?: WorkspaceEntryType
  /** `search_files` match: the 1-based line number and the matched line. */
  line?: number
  text?: string
}

/** What a workspace tool part renders: a diff, a terminal, file content or a list. */
export type WorkspaceToolView
  = | { kind: 'diff', path: string, created: boolean, additions: number, deletions: number, hunks: DiffHunk[], truncated: boolean }
    | {
      kind: 'terminal'
      command: string
      output: ShellOutput | null
      /** + Phase 8: the folder the command started in: the output's `cwd`, else the input's (null when neither). */
      cwd: string | null
    }
    | { kind: 'file', path: string, content: string, startLine: number, endLine: number, totalLines: number | null, truncated: boolean }
    | { kind: 'list', items: FileListItem[], noun: 'entries' | 'files' | 'matches', truncated: boolean }

/** The tone of a row summary (`tool-row-summary`, `data-tone`). */
export type WorkspaceRowSummaryTone = 'muted' | 'success' | 'destructive' | 'warning'

/** The row summary of a finished workspace tool part (`+12 −3`, `exit 1`, `24 entries`, ...). */
export interface WorkspaceRowSummary {
  text: string
  tone: WorkspaceRowSummaryTone
  /**
   * + Phase 8 (docs/UI.md 7.19): what a screen reader says instead of `text` ("12 lines added, 3 removed", "Exit code
   * 1", ...). Until W8.10 it is the visible text.
   */
  label: string
}

const ICONS: Record<WorkspaceToolName, Component> = {
  read_file: markRaw(FileTextIcon),
  list_directory: markRaw(ListTreeIcon),
  find_files: markRaw(FileSearchIcon),
  search_files: markRaw(TextSearchIcon),
  write_file: markRaw(FilePlusIcon),
  edit_file: markRaw(FilePenLineIcon),
  shell: markRaw(SquareTerminalIcon),
}

/** The minus sign of `+a −d` (U+2212, as in the design). */
export const MINUS_SIGN = '−'

/** True for the tools of `core-workspace` (a plugin tool may share a name; its values then fail the schemas). */
export function isWorkspaceToolName(toolName: string): toolName is WorkspaceToolName {
  return (WORKSPACE_TOOL_NAMES as readonly string[]).includes(toolName)
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

/** `dir` + `name` as a project-relative path (`.` is the project folder). */
function joinPath(dir: string, name: string): string {
  if (dir === '' || dir === '.' || dir === './')
    return name
  return `${dir.replace(/\/+$/, '')}/${name}`
}

/** Added and removed lines counted in hunks (used for client previews, which carry no totals). */
export function countDiffLines(hunks: readonly DiffHunk[]): { additions: number, deletions: number } {
  let additions = 0
  let deletions = 0
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+'))
        additions++
      else if (line.startsWith('-'))
        deletions++
    }
  }
  return { additions, deletions }
}

/**
 * The diff view of a write or an edit. A `null` diff (the server's diff timed out) becomes an empty, truncated view,
 * which `DiffView` shows as "The diff is too large to show."
 */
function diffView(path: string, created: boolean, diff: WorkspaceDiff | null, createdLines: number): WorkspaceToolView {
  if (!diff)
    return { kind: 'diff', path, created, additions: created ? createdLines : 0, deletions: 0, hunks: [], truncated: true }
  return { kind: 'diff', path, created, additions: diff.added, deletions: diff.removed, hunks: diff.hunks, truncated: diff.truncated }
}

/** The expanded body of a workspace tool part (`write_file` / `edit_file` diff, `shell` terminal, ...), or null. */
export function workspaceToolView(toolName: string, input: unknown, output: unknown): WorkspaceToolView | null {
  if (!isWorkspaceToolName(toolName))
    return null
  switch (toolName) {
    case 'read_file': {
      const parsed = readFileToolOutputSchema.safeParse(output)
      if (!parsed.success)
        return null
      const { path, content, startLine, endLine, totalLines, truncated } = parsed.data
      return { kind: 'file', path, content, startLine, endLine, totalLines, truncated }
    }
    case 'list_directory': {
      const parsed = listDirectoryToolOutputSchema.safeParse(output)
      if (!parsed.success)
        return null
      const items = parsed.data.entries.map(entry => ({ path: joinPath(parsed.data.path, entry.name), type: entry.type }))
      return { kind: 'list', items, noun: 'entries', truncated: parsed.data.truncated }
    }
    case 'find_files': {
      const parsed = findFilesToolOutputSchema.safeParse(output)
      if (!parsed.success)
        return null
      return { kind: 'list', items: parsed.data.paths.map(path => ({ path })), noun: 'files', truncated: parsed.data.truncated }
    }
    case 'search_files': {
      const parsed = searchFilesToolOutputSchema.safeParse(output)
      if (!parsed.success)
        return null
      const items = parsed.data.matches.map(match => ({ path: match.path, line: match.line, text: match.text }))
      return { kind: 'list', items, noun: 'matches', truncated: parsed.data.truncated }
    }
    case 'write_file': {
      const parsed = writeFileToolOutputSchema.safeParse(output)
      if (!parsed.success)
        return null
      return diffView(parsed.data.path, parsed.data.created, parsed.data.diff, parsed.data.lines)
    }
    case 'edit_file': {
      const parsed = editFileToolOutputSchema.safeParse(output)
      if (!parsed.success)
        return null
      return diffView(parsed.data.path, false, parsed.data.diff, 0)
    }
    case 'shell': {
      // Before the output exists (running), the terminal shows the command from the input with "Running…".
      if (output === undefined || output === null) {
        const command = shellToolInputSchema.safeParse(input)
        return command.success ? { kind: 'terminal', command: command.data.command, output: null, cwd: command.data.cwd ?? null } : null
      }
      const parsed = shellToolOutputSchema.safeParse(output)
      return parsed.success ? { kind: 'terminal', command: parsed.data.command, output: parsed.data, cwd: parsed.data.cwd } : null
    }
  }
}

/**
 * The kind of view `workspaceApprovalView` would build, without building it (no diff): what an approval card needs to
 * pick its title and buttons.
 */
export function workspaceApprovalKind(toolName: string, input: unknown): WorkspaceToolView['kind'] | null {
  switch (toolName) {
    case 'edit_file':
      return editFileToolInputSchema.safeParse(input).success ? 'diff' : null
    case 'write_file':
      return writeFileToolInputSchema.safeParse(input).success ? 'file' : null
    case 'shell':
      return shellToolInputSchema.safeParse(input).success ? 'terminal' : null
    default:
      return null
  }
}

/** The approval preview of a workspace tool call (`edit_file` diff, `write_file` content, `shell` command), or null. */
export function workspaceApprovalView(toolName: string, input: unknown): WorkspaceToolView | null {
  switch (toolName) {
    case 'edit_file': {
      const parsed = editFileToolInputSchema.safeParse(input)
      if (!parsed.success)
        return null
      const hunks = diffLines(parsed.data.old_string, parsed.data.new_string)
      return { kind: 'diff', path: parsed.data.path, created: false, ...countDiffLines(hunks), hunks, truncated: false }
    }
    case 'write_file': {
      const parsed = writeFileToolInputSchema.safeParse(input)
      if (!parsed.success)
        return null
      const lines = splitLines(parsed.data.content).length
      return { kind: 'file', path: parsed.data.path, content: parsed.data.content, startLine: 1, endLine: lines, totalLines: lines, truncated: false }
    }
    case 'shell': {
      const parsed = shellToolInputSchema.safeParse(input)
      return parsed.success ? { kind: 'terminal', command: parsed.data.command, output: null, cwd: parsed.data.cwd ?? null } : null
    }
    default:
      return null
  }
}

/** A string field of a plain object input (lenient: inputs may still be streaming), else undefined. */
function stringField(input: unknown, key: string): string | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    return undefined
  const value = (input as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : undefined
}

/** The first non-empty line of a command, on one line and at most 60 characters. */
export function commandFirstLine(command: string): string | null {
  const line = command.split('\n').find(text => text.trim() !== '')
  return line === undefined ? null : firstStringArg(line)
}

/** The first argument shown in the row (path, pattern or the first line of the command), or null. */
export function workspaceRowArgument(toolName: string, input: unknown): string | null {
  if (!isWorkspaceToolName(toolName) || typeof input !== 'object' || input === null || Array.isArray(input))
    return null
  switch (toolName) {
    case 'read_file':
    case 'write_file':
    case 'edit_file': {
      const path = stringField(input, 'path')
      return path === undefined ? null : firstStringArg(path)
    }
    case 'list_directory': {
      const path = stringField(input, 'path')
      return path === undefined ? '.' : firstStringArg(path) ?? '.'
    }
    case 'find_files':
    case 'search_files': {
      const pattern = stringField(input, 'pattern')
      return pattern === undefined ? null : firstStringArg(pattern)
    }
    case 'shell': {
      const command = stringField(input, 'command')
      return command === undefined ? null : commandFirstLine(command)
    }
  }
}

/** `+a −d` of a diff summary (the row colors each side). */
export function diffSummaryText(additions: number, deletions: number): string {
  return `+${additions} ${MINUS_SIGN}${deletions}`
}

/**
 * The spoken form of `+a −d` (docs/UI.md 7.19): "12 lines added, 3 removed", "1 line added, 1 removed"; one side alone:
 * "12 lines added" / "3 lines removed"; nothing changed: "No changes". Used by the row summary, `DiffView` and the
 * changes panel.
 */
export function diffStatsLabel(additions: number, deletions: number): string {
  if (additions > 0 && deletions > 0)
    return `${plural(additions, 'line', 'lines')} added, ${deletions} removed`
  if (additions > 0)
    return `${plural(additions, 'line', 'lines')} added`
  if (deletions > 0)
    return `${plural(deletions, 'line', 'lines')} removed`
  return 'No changes'
}

/**
 * The folder the chat's next `shell` call starts in (ADR-038; docs/UI.md 11.5): the `endCwd` of the last finished
 * shell part on the shown path (`.` for an output saved before v1.4), null without one (the project folder).
 * Stub (C20, P8-0b): always null until W8.10 implements it.
 */
export function currentShellCwd(_messages: readonly HarnessUIMessage[]): string | null {
  return null
}

/** A summary whose spoken label is its visible text (W8.10 adds the spoken labels of docs/UI.md 7.19). */
function rowSummary(text: string, tone: WorkspaceRowSummaryTone): WorkspaceRowSummary {
  return { text, tone, label: text }
}

function diffSummary(diff: WorkspaceDiff | null, fallback: string): WorkspaceRowSummary {
  if (!diff)
    return rowSummary(fallback, 'muted')
  if (diff.added === 0 && diff.removed === 0)
    return rowSummary('No changes', 'muted')
  return rowSummary(diffSummaryText(diff.added, diff.removed), 'success')
}

/** The row summary once the output exists, or null. */
export function workspaceRowSummary(toolName: string, output: unknown): WorkspaceRowSummary | null {
  if (!isWorkspaceToolName(toolName))
    return null
  switch (toolName) {
    case 'read_file': {
      const parsed = readFileToolOutputSchema.safeParse(output)
      if (!parsed.success)
        return null
      const { startLine, endLine, totalLines } = parsed.data
      if (totalLines === 0)
        return rowSummary('empty file', 'muted')
      const of = totalLines === null ? '' : ` of ${totalLines}`
      if (endLine < startLine)
        return rowSummary(`no lines${of}`, 'muted')
      return rowSummary(`lines ${startLine}–${endLine}${of}`, 'muted')
    }
    case 'list_directory': {
      const parsed = listDirectoryToolOutputSchema.safeParse(output)
      return parsed.success ? rowSummary(plural(parsed.data.entries.length, 'entry', 'entries'), 'muted') : null
    }
    case 'find_files': {
      const parsed = findFilesToolOutputSchema.safeParse(output)
      return parsed.success ? rowSummary(plural(parsed.data.paths.length, 'file', 'files'), 'muted') : null
    }
    case 'search_files': {
      const parsed = searchFilesToolOutputSchema.safeParse(output)
      return parsed.success ? rowSummary(plural(parsed.data.matches.length, 'match', 'matches'), 'muted') : null
    }
    case 'write_file': {
      const parsed = writeFileToolOutputSchema.safeParse(output)
      if (!parsed.success)
        return null
      if (parsed.data.created)
        return rowSummary(`New · ${plural(parsed.data.lines, 'line', 'lines')}`, 'success')
      return diffSummary(parsed.data.diff, `Updated · ${plural(parsed.data.lines, 'line', 'lines')}`)
    }
    case 'edit_file': {
      const parsed = editFileToolOutputSchema.safeParse(output)
      if (!parsed.success)
        return null
      return diffSummary(parsed.data.diff, plural(parsed.data.replacements, 'replacement', 'replacements'))
    }
    case 'shell': {
      const parsed = shellToolOutputSchema.safeParse(output)
      if (!parsed.success)
        return null
      const { exitCode, signal, timedOut } = parsed.data
      if (timedOut)
        return rowSummary('timed out', 'warning')
      if (signal !== null)
        return rowSummary(`killed ${signal}`, 'warning')
      if (exitCode === 0)
        return rowSummary('exit 0', 'muted')
      return rowSummary(exitCode === null ? 'exited' : `exit ${exitCode}`, 'destructive')
    }
  }
}

/** The row icon of a workspace tool (`FileText`, `ListTree`, ..., `SquareTerminal`), or null. */
export function workspaceToolIcon(toolName: string): Component | null {
  return isWorkspaceToolName(toolName) ? ICONS[toolName] : null
}
