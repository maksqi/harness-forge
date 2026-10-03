// Frozen interface of the project files service (Phase 9, ADR-042; API.md 4.27 / 5.27, ARCHITECTURE.md 6.21): the
// `@` mentions of project chats. Implementation: `createProjectFileService(deps)` in `services/project-files/index.ts`
// (C24 stub; W9.6). Consumers: the `projectFiles` routes (`http/routes/project-files.ts`, W9.6) and shutdown
// (`stopDeps`: `stop()` right after the runs stopped). Test double: `createFakeProjectFileService`
// (`testing/fake-project-files.ts`), installed with `createTestApp({ projectFiles: 'fake' })`.
//
// The index is per project and in memory: built lazily by the first search (no boot step) with `walkWorkspace`
// (`workspace/walk.ts`: `.gitignore`, `node_modules`, the walk's entry, depth and time limits), secret-looking paths
// (`workspace/sensitive.ts`) and `.git` left out, at most `LIMITS.mentionIndexFilesMax` files, one build at a time per
// project (single-flight), rebuilt when older than `LIMITS.mentionIndexTtlMs`, dropped on a `workspace.changed` event
// of the project, on project deletion and at shutdown. Ranking only through the shared `rankPaths`
// (`packages/shared/src/util/mentions.ts`). Queries, paths and file contents are never logged at info.
import type { FileRef, ProjectFileAttachBody, ProjectFileSearch, ProjectFilesQuery } from '@harness-forge/shared'

/**
 * File search and attach for `@` mentions. Errors are `HarnessError`s the routes pass through. Frozen after P9-0b.
 */
export interface ProjectFileService {
  /**
   * `GET /projects/:id/files` (query validated by the route with `projectFilesQuerySchema`): the project's files and the
   * folders derived from their paths, ranked by `rankPaths(query.q, entries, query.limit)` (an empty `q` = the first
   * entries), with `truncated` (the index was cut) and `indexedAt` (when the index was built). Throws `not_found` for
   * an unknown project ("Project <id> not found.") and `validation_error` when the project folder cannot be opened
   * (the `openWorkspace` message).
   */
  readonly search: (projectId: string, query: ProjectFilesQuery) => Promise<ProjectFileSearch>
  /**
   * `POST /projects/:id/files/attach` (body validated by the route with `projectFileAttachBodySchema`): resolves
   * `body.path` through `resolveWorkspacePath` (realpath containment), refuses a `.git` segment, a secret-looking path
   * or a folder (`validation_error` on `['path']`), reads the file (`not_found` when missing; `payload_too_large` with
   * `details.limitBytes` = `LIMITS.mentionFileMaxBytes` above 5 MiB) and stores the bytes through `files.upload` (type
   * sniffing and the upload pins; a refused type is the upload's `validation_error`). Returns the upload's `FileRef`: a
   * snapshot, deduplicated by content. `not_found` for an unknown project, `validation_error` for an unavailable folder.
   */
  readonly attach: (projectId: string, body: ProjectFileAttachBody) => Promise<FileRef>
  /**
   * Drops the project's index (a build in flight is discarded), so the next search rebuilds it. Called by the service
   * itself on `workspace.changed` and on project deletion; never throws; a no-op for a project without an index.
   */
  readonly invalidate: (projectId: string) => void
  /**
   * Shutdown (`stopDeps`, after the runs stopped): drops every index, discards builds in flight and removes the event
   * subscription and timers. Idempotent; never throws.
   */
  readonly stop: () => void
}
