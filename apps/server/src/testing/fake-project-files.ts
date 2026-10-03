// Test double of `ProjectFileService` (Phase 9, C24-T5), so the mention routes (W9.6) and other tests can search and
// attach project files without a real index:
//
//   const t = await createTestApp({ projectFiles: 'fake' })   // or overrides: { projectFiles: createFakeProjectFileService({ files }) }
//   const files = t.deps.projectFiles as FakeProjectFileService
//   files.files.set(projectId, ['src/app.ts', 'README.md'])
//   await files.search(projectId, { q: 'app', limit: 50 })  // { items: [{ path: 'src/app.ts', kind: 'file' }], ... }
//
// Paths live in memory per project (a project is known when it has an entry in `files`). Follows the contract where
// callers can see it: the folders are derived from the file paths (`projectFileEntries`, the real service's helper), the
// ranking is the shared `rankPaths` (never a local one), `truncated` is the index flag (`truncatedProjects`),
// `indexedAt` is set by the first search after creation or `invalidate` (the lazy index), `not_found` for an unknown
// project or file, `validation_error` on `['path']` for a folder. `attach` returns a fixed `FileRef`
// (`FAKE_PROJECT_FILE_REF` with the basename of the path) without reading or storing anything. Every call is counted
// and recorded.
import type { FileRef, ProjectFileAttachBody, ProjectFilesQuery } from '@harness-forge/shared'
import type { ProjectFileService } from '../services/project-files/types.ts'
import { HarnessError, rankPaths, validationError } from '@harness-forge/shared'
import { projectFileEntries } from '../services/project-files/file-index.ts'

export { projectFileEntries } from '../services/project-files/file-index.ts'

/** The `FileRef` of every fake attach (its `name` is replaced by the basename of the attached path). */
export const FAKE_PROJECT_FILE_REF: FileRef = Object.freeze({
  id: 'file_fakeprojectfile1',
  name: 'file.txt',
  mime: 'text/plain',
  size: 12,
  url: '/api/files/file_fakeprojectfile1',
})

export interface FakeProjectFileServiceOptions {
  /** The file paths of each project (project-relative POSIX paths, without folders); default: no project. */
  files?: Readonly<Record<string, readonly string[]>>
  /** The answer of `attach` (default: `FAKE_PROJECT_FILE_REF` with the basename of the path as `name`). */
  fileRef?: (projectId: string, path: string) => FileRef
  /** Clock of `indexedAt` (default `Date.now`). */
  now?: () => number
}

export interface FakeProjectFileService extends ProjectFileService {
  /** The file paths of each known project; tests may add, edit or remove entries (no invalidation implied). */
  readonly files: Map<string, string[]>
  /** Projects whose index counts as cut (`truncated: true` in every search). */
  readonly truncatedProjects: Set<string>
  /** When each project's index was built (set by a search, removed by `invalidate` and `stop`). */
  readonly indexedAt: Map<string, number>
  /** Number of calls of each member. */
  readonly calls: { search: number, attach: number, invalidate: number, stop: number }
  /** Every `search` call, in order. */
  readonly searches: Array<{ projectId: string, query: ProjectFilesQuery }>
  /** Every `attach` call, in order. */
  readonly attaches: Array<{ projectId: string, path: string }>
  /** Every `invalidate` call (the project id), in order. */
  readonly invalidated: string[]
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** An in-memory `ProjectFileService` (see the module comment). */
export function createFakeProjectFileService(options: FakeProjectFileServiceOptions = {}): FakeProjectFileService {
  const now = options.now ?? Date.now
  const files = new Map<string, string[]>(Object.entries(options.files ?? {}).map(([id, paths]) => [id, [...paths]]))
  const truncatedProjects = new Set<string>()
  const indexedAt = new Map<string, number>()
  const calls = { search: 0, attach: 0, invalidate: 0, stop: 0 }
  const searches: FakeProjectFileService['searches'] = []
  const attaches: FakeProjectFileService['attaches'] = []
  const invalidated: string[] = []

  function pathsOf(projectId: string): string[] {
    const paths = files.get(projectId)
    if (paths === undefined)
      throw new HarnessError({ code: 'not_found', message: `Project ${projectId} not found.` })
    return paths
  }

  return {
    files,
    truncatedProjects,
    indexedAt,
    calls,
    searches,
    attaches,
    invalidated,
    search: async (projectId, query) => {
      calls.search += 1
      searches.push({ projectId, query: { ...query } })
      const entries = projectFileEntries(pathsOf(projectId))
      const builtAt = indexedAt.get(projectId) ?? now()
      indexedAt.set(projectId, builtAt)
      const ranked = rankPaths(query.q, entries, query.limit)
      return {
        items: ranked.items.map(item => ({ path: item.path, kind: item.kind })),
        truncated: truncatedProjects.has(projectId),
        indexedAt: builtAt,
      }
    },
    attach: async (projectId, body: ProjectFileAttachBody) => {
      calls.attach += 1
      attaches.push({ projectId, path: body.path })
      const paths = pathsOf(projectId)
      if (!paths.includes(body.path)) {
        if (projectFileEntries(paths).some(entry => entry.kind === 'dir' && entry.path === body.path))
          throw validationError([{ path: ['path'], message: `${body.path} is a folder.`, code: 'custom' }])
        throw new HarnessError({ code: 'not_found', message: `File ${body.path} not found.` })
      }
      return options.fileRef?.(projectId, body.path) ?? { ...FAKE_PROJECT_FILE_REF, name: basename(body.path) }
    },
    invalidate: (projectId) => {
      calls.invalidate += 1
      invalidated.push(projectId)
      indexedAt.delete(projectId)
    },
    stop: () => {
      calls.stop += 1
      indexedAt.clear()
    },
  }
}
