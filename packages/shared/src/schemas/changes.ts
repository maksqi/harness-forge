// Changes, revert, undo and rewind of a project chat (API.md section 4.23, ADR-036, ADR-037): module `changes`
// (`/chats/:id/changes...`, `/chats/:id/git`, `/chats/:id/rewind`) and the event `workspace.changed`.
//
// - Every agent `write_file` / `edit_file` and every user revert, rewind or undo journals the file's previous state
//   (`workspace_changes` + content-addressed blobs in `<dataDir>/checkpoints/`); shell commands and calls of other
//   tools with workspace access `write` / `execute` are journaled too but never restored ("untracked").
// - "This chat" (`source: 'chat'`) is computed from the journal and works without git; "Git" (`source: 'git'`) compares
//   the project folder with HEAD through the hardened git runner. The git index is never touched.
// - Every path is project-relative POSIX (`src/index.ts`). Timestamps are epoch milliseconds.
import { z } from 'zod'
import { changeSourceSchema, conflictHandlingSchema, workspaceChangedSourceSchema } from '../enums.ts'
import { changeBatchIdSchema, chatIdSchema, messageIdSchema, projectIdSchema, sha256HexSchema, timestampSchema, toolNameSchema } from '../ids.ts'
import { LIMITS } from '../limits.ts'
import { workspaceDiffSchema, workspaceToolPathSchema } from './workspace.ts'

const countSchema = z.int().min(0)

// ---------- "This chat" ----------

/**
 * Net change of one file over the whole chat: `added` (the file did not exist before the chat first changed it),
 * `deleted` (it is missing now), `modified`, or `unchanged` (back to its state before the chat).
 */
export const chatChangeStatusSchema = z.enum(['added', 'modified', 'deleted', 'unchanged'])
export type ChatChangeStatus = z.infer<typeof chatChangeStatusSchema>

/** One file the chat changed (`GET /chats/:id/changes`). */
export const chatChangeFileSchema = z.object({
  /** Project-relative POSIX path. */
  path: z.string(),
  /** Base (before the chat first changed the file) against the file on disk now. */
  status: chatChangeStatusSchema,
  /** Journaled changes of this file in the chat (edits, reverts, rewinds, undos). */
  edits: countSchema,
  /** The disk state differs from the state after the chat's last recorded change (another chat, a shell, an editor). */
  changedOutside: z.boolean(),
  /** The base state is stored (not `too-large` or `evicted`), so the file can be reverted to it. */
  revertible: z.boolean(),
  /**
   * Lines added and removed (base against disk); null beyond the first `LIMITS.changesLineCountFiles` files, for
   * binary files and for files over `LIMITS.changesLineCountMaxBytes`.
   */
  added: countSchema.nullable(),
  removed: countSchema.nullable(),
  /** Time of the chat's last recorded change of the file. */
  lastEditAt: timestampSchema,
})
export type ChatChangeFile = z.infer<typeof chatChangeFileSchema>

/** Why the changes of a chat are not available. */
export const changesUnavailableReasonSchema = z.enum(['no-project', 'folder-unavailable'])
export type ChangesUnavailableReason = z.infer<typeof changesUnavailableReasonSchema>

/** `GET /chats/:id/changes`: the files the chat changed in its current project, most recently changed first. */
export const chatChangesSchema = z.object({
  /** False for a chat without a project, or when its folder cannot be opened (`reason`; `files` is then empty). */
  available: z.boolean(),
  reason: changesUnavailableReasonSchema.nullable(),
  /** The chat's current project (rows recorded in an earlier project are ignored); null without a project. */
  projectId: projectIdSchema.nullable(),
  /** At most `LIMITS.changesFilesMax` files. */
  files: z.array(chatChangeFileSchema).max(LIMITS.changesFilesMax),
  /** More files changed than were listed. */
  truncated: z.boolean(),
  /** Changes the journal cannot restore: shell commands, and calls of other tools with workspace access. */
  untracked: z.object({
    shellCommands: countSchema,
    toolCalls: countSchema,
  }),
})
export type ChatChanges = z.infer<typeof chatChangesSchema>

// ---------- diff of one file ----------

/** Query of `GET /chats/:id/changes/diff`. */
export const changeDiffQuerySchema = z.object({
  source: changeSourceSchema,
  /** A project-relative path (1..4096 characters, no control characters); resolved through the workspace path guard. */
  path: workspaceToolPathSchema,
})
export type ChangeDiffQuery = z.infer<typeof changeDiffQuerySchema>

/** Status of a file in a diff: the chat statuses, plus `renamed` and `untracked` of the git view. */
export const fileDiffStatusSchema = z.enum(['added', 'modified', 'deleted', 'unchanged', 'renamed', 'untracked'])
export type FileDiffStatus = z.infer<typeof fileDiffStatusSchema>

/** `GET /chats/:id/changes/diff`: one file, base (the chat's base state, or HEAD) against the disk. */
export const fileDiffSchema = z.object({
  source: changeSourceSchema,
  path: z.string(),
  /** The path at HEAD of a renamed file (git view); else null. */
  origPath: z.string().nullable(),
  status: fileDiffStatusSchema,
  /** One side is binary (a NUL byte in its first 8 KiB, or not valid text): no diff. */
  binary: z.boolean(),
  /** One side is over `LIMITS.changeDiffSideMaxBytes`: no diff. */
  tooLarge: z.boolean(),
  /**
   * The unified diff (cut to `WORKSPACE_LIMITS.diffMaxBytes`, `truncated`; no hunks when unchanged); null when binary,
   * too large or the base is not available.
   */
  diff: workspaceDiffSchema.nullable(),
  /** SHA-256 of the file on disk now (send it back as `expectedSha` of a revert); null when the file is missing. */
  currentSha: sha256HexSchema.nullable(),
  /** The base state is available (chat: stored, not `too-large` / `evicted`; git: the file exists at HEAD or is new). */
  baseAvailable: z.boolean(),
})
export type FileDiff = z.infer<typeof fileDiffSchema>

// ---------- "Git" ----------

/** Status of a file in `git status` (porcelain v2). */
export const gitFileStatusSchema = z.enum(['modified', 'added', 'deleted', 'renamed', 'untracked', 'conflicted', 'typechange'])
export type GitFileStatus = z.infer<typeof gitFileStatusSchema>

/** One changed file of the git view. */
export const gitStatusFileSchema = z.object({
  /** Project-relative path (the repository prefix of the project folder removed). */
  path: z.string(),
  /** The path before a rename (project-relative); else null. */
  origPath: z.string().nullable(),
  status: gitFileStatusSchema,
  /** Changes in the index (staged) and in the work tree (unstaged); untracked files have neither. */
  staged: z.boolean(),
  unstaged: z.boolean(),
})
export type GitStatusFile = z.infer<typeof gitStatusFileSchema>

/** Why the git view is not available. */
export const gitUnavailableReasonSchema = z.enum(['no-project', 'folder-unavailable', 'git-missing', 'not-a-repo', 'refused', 'timeout', 'failed'])
export type GitUnavailableReason = z.infer<typeof gitUnavailableReasonSchema>

/** `GET /chats/:id/git`: `git status` of the chat's project folder against HEAD. */
export const gitStatusSchema = z.object({
  available: z.boolean(),
  /**
   * Why `available` is false: no project, the folder cannot be opened, git is not installed, the folder is not inside a
   * git work tree, git refused the repository (e.g. dubious ownership: `safe.directory` is not overridden), a git
   * command timed out or failed; null when available.
   */
  reason: gitUnavailableReasonSchema.nullable(),
  /** The current branch; null for a detached HEAD or when not available. */
  branch: z.string().nullable(),
  /** The HEAD commit id; null for an unborn HEAD (no commit yet) or when not available. */
  head: z.string().nullable(),
  /** The project folder relative to the repository root (`''` when the project is the repository root). */
  prefix: z.string(),
  /** At most `LIMITS.gitStatusFilesMax` files, sorted by path. */
  files: z.array(gitStatusFileSchema).max(LIMITS.gitStatusFilesMax),
  truncated: z.boolean(),
})
export type GitStatus = z.infer<typeof gitStatusSchema>

// ---------- revert, undo, rewind ----------

/**
 * Body of `POST /chats/:id/changes/revert`; strict. Reverts one file to its base: the state before the chat first
 * changed it (`chat`) or HEAD (`git`; an untracked or added file is deleted, a rename restores `origPath`).
 */
export const changeRevertBodySchema = z.strictObject({
  source: changeSourceSchema,
  path: workspaceToolPathSchema,
  /**
   * The disk state the client showed (`FileDiff.currentSha`; null = the file was missing); another disk state is `409
   * conflict` (`reason: 'stale'`). Omitted: no check.
   */
  expectedSha: sha256HexSchema.nullable().optional(),
})
export type ChangeRevertBody = z.infer<typeof changeRevertBodySchema>

/** Body of `POST /chats/:id/changes/undo`; strict. Restores the files of one revert, rewind or undo batch. */
export const changeUndoBodySchema = z.strictObject({
  batchId: changeBatchIdSchema,
  /** A file changed since the batch wrote it: `skip` it (listed in `skipped`) or `force` the restore. */
  conflicts: conflictHandlingSchema,
})
export type ChangeUndoBody = z.infer<typeof changeUndoBodySchema>

/** Query of `GET /chats/:id/rewind`: the user message to rewind the files to. */
export const rewindQuerySchema = z.object({
  messageId: messageIdSchema,
})
export type RewindQuery = z.infer<typeof rewindQuerySchema>

/** Body of `POST /chats/:id/rewind`; strict. */
export const rewindBodySchema = z.strictObject({
  /** A user message of the chat: every file the chat changed since it was sent goes back to its state at that time. */
  messageId: messageIdSchema,
  /** A file changed since the chat's last recorded change: `skip` it (listed in `skipped`) or `force` the restore. */
  conflicts: conflictHandlingSchema,
})
export type RewindBody = z.infer<typeof rewindBodySchema>

/**
 * What a rewind does with a file: `restore` its earlier content, `delete` it (the chat created it), nothing
 * (`unchanged`), or nothing because the earlier state is not stored (`unavailable`: `too-large` or `evicted`).
 */
export const rewindActionSchema = z.enum(['restore', 'delete', 'unchanged', 'unavailable'])
export type RewindAction = z.infer<typeof rewindActionSchema>

/** One file of a rewind preview. */
export const rewindFileSchema = z.object({
  path: z.string(),
  action: rewindActionSchema,
  /** The disk state differs from the state after the chat's last recorded change (skipped unless `force`). */
  conflict: z.boolean(),
  /** Journaled changes of this file in the range. */
  edits: countSchema,
})
export type RewindFile = z.infer<typeof rewindFileSchema>

/** A shell command run in the range of a rewind (never restored). */
export const rewindShellCommandSchema = z.object({
  /** The command, cut at `LIMITS.journalCommandMaxChars`. */
  command: z.string().max(LIMITS.journalCommandMaxChars),
  at: timestampSchema,
  /** The assistant message of the call; null when unknown. */
  messageId: messageIdSchema.nullable(),
})
export type RewindShellCommand = z.infer<typeof rewindShellCommandSchema>

/** A call of another tool with workspace access `write` / `execute` in the range of a rewind (never restored). */
export const rewindToolCallSchema = z.object({
  tool: toolNameSchema,
  at: timestampSchema,
  messageId: messageIdSchema.nullable(),
})
export type RewindToolCall = z.infer<typeof rewindToolCallSchema>

/** `GET /chats/:id/rewind?messageId=`: what `POST /chats/:id/rewind` would do (writes nothing). */
export const rewindPreviewSchema = z.object({
  messageId: messageIdSchema,
  /** At most `LIMITS.changesFilesMax` files, most recently changed first. */
  files: z.array(rewindFileSchema).max(LIMITS.changesFilesMax),
  /** Changes in the range that a rewind cannot undo. */
  untracked: z.object({
    /** Every shell command in the range (`shell` lists at most `LIMITS.rewindUntrackedListMax`, the latest first). */
    shellCount: countSchema,
    shell: z.array(rewindShellCommandSchema).max(LIMITS.rewindUntrackedListMax),
    /** At most `LIMITS.rewindUntrackedListMax` calls, the latest first. */
    tools: z.array(rewindToolCallSchema).max(LIMITS.rewindUntrackedListMax),
  }),
  /** More files are in the range than were listed. */
  truncated: z.boolean(),
})
export type RewindPreview = z.infer<typeof rewindPreviewSchema>

/** Why a file of a revert, rewind or undo was not written. */
export const restoreSkipReasonSchema = z.enum(['conflict', 'unavailable', 'refused', 'failed'])
export type RestoreSkipReason = z.infer<typeof restoreSkipReasonSchema>

/** A file a revert, rewind or undo left as it was. */
export const restoreSkipSchema = z.object({
  path: z.string(),
  /**
   * `conflict` (changed since the last recorded change, `skip`), `unavailable` (the earlier state is not stored),
   * `refused` (the path guard refused it: `.git`, a link out of the folder, not a regular file), `failed` (a write error).
   */
  reason: restoreSkipReasonSchema,
  /** Safe to show. */
  message: z.string(),
})
export type RestoreSkip = z.infer<typeof restoreSkipSchema>

/** Answer of a revert, an undo and a rewind: one undoable batch (`batchId`). */
export const restoreResultSchema = z.object({
  /** The batch that recorded the writes (undo it with `POST /chats/:id/changes/undo`); null when nothing was written. */
  batchId: changeBatchIdSchema.nullable(),
  /** Files written back to an earlier content. */
  restored: z.array(z.string()),
  /** Files removed (they did not exist at the target state). */
  deleted: z.array(z.string()),
  /** Files already at the target state. */
  unchanged: z.array(z.string()),
  skipped: z.array(restoreSkipSchema),
})
export type RestoreResult = z.infer<typeof restoreResultSchema>

// ---------- event ----------

/**
 * Data of `workspace.changed` (ADR-036): files of a project folder were written by an agent tool (coalesced to at most
 * one event per second per chat) or by a rewind, revert or undo (one event per batch that wrote something).
 */
export const workspaceChangedDataSchema = z.object({
  projectId: projectIdSchema,
  /** The chat that wrote the files; null when unknown. */
  chatId: chatIdSchema.nullable(),
  /** The rewind, revert or undo batch; null for agent tool edits. */
  batchId: changeBatchIdSchema.nullable(),
  source: workspaceChangedSourceSchema,
  /** Project-relative paths, at most `LIMITS.workspaceEventPathsMax` (more files changed: the first ones). */
  paths: z.array(z.string()).max(LIMITS.workspaceEventPathsMax),
})
export type WorkspaceChangedData = z.infer<typeof workspaceChangedDataSchema>
