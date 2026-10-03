import type { FileRef, ProjectFileSearch } from '@harness-forge/shared'
import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { projectFileEntry, projectId } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { useProjectFiles } from './useProjectFiles'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))

let api: MockApi

const search: ProjectFileSearch = { items: [projectFileEntry('src/parser.ts')], truncated: false, indexedAt: 1_759_000_000_000 }
const ref: FileRef = { id: 'file_parser0000000000', name: 'parser.ts', mime: 'text/plain', size: 120, url: '/api/files/file_parser0000000000' }

describe('useProjectFiles', () => {
  beforeEach(() => {
    api = createMockApi()
    mock.api = api
  })

  it('searches the project files through $api (limit 50 by default) with the abort signal', async () => {
    api.projectFiles.search.mockResolvedValue(search)
    const files = useProjectFiles()
    const controller = new AbortController()
    await expect(files.search(projectId(1), 'pars', { signal: controller.signal })).resolves.toEqual(search)
    expect(api.projectFiles.search).toHaveBeenCalledWith({
      params: { id: projectId(1) },
      query: { q: 'pars', limit: 50 },
      signal: controller.signal,
    })
    await files.search(projectId(2), '', { limit: 10 })
    expect(api.projectFiles.search).toHaveBeenLastCalledWith({ params: { id: projectId(2) }, query: { q: '', limit: 10 }, signal: undefined })
  })

  it('attaches a project file as an upload and passes the server errors through', async () => {
    api.projectFiles.attach.mockResolvedValueOnce(ref)
    const files = useProjectFiles()
    await expect(files.attach(projectId(1), 'src/parser.ts')).resolves.toEqual(ref)
    expect(api.projectFiles.attach).toHaveBeenCalledWith({ params: { id: projectId(1) }, body: { path: 'src/parser.ts' }, signal: undefined })

    const tooLarge = new HarnessError({ code: 'payload_too_large', message: 'Files are limited to 5 MB.' })
    api.projectFiles.attach.mockRejectedValueOnce(tooLarge)
    await expect(files.attach(projectId(1), 'big.log')).rejects.toBe(tooLarge)
  })
})
