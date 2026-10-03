// The two project-file calls of `@` mentions (docs/UI.md 7.26, 11.6; docs/API.md 4.25; ADR-042), through `useApi()`
// (no store): `search` -> `GET /projects/:id/files?q=&limit=` (ranked by the server with `rankPaths`), `attach` ->
// `POST /projects/:id/files/attach { path }` (an upload snapshot of the file: 201 `FileRef`; 400 / 404 / 413 thrown as
// `HarnessError`). Signature frozen from Gate P9-0b (C25); W9.8 implements it. Inert in P9-0b: both reject with
// `not_implemented` (nothing calls them yet).
import type { FileRef, ProjectFileSearch } from '@harness-forge/shared'
import { HarnessError } from '@harness-forge/shared'

export interface ProjectFilesApi {
  /** The best matches of `q` among the project's files and folders (`limit` default 50). */
  search: (projectId: string, q: string, opts?: { limit?: number, signal?: AbortSignal }) => Promise<ProjectFileSearch>
  /** Attaches a project file as an upload (the chip of a picked mention). */
  attach: (projectId: string, path: string, opts?: { signal?: AbortSignal }) => Promise<FileRef>
}

function notImplemented(): HarnessError {
  return new HarnessError({ code: 'not_implemented', message: 'File mentions are not available yet.' })
}

/** Search and attach of project files for the `@` menu. */
export function useProjectFiles(): ProjectFilesApi {
  return {
    search: async () => {
      throw notImplemented()
    },
    attach: async () => {
      throw notImplemented()
    },
  }
}
