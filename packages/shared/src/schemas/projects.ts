// Project DTOs (API.md section 4.20, ADR-031): a project is a named folder on the server host, inside the allowed roots
// (`HF_WORKSPACE_ROOTS`, default `<dataDir>/workspaces`); a chat optionally belongs to one (`ChatSummary.projectId`).
// Routes `/projects` (module `projects`), event `project.changed`. Projects are not part of backups or chat exports.
import { z } from 'zod'
import { agentNameSchema, projectIdSchema, timestampSchema } from '../ids.ts'
import { LIMITS } from '../limits.ts'

/** No control character (C0, DEL, C1): NUL included. */
const NO_CONTROL_CHARS = /^\P{Cc}*$/u

/** Project files read from the project root, in order of preference: `AGENTS.md`, else `CLAUDE.md`. */
export const PROJECT_INSTRUCTIONS_FILES = ['AGENTS.md', 'CLAUDE.md'] as const

export const projectInstructionsFileSchema = z.enum(PROJECT_INSTRUCTIONS_FILES)
export type ProjectInstructionsFile = z.infer<typeof projectInstructionsFileSchema>

/**
 * A folder path on the server host (project folders, browse paths): 1..4096 characters without NUL or other control
 * characters. Shape only: the server resolves it (realpath) and checks it against the allowed roots and the data dir.
 */
export const workspacePathSchema = z
  .string()
  .min(1)
  .max(LIMITS.workspacePathMaxChars)
  .regex(NO_CONTROL_CHARS, 'Paths cannot contain control characters.')
export type WorkspacePath = z.infer<typeof workspacePathSchema>

/** Why `value` is not a valid name of a new folder, or null. */
function folderNameProblem(value: string): string | null {
  if (value !== value.trim())
    return 'Folder names cannot start or end with a space.'
  if (!NO_CONTROL_CHARS.test(value))
    return 'Folder names cannot contain control characters.'
  if (value.includes('/') || value.includes('\\'))
    return 'Folder names cannot contain "/" or "\\".'
  if (value === '.' || value === '..')
    return 'Folder names cannot be "." or "..".'
  if (value.startsWith('.'))
    return 'Folder names cannot start with a dot.'
  return null
}

/**
 * The name of a folder created inside an existing one (`ProjectCreate.newFolder`): 1..255 characters, already trimmed
 * (not trimmed here), no `/`, `\`, NUL or other control characters, not `.` / `..`, no leading dot (hidden folders are
 * not listed by the folder browser).
 */
export const folderNameSchema = z
  .string()
  .min(1)
  .max(255)
  .superRefine((value, ctx) => {
    const problem = folderNameProblem(value)
    if (problem !== null)
      ctx.addIssue({ code: 'custom', message: problem })
  })
export type FolderName = z.infer<typeof folderNameSchema>

/** A project name sent by the client: trimmed, 1..80 characters. */
export const projectNameSchema = z.string().trim().min(1).max(LIMITS.projectNameMaxChars)

/** Project instructions: added to the run instructions after the project file (same bound as chat instructions). */
const projectInstructionsSchema = z.string().max(LIMITS.instructionsMaxChars)

export const projectSummarySchema = z.object({
  id: projectIdSchema,
  name: z.string(),
  /** The canonical realpath of the folder on the server host (unique among projects; never changes). */
  path: z.string(),
  /** The project's own instructions; null = none. */
  instructions: z.string().nullable(),
  /** The folder exists, is a directory and still lies inside an allowed root (checked when listed). */
  available: z.boolean(),
  /** Why the folder is not available (safe to show); null when `available`. */
  issue: z.string().nullable(),
  /** The project file found in the folder root and added to the instructions, if any. */
  instructionsFile: projectInstructionsFileSchema.nullable(),
  /** Chats of the project, archived ones included. */
  chatCount: z.int().min(0),
  /**
   * The project's output style (Phase 11, ADR-051; column `projects.output_style`): wins over the global `outputStyle`,
   * loses to a chat's own choice; null = the global setting.
   */
  outputStyle: z.string().nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
})
export type ProjectSummary = z.infer<typeof projectSummarySchema>

/**
 * Body of `POST /projects` (fresh auth): an existing folder (`path`), or, with `newFolder`, a new folder created inside
 * `path`. The folder must lie inside an allowed root and may not equal, contain or sit inside the data directory.
 */
export const projectCreateSchema = z.strictObject({
  name: projectNameSchema,
  /** The project folder, or the parent of the new folder when `newFolder` is set. */
  path: workspacePathSchema,
  /** Create this folder inside `path` (an existing one is `409`, reason `exists`). */
  newFolder: folderNameSchema.optional(),
})
export type ProjectCreate = z.infer<typeof projectCreateSchema>

/** Body of `PATCH /projects/:id`: strict, at least one key; the folder of a project never changes. */
export const projectUpdateSchema = z
  .strictObject({
    name: projectNameSchema.optional(),
    /** null (or an empty string) removes the instructions. */
    instructions: projectInstructionsSchema.nullable().optional(),
    /** Phase 11 (ADR-051): a style name, or null = the global setting. */
    outputStyle: agentNameSchema.nullable().optional(),
  })
  .refine(value => Object.keys(value).length > 0, 'Send at least one field.')
export type ProjectUpdate = z.infer<typeof projectUpdateSchema>

/** Query of `GET /projects/browse`: omitted `path` = only the allowed roots. */
export const projectBrowseQuerySchema = z.object({
  path: workspacePathSchema.optional(),
})
export type ProjectBrowseQuery = z.infer<typeof projectBrowseQuerySchema>

/** An allowed root (`HF_WORKSPACE_ROOTS`) as the folder browser shows it. */
export const projectBrowseRootSchema = z.object({
  /** Canonical realpath. */
  path: z.string(),
  /** The root exists and is a directory. */
  available: z.boolean(),
})
export type ProjectBrowseRoot = z.infer<typeof projectBrowseRootSchema>

/** A subfolder of the browsed folder. */
export const projectBrowseEntrySchema = z.object({
  name: z.string(),
  /** Canonical realpath of the subfolder. */
  path: z.string(),
  /** The project that already uses this folder, if any. */
  projectId: projectIdSchema.nullable(),
})
export type ProjectBrowseEntry = z.infer<typeof projectBrowseEntrySchema>

/**
 * Response of `GET /projects/browse`: the subfolders of `path` (directories only; symbolic links, dot folders,
 * `node_modules` and the data directory are not listed), sorted by name, at most `LIMITS.browseEntriesMax`.
 */
export const projectBrowseSchema = z.object({
  /** The browsed folder (canonical realpath); null when only the roots were asked for. */
  path: z.string().nullable(),
  /** The parent folder while it is still inside a root; null at a root and for the roots listing. */
  parent: z.string().nullable(),
  /** Every allowed root. */
  roots: z.array(projectBrowseRootSchema),
  /** Subfolders of `path`; empty for the roots listing. */
  entries: z.array(projectBrowseEntrySchema).max(LIMITS.browseEntriesMax),
  /** More subfolders exist than were listed. */
  truncated: z.boolean(),
})
export type ProjectBrowse = z.infer<typeof projectBrowseSchema>
