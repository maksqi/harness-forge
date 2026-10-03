// Workspace tools (API.md section 4.21, ADR-032, ADR-033): the builtin plugin `core-workspace` registers seven tools
// that work on the project folder of a chat. Inputs use the snake_case keys the model sees; every path in an input or
// an output is a project-relative POSIX path (`.` = the project folder). The outputs are what the tool parts store and
// the web renders (diffs, terminal output); the model gets a short text built from the stored output
// (`toModelOutput`). Each output is trimmed to `WORKSPACE_LIMITS.outputMaxBytes` of serialized JSON, under the 64 KB
// host cap of `LIMITS.toolOutputBytes`.
import type { WorkspaceAccess } from '../enums.ts'
import { z } from 'zod'
import { LIMITS } from '../limits.ts'
import { utf8ByteLength } from '../util/text.ts'

/** The tools of `core-workspace`, in registration order. */
export const WORKSPACE_TOOL_NAMES = ['read_file', 'list_directory', 'find_files', 'search_files', 'write_file', 'edit_file', 'shell'] as const

export const workspaceToolNameSchema = z.enum(WORKSPACE_TOOL_NAMES)
export type WorkspaceToolName = z.infer<typeof workspaceToolNameSchema>

/** `ToolDefinition.workspace` of each tool (`shell` is not registered on Windows, nor offered with `HF_WORKSPACE_SHELL=0`). */
export const WORKSPACE_TOOL_ACCESS = {
  read_file: 'read',
  list_directory: 'read',
  find_files: 'read',
  search_files: 'read',
  write_file: 'write',
  edit_file: 'write',
  shell: 'execute',
} as const satisfies Record<WorkspaceToolName, WorkspaceAccess>

/** Limits of the workspace tools (bytes are UTF-8 bytes). */
export const WORKSPACE_LIMITS = {
  /** `read_file`: lines per call (`limit` 1..2000, the default). */
  readMaxLines: 2000,
  /** `read_file`: bytes of content per call (49152 = 48 KiB); a longer window is cut (`truncated`). */
  readMaxBytes: 49_152,
  /** `read_file`, `search_files`: characters kept of one line. */
  lineMaxChars: 2000,
  /** `edit_file`: bytes of the edited file (1 MiB). */
  editFileMaxBytes: 1_048_576,
  /** `write_file`: bytes of `content` (256 KiB). */
  writeContentMaxBytes: 262_144,
  /** `edit_file`: bytes of `old_string` (1..) and of `new_string` (64 KiB). */
  editStringMaxBytes: 65_536,
  /** `list_directory`: entries per call. */
  listMaxEntries: 1000,
  /** `find_files`: maximum and default `max_results`. */
  findMaxResults: 1000,
  findDefaultResults: 200,
  /** `search_files`: maximum and default `max_results`. */
  searchMaxResults: 500,
  searchDefaultResults: 100,
  /** `search_files`: larger files are skipped (1 MiB). */
  searchFileMaxBytes: 1_048_576,
  /** `find_files`, `search_files`: characters of `pattern` and `glob`. */
  patternMaxChars: 1000,
  /** `shell`: bytes of `command` (16 KiB). */
  commandMaxBytes: 16_384,
  /** `shell`: default, minimum and maximum `timeout_ms` (the guard timeout of the tool is 600 s, so this one fires first). */
  shellTimeoutDefaultMs: 120_000,
  shellTimeoutMinMs: 1000,
  shellTimeoutMaxMs: 590_000,
  /** `shell`: bytes kept of the start and of the end of each stream; the middle is replaced by an omission marker. */
  shellStreamHeadBytes: 4096,
  shellStreamTailBytes: 16_384,
  /** Serialized JSON bytes of one stored output (60 KiB, under `LIMITS.toolOutputBytes`). */
  outputMaxBytes: 61_440,
  /** Serialized JSON bytes of one diff (24 KiB); a longer diff is cut (`truncated`). */
  diffMaxBytes: 24_576,
  /** Characters kept of one diff line. */
  diffLineMaxChars: 500,
  /** `shell`: characters of `description`. */
  descriptionMaxChars: 200,
} as const

// ---------- building blocks ----------

/**
 * A path inside the project folder, as the model sends it: 1..4096 characters without control characters. Relative to
 * the project folder (an absolute path inside it is accepted); the server resolves it through its path guard
 * (realpath containment), so `..` or a symbolic link cannot leave the folder.
 */
export const workspaceToolPathSchema = z
  .string()
  .min(1)
  .max(LIMITS.workspacePathMaxChars)
  .regex(/^\P{Cc}*$/u, 'Paths cannot contain control characters.')

/**
 * A string of `min` characters .. `max` UTF-8 bytes (`max` characters also bound it in the JSON Schema the model sees;
 * the byte check is a refinement, which JSON Schema cannot express).
 */
function boundedText(label: string, max: number, min = 0) {
  return z.string().min(min).max(max).refine(value => utf8ByteLength(value) <= max, `${label} is limited to ${max / 1024} KiB.`)
}

const patternSchema = z.string().min(1).max(WORKSPACE_LIMITS.patternMaxChars)

const countSchema = z.int().min(0)

/** One hunk of a unified diff (3 lines of context). */
export const workspaceDiffHunkSchema = z.object({
  /** 1-based first line in the old file (0 for an empty old side). */
  oldStart: countSchema,
  oldLines: countSchema,
  /** 1-based first line in the new file (0 for an empty new side). */
  newStart: countSchema,
  newLines: countSchema,
  /**
   * The hunk lines, each prefixed with `' '` (context), `'-'` (removed) or `'+'` (added); `'\'` marks "No newline at end
   * of file". Lines longer than `WORKSPACE_LIMITS.diffLineMaxChars` are cut.
   */
  lines: z.array(z.string()),
})
export type DiffHunk = z.infer<typeof workspaceDiffHunkSchema>

/** The change a write or an edit made, for the UI (the model gets only the line counts). */
export const workspaceDiffSchema = z.object({
  hunks: z.array(workspaceDiffHunkSchema),
  /** Lines added and removed in the whole change (also when the hunks were cut). */
  added: countSchema,
  removed: countSchema,
  /** Hunks or lines were cut to `WORKSPACE_LIMITS.diffMaxBytes`. */
  truncated: z.boolean(),
})
export type WorkspaceDiff = z.infer<typeof workspaceDiffSchema>

// ---------- read_file ----------

/** Input of `read_file` (policy `safe`, or `ask` for a secret-looking path such as `.env`; access `read`). */
export const readFileToolInputSchema = z.object({
  path: workspaceToolPathSchema,
  /** 1-based first line; default 1. */
  offset: z.int().min(1).optional(),
  /** Lines to read, 1..2000; default 2000. */
  limit: z.int().min(1).max(WORKSPACE_LIMITS.readMaxLines).optional(),
})
export type ReadFileToolInput = z.infer<typeof readFileToolInputSchema>

/** Output of `read_file`: raw text (line numbers only appear in the text the model sees). Text files only. */
export const readFileToolOutputSchema = z.object({
  path: z.string(),
  content: z.string(),
  /** 1-based line range of `content` (`endLine` < `startLine` for an empty window). */
  startLine: z.int().min(1),
  endLine: z.int().min(0),
  /** Lines of the whole file; null when the file was not read to its end. */
  totalLines: countSchema.nullable(),
  /** The file continues after `endLine`, or a line or the window was cut. */
  truncated: z.boolean(),
})
export type ReadFileToolOutput = z.infer<typeof readFileToolOutputSchema>

// ---------- list_directory ----------

/** Input of `list_directory` (policy `safe`, access `read`). */
export const listDirectoryToolInputSchema = z.object({
  /** Default `.` (the project folder). */
  path: workspaceToolPathSchema.optional(),
})
export type ListDirectoryToolInput = z.infer<typeof listDirectoryToolInputSchema>

export const workspaceEntryTypeSchema = z.enum(['file', 'dir', 'symlink', 'other'])
export type WorkspaceEntryType = z.infer<typeof workspaceEntryTypeSchema>

/** Output of `list_directory`: the entries sorted by name, at most `WORKSPACE_LIMITS.listMaxEntries`. */
export const listDirectoryToolOutputSchema = z.object({
  path: z.string(),
  entries: z.array(z.object({ name: z.string(), type: workspaceEntryTypeSchema })),
  truncated: z.boolean(),
})
export type ListDirectoryToolOutput = z.infer<typeof listDirectoryToolOutputSchema>

// ---------- find_files ----------

/** Input of `find_files` (policy `safe`, access `read`). */
export const findFilesToolInputSchema = z.object({
  /** A glob (dot files included); without `/` it matches the file name at any depth (`*.ts`). */
  pattern: patternSchema,
  /** Folder to search; default `.`. */
  path: workspaceToolPathSchema.optional(),
  /** Also search `node_modules` and gitignored files (`.git` is always skipped); default false. */
  include_ignored: z.boolean().optional(),
  /** 1..1000; default 200. */
  max_results: z.int().min(1).max(WORKSPACE_LIMITS.findMaxResults).optional(),
})
export type FindFilesToolInput = z.infer<typeof findFilesToolInputSchema>

/** Output of `find_files`: matching file paths, sorted. */
export const findFilesToolOutputSchema = z.object({
  pattern: z.string(),
  paths: z.array(z.string()),
  truncated: z.boolean(),
})
export type FindFilesToolOutput = z.infer<typeof findFilesToolOutputSchema>

// ---------- search_files ----------

/** Input of `search_files` (policy `safe`, access `read`). */
export const searchFilesToolInputSchema = z.object({
  /** A JavaScript regular expression, or plain text with `literal`. */
  pattern: patternSchema,
  /** Match `pattern` as plain text; default false. */
  literal: z.boolean().optional(),
  /** Default true. */
  case_sensitive: z.boolean().optional(),
  /** Only files matching this glob (same rules as `find_files`). */
  glob: patternSchema.optional(),
  /** Folder to search; default `.`. */
  path: workspaceToolPathSchema.optional(),
  /** Also search `node_modules` and gitignored files; default false (secret-looking files are always skipped). */
  include_ignored: z.boolean().optional(),
  /** 1..500; default 100. */
  max_results: z.int().min(1).max(WORKSPACE_LIMITS.searchMaxResults).optional(),
})
export type SearchFilesToolInput = z.infer<typeof searchFilesToolInputSchema>

/** One matching line. */
export const searchFilesMatchSchema = z.object({
  path: z.string(),
  /** 1-based line number. */
  line: z.int().min(1),
  /** The line, cut at `WORKSPACE_LIMITS.lineMaxChars`. */
  text: z.string(),
})
export type SearchFilesMatch = z.infer<typeof searchFilesMatchSchema>

/** Output of `search_files`. */
export const searchFilesToolOutputSchema = z.object({
  pattern: z.string(),
  matches: z.array(searchFilesMatchSchema),
  /** Files read (skipped files are not counted). */
  filesSearched: countSchema,
  truncated: z.boolean(),
})
export type SearchFilesToolOutput = z.infer<typeof searchFilesToolOutputSchema>

// ---------- write_file ----------

/**
 * Input of `write_file` (policy `ask`, `always` for a hidden or secret-looking path; access `write`): creates or
 * replaces a text file; missing folders are created; `.git` is never written.
 */
export const writeFileToolInputSchema = z.object({
  path: workspaceToolPathSchema,
  /** The whole new content, at most 256 KiB. */
  content: boundedText('content', WORKSPACE_LIMITS.writeContentMaxBytes),
})
export type WriteFileToolInput = z.infer<typeof writeFileToolInputSchema>

/** Output of `write_file`. */
export const writeFileToolOutputSchema = z.object({
  path: z.string(),
  /** The file did not exist before. */
  created: z.boolean(),
  /** Bytes and lines of the new content. */
  bytes: countSchema,
  lines: countSchema,
  /** null when the diff could not be computed in time. */
  diff: workspaceDiffSchema.nullable(),
})
export type WriteFileToolOutput = z.infer<typeof writeFileToolOutputSchema>

// ---------- edit_file ----------

/**
 * Input of `edit_file` (same policy and access as `write_file`): replaces `old_string`, which must match exactly and be
 * unique unless `replace_all`, in a text file of at most 1 MiB.
 */
export const editFileToolInputSchema = z.object({
  path: workspaceToolPathSchema,
  /** 1 character .. 64 KiB. */
  old_string: boundedText('old_string', WORKSPACE_LIMITS.editStringMaxBytes, 1),
  /** At most 64 KiB; must differ from `old_string`. */
  new_string: boundedText('new_string', WORKSPACE_LIMITS.editStringMaxBytes),
  /** Replace every occurrence; default false. */
  replace_all: z.boolean().optional(),
})
export type EditFileToolInput = z.infer<typeof editFileToolInputSchema>

/** Output of `edit_file`. */
export const editFileToolOutputSchema = z.object({
  path: z.string(),
  /** Occurrences replaced (>= 1). */
  replacements: z.int().min(1),
  /** null when the diff could not be computed in time. */
  diff: workspaceDiffSchema.nullable(),
})
export type EditFileToolOutput = z.infer<typeof editFileToolOutputSchema>

// ---------- shell ----------

/**
 * Input of `shell` (policy `ask`, access `execute`; ADR-033, ADR-038): runs `bash -c` (else `sh -c`) with a minimal
 * environment; every call is a new process (no stdin; background processes are stopped). `cd` persists inside the
 * project folder: the next call of the chat starts in the folder the previous one ended in (clamped to the project);
 * environment variables do not persist. A command whose every segment matches a shell rule runs without asking in the
 * `ask` and `edits` modes (ADR-038).
 */
export const shellToolInputSchema = z.object({
  /** At most 16 KiB. */
  command: boundedText('command', WORKSPACE_LIMITS.commandMaxBytes, 1),
  /**
   * Working folder inside the project for this call; default: where the chat's previous shell call ended (`.` at
   * first). Its end folder becomes the remembered one.
   */
  cwd: workspaceToolPathSchema.optional(),
  /** 1000..590000 ms; default 120000. */
  timeout_ms: z.int().min(WORKSPACE_LIMITS.shellTimeoutMinMs).max(WORKSPACE_LIMITS.shellTimeoutMaxMs).optional(),
  /** What the command does, in a few words (shown on the approval card); at most 200 characters. */
  description: z.string().max(WORKSPACE_LIMITS.descriptionMaxChars).optional(),
})
export type ShellToolInput = z.infer<typeof shellToolInputSchema>

/**
 * Output of `shell`. Each stream keeps its first 4 KiB and last 16 KiB with an omission marker between them; ANSI
 * codes are stripped, `\r\n` becomes `\n` and only the last segment of a `\r` progress line is kept.
 */
export const shellToolOutputSchema = z.object({
  command: z.string(),
  /** Project-relative working folder the command started in (`.` = the project folder). */
  cwd: z.string(),
  /** null when the process was ended by a signal. */
  exitCode: z.int().nullable(),
  /** The signal that ended the process (`SIGTERM`, `SIGKILL`, ...), else null. */
  signal: z.string().nullable(),
  /** Stopped after `timeout_ms` (a normal result, not an error). */
  timedOut: z.boolean(),
  durationMs: z.number().min(0),
  stdout: z.string(),
  stderr: z.string(),
  /** Bytes each stream produced in total (before trimming). */
  stdoutBytes: countSchema,
  stderrBytes: countSchema,
  /**
   * Where the chat's next shell call starts (Phase 8, ADR-038): the folder the command ended in, project-relative
   * (`.` = the project folder), clamped to the project (a folder outside it, or one that is gone, becomes `.` with a
   * `cwdNote`). Absent when the end folder was not reported (`exec`, a kill, the command's own EXIT trap: the folder
   * stays as it was; the next run looks further back) and in outputs stored before v1.4 (read as `.`).
   */
  endCwd: workspaceToolPathSchema.optional(),
  /**
   * Why the working folder was reset to the project folder ("The command ended outside the project folder; the next
   * call starts in the project folder."), or why the call did not start in the remembered folder; at most 500
   * characters.
   */
  cwdNote: z.string().max(500).optional(),
  /**
   * The canonical prefixes of the shell rules that matched every segment of the command (ADR-038), in first-match
   * order, whatever the permission mode; absent when no rule matched (for example a command that is only `cd`).
   */
  allowedBy: z.array(z.string().min(1).max(LIMITS.shellRulePrefixMaxChars)).max(LIMITS.shellCommandSegmentsMax).optional(),
})
export type ShellToolOutput = z.infer<typeof shellToolOutputSchema>
/** The stored `shell` output (the terminal view of the web). */
export type ShellOutput = ShellToolOutput

// ---------- by tool ----------

/** Input and output schema of every workspace tool. */
export const WORKSPACE_TOOL_SCHEMAS = {
  read_file: { input: readFileToolInputSchema, output: readFileToolOutputSchema },
  list_directory: { input: listDirectoryToolInputSchema, output: listDirectoryToolOutputSchema },
  find_files: { input: findFilesToolInputSchema, output: findFilesToolOutputSchema },
  search_files: { input: searchFilesToolInputSchema, output: searchFilesToolOutputSchema },
  write_file: { input: writeFileToolInputSchema, output: writeFileToolOutputSchema },
  edit_file: { input: editFileToolInputSchema, output: editFileToolOutputSchema },
  shell: { input: shellToolInputSchema, output: shellToolOutputSchema },
} as const satisfies Record<WorkspaceToolName, { input: z.ZodType, output: z.ZodType }>
