// The two project-file calls of `@` mentions (docs/UI.md 7.26, 11.6; docs/API.md 4.25; ADR-042), through `useApi()`
// (no store): `search` -> `GET /projects/:id/files?q=&limit=` (ranked by the server with `rankPaths`), `attach` ->
// `POST /projects/:id/files/attach { path }` (an upload snapshot of the file: 201 `FileRef`; 400 / 404 / 413 thrown as
// `HarnessError`). Signature frozen from Gate P9-0b (C25); implemented by W9.8. An aborted request rejects with the
// abort error (`isAbortError`), like every `$api` call.
import type { FileRef, ProjectFileSearch } from '@harness-forge/shared'
import { LIMITS } from '@harness-forge/shared'
import { useApi } from '~/composables/useApi'

export interface ProjectFilesApi {
  /** The best matches of `q` among the project's files and folders (`limit` default 50). */
  search: (projectId: string, q: string, opts?: { limit?: number, signal?: AbortSignal }) => Promise<ProjectFileSearch>
  /** Attaches a project file as an upload (the chip of a picked mention). */
  attach: (projectId: string, path: string, opts?: { signal?: AbortSignal }) => Promise<FileRef>
}

/** Search and attach of project files for the `@` menu. */
export function useProjectFiles(): ProjectFilesApi {
  const api = useApi()
  return {
    search: (projectId, q, opts = {}) => api.projectFiles.search({
      params: { id: projectId },
      query: { q, limit: opts.limit ?? LIMITS.mentionResultsMax },
      signal: opts.signal,
    }),
    attach: (projectId, path, opts = {}) => api.projectFiles.attach({
      params: { id: projectId },
      body: { path },
      signal: opts.signal,
    }),
  }
}
