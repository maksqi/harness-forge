// The fake project file service (C24-T5) follows the `ProjectFileService` contract where callers can see it, so W9.6
// and the route tests can rely on it.
import type { HarnessError } from '@harness-forge/shared'
import { fileRefSchema, LIMITS, projectFileSearchSchema, projectFilesQuerySchema, rankPaths } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { createFakeProjectFileService, FAKE_PROJECT_FILE_REF, projectFileEntries } from './fake-project-files.ts'

const PROJECT = 'prj_AAAAAAAAAAAAAAAA'
const OTHER = 'prj_BBBBBBBBBBBBBBBB'
const PATHS = ['src/app.ts', 'src/util/paths.ts', 'README.md', 'docs/api/routes.md']

async function failure(promise: Promise<unknown>): Promise<HarnessError> {
  try {
    await promise
  }
  catch (error) {
    return error as HarnessError
  }
  throw new Error('expected a rejection')
}

describe('createFakeProjectFileService', () => {
  it('derives the folders from the file paths (no trailing slash), files first', () => {
    expect(projectFileEntries(PATHS)).toEqual([
      { path: 'src/app.ts', kind: 'file' },
      { path: 'src/util/paths.ts', kind: 'file' },
      { path: 'README.md', kind: 'file' },
      { path: 'docs/api/routes.md', kind: 'file' },
      { path: 'docs', kind: 'dir' },
      { path: 'docs/api', kind: 'dir' },
      { path: 'src', kind: 'dir' },
      { path: 'src/util', kind: 'dir' },
    ])
    expect(projectFileEntries([])).toEqual([])
  })

  it('searches with the shared rankPaths and answers the shared response schema', async () => {
    let clock = 1000
    const files = createFakeProjectFileService({ files: { [PROJECT]: PATHS }, now: () => clock })
    const query = projectFilesQuerySchema.parse({ q: 'paths' })
    const result = await files.search(PROJECT, query)
    expect(projectFileSearchSchema.parse(result)).toEqual(result)
    const expected = rankPaths('paths', projectFileEntries(PATHS), LIMITS.mentionResultsMax).items.map(({ path, kind }) => ({ path, kind }))
    expect(result).toEqual({ items: expected, truncated: false, indexedAt: 1000 })
    expect(result.items[0]).toEqual({ path: 'src/util/paths.ts', kind: 'file' })
    // The empty query lists the entries; the limit applies.
    expect((await files.search(PROJECT, projectFilesQuerySchema.parse({ q: '', limit: '2' }))).items).toHaveLength(2)
    expect(files.calls.search).toBe(2)
    expect(files.searches.map(call => [call.projectId, call.query.q, call.query.limit])).toEqual([[PROJECT, 'paths', 50], [PROJECT, '', 2]])

    // The index is built once (indexedAt stays) until invalidate drops it.
    clock = 2000
    expect((await files.search(PROJECT, query)).indexedAt).toBe(1000)
    files.invalidate(PROJECT)
    expect(files.invalidated).toEqual([PROJECT])
    expect((await files.search(PROJECT, query)).indexedAt).toBe(2000)
    files.truncatedProjects.add(PROJECT)
    expect((await files.search(PROJECT, query)).truncated).toBe(true)
    files.stop()
    expect(files.indexedAt.size).toBe(0)
    expect(files.calls).toMatchObject({ invalidate: 1, stop: 1 })
  })

  it('answers not_found for an unknown project; tests may add projects later', async () => {
    const files = createFakeProjectFileService()
    const error = await failure(files.search(OTHER, { q: '', limit: 50 }))
    expect([error.code, error.message]).toEqual(['not_found', `Project ${OTHER} not found.`])
    files.files.set(OTHER, ['a.txt'])
    expect((await files.search(OTHER, { q: 'a', limit: 50 })).items).toEqual([{ path: 'a.txt', kind: 'file' }])
  })

  it('attach returns the fixed FileRef with the basename; a folder is refused on path, a missing file is not_found', async () => {
    const files = createFakeProjectFileService({ files: { [PROJECT]: PATHS } })
    const ref = await files.attach(PROJECT, { path: 'src/util/paths.ts' })
    expect(fileRefSchema.parse(ref)).toEqual({ ...FAKE_PROJECT_FILE_REF, name: 'paths.ts' })
    expect((await failure(files.attach(PROJECT, { path: 'src/util' }))).details).toMatchObject({ issues: [{ path: ['path'] }] })
    expect((await failure(files.attach(PROJECT, { path: 'missing.txt' }))).code).toBe('not_found')
    expect((await failure(files.attach(OTHER, { path: 'a.txt' }))).code).toBe('not_found')
    expect(files.attaches.map(call => call.path)).toEqual(['src/util/paths.ts', 'src/util', 'missing.txt', 'a.txt'])
    expect(files.calls.attach).toBe(4)

    const custom = createFakeProjectFileService({ files: { [PROJECT]: ['a.txt'] }, fileRef: (_, path) => ({ ...FAKE_PROJECT_FILE_REF, name: `custom-${path}` }) })
    expect((await custom.attach(PROJECT, { path: 'a.txt' })).name).toBe('custom-a.txt')
  })
})
