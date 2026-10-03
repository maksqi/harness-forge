// File mentions of project chats (Phase 9, ADR-042; API.md section 4.27): `@` in the composer searches the files of
// the chat's project (an in-memory index per project that respects `.gitignore` and leaves secret-looking paths out),
// and a picked file is attached as an upload snapshot.
import { z } from 'zod'
import { timestampSchema } from '../ids.ts'
import { LIMITS } from '../limits.ts'
import { queryIntSchema } from './common.ts'
import { workspaceToolPathSchema } from './workspace.ts'

/** Query of `GET /projects/:id/files`: `q` is matched against the project-relative paths (empty = the first entries). */
export const projectFilesQuerySchema = z.object({
  /** At most `LIMITS.mentionQueryMaxChars` (256) characters; default ''. */
  q: z.string().max(LIMITS.mentionQueryMaxChars).default(''),
  /** 1..50; default 50. */
  limit: queryIntSchema(1, LIMITS.mentionResultsMax).default(LIMITS.mentionResultsMax),
})
export type ProjectFilesQuery = z.infer<typeof projectFilesQuerySchema>

/** Kind of a mention candidate: a file, or a folder derived from the file paths (picking it narrows the query). */
export const projectFileKindSchema = z.enum(['file', 'dir'])
export type ProjectFileKind = z.infer<typeof projectFileKindSchema>

export const projectFileEntrySchema = z.object({
  /** Project-relative POSIX path (`src/app.ts`; a folder without a trailing `/`). */
  path: z.string(),
  kind: projectFileKindSchema,
})
export type ProjectFileEntry = z.infer<typeof projectFileEntrySchema>

/** Response of `GET /projects/:id/files`: the best matches first (`rankPaths`), at most `limit`. */
export const projectFileSearchSchema = z.object({
  items: z.array(projectFileEntrySchema).max(LIMITS.mentionResultsMax),
  /** The index was cut at `LIMITS.mentionIndexFilesMax` files (or by the walk limits), so a match may be missing. */
  truncated: z.boolean(),
  /** When the index of the project was built. */
  indexedAt: timestampSchema,
})
export type ProjectFileSearch = z.infer<typeof projectFileSearchSchema>

/** Body of `POST /projects/:id/files/attach`: a project-relative path (the answer is the `FileRef` of the upload). */
export const projectFileAttachBodySchema = z.strictObject({
  path: workspaceToolPathSchema,
})
export type ProjectFileAttachBody = z.infer<typeof projectFileAttachBodySchema>
