// Workspace tool registry (docs/UI.md 7.19, 11.4; ADR-032; W7.11): turns the input and output of a `core-workspace`
// tool part into a view for the row (icon, argument, summary) and its expanded body (`WorkspaceToolBody`), and builds
// the approval previews (`ToolApprovalPreview`). Pure and store-free: the share page uses it too. Every function
// returns null for a name outside `WORKSPACE_TOOL_NAMES` or a value that fails the shared schema, so the row keeps
// its generic Input / Output blocks.
// Signatures frozen from Gate P7-0b (C15). Skeleton: every function returns null until W7.11 implements them, so
// `ToolPart` keeps its generic blocks.
import type { DiffHunk, ShellOutput, WorkspaceEntryType } from '@harness-forge/shared'
import type { Component } from 'vue'

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
    | { kind: 'terminal', command: string, output: ShellOutput | null }
    | { kind: 'file', path: string, content: string, startLine: number, endLine: number, totalLines: number | null, truncated: boolean }
    | { kind: 'list', items: FileListItem[], noun: 'entries' | 'files' | 'matches', truncated: boolean }

/** The tone of a row summary (`tool-row-summary`, `data-tone`). */
export type WorkspaceRowSummaryTone = 'muted' | 'success' | 'destructive' | 'warning'

/** The row summary of a finished workspace tool part (`+12 −3`, `exit 1`, `24 entries`, ...). */
export interface WorkspaceRowSummary {
  text: string
  tone: WorkspaceRowSummaryTone
}

/** The expanded body of a workspace tool part (`write_file` / `edit_file` diff, `shell` terminal, ...), or null. */
export function workspaceToolView(_toolName: string, _input: unknown, _output: unknown): WorkspaceToolView | null {
  return null
}

/** The approval preview of a workspace tool call (`edit_file` diff, `write_file` content, `shell` command), or null. */
export function workspaceApprovalView(_toolName: string, _input: unknown): WorkspaceToolView | null {
  return null
}

/** The first argument shown in the row (path, pattern or the first line of the command), or null. */
export function workspaceRowArgument(_toolName: string, _input: unknown): string | null {
  return null
}

/** The row summary once the output exists, or null. */
export function workspaceRowSummary(_toolName: string, _output: unknown): WorkspaceRowSummary | null {
  return null
}

/** The row icon of a workspace tool (`FileText`, `ListTree`, ..., `SquareTerminal`), or null. */
export function workspaceToolIcon(_toolName: string): Component | null {
  return null
}
