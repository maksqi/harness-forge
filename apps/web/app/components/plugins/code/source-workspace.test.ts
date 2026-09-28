import type { ApiClient, BuildResult, PluginFileEntry } from '@harness-forge/shared'
import type { RequestRunner } from './source-workspace'
import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockApi } from '~/utils/testing/mock-api'
import { sha256Hex } from './source-files'
import { createSourceWorkspace, getSourceWorkspace, hasUnsavedSourceChanges, releaseSourceWorkspace, resetSourceWorkspaces } from './source-workspace'

let api: MockApi

function entry(path: string): PluginFileEntry {
  return { path, type: 'file', size: 1, mtime: 1, editable: true }
}

async function etag(content: string): Promise<string> {
  return (await sha256Hex(content))!
}

function build(overrides: Partial<BuildResult> = {}): BuildResult {
  return { ok: true, durationMs: 12, diagnostics: [], hash: 'a'.repeat(64), state: 'active', ...overrides }
}

function workspace() {
  return createSourceWorkspace('my-tool', api as unknown as ApiClient)
}

beforeEach(async () => {
  api = createMockApi()
  api.pluginFiles.list.mockResolvedValue({ items: [entry('index.mjs'), entry('plugin.json')] })
  api.pluginFiles.read.mockImplementation(async ({ params }: { params: { path: string } }) => ({
    path: params.path,
    content: `content of ${params.path}`,
    etag: await etag(`content of ${params.path}`),
    mtime: 1,
  }))
  api.pluginFiles.write.mockImplementation(async ({ params, body }: { params: { path: string }, body: { content: string } }) => ({
    path: params.path,
    type: 'file',
    size: body.content.length,
    mtime: 2,
    editable: true,
  }))
  api.pluginFiles.remove.mockResolvedValue(undefined)
})

afterEach(() => {
  resetSourceWorkspaces()
})

describe('source workspace', () => {
  it('loads the tree, opens files once and tracks unsaved changes', async () => {
    const ws = workspace()
    await ws.loadTree()
    expect(ws.entries.value.map(item => item.path)).toEqual(['index.mjs', 'plugin.json'])
    await ws.open('index.mjs')
    await ws.open('index.mjs')
    expect(api.pluginFiles.read).toHaveBeenCalledTimes(1)
    expect(ws.active.value).toMatchObject({ path: 'index.mjs', status: 'ready', content: 'content of index.mjs' })
    expect(ws.dirtyPaths.value).toEqual([])
    ws.update('index.mjs', 'changed')
    expect(ws.isDirty('index.mjs')).toBe(true)
    expect(ws.dirtyPaths.value).toEqual(['index.mjs'])
    ws.update('index.mjs', 'content of index.mjs')
    expect(ws.isDirty('index.mjs')).toBe(false)
  })

  it('saves with the etag, then uses the etag of the saved content', async () => {
    const ws = workspace()
    await ws.open('index.mjs')
    ws.update('index.mjs', 'first')
    await ws.save('index.mjs')
    expect(api.pluginFiles.write).toHaveBeenLastCalledWith({
      params: { id: 'my-tool', path: 'index.mjs' },
      body: { content: 'first', baseEtag: await etag('content of index.mjs') },
    })
    expect(ws.isDirty('index.mjs')).toBe(false)
    expect(ws.savedAt.value).toEqual(expect.any(Number))
    ws.update('index.mjs', 'second')
    await ws.save('index.mjs')
    expect(api.pluginFiles.write).toHaveBeenLastCalledWith({
      params: { id: 'my-tool', path: 'index.mjs' },
      body: { content: 'second', baseEtag: await etag('first') },
    })
    // Nothing to save: no request.
    await ws.save('index.mjs')
    expect(api.pluginFiles.write).toHaveBeenCalledTimes(2)
  })

  it('keeps the buffer on a stale conflict and can overwrite or reload', async () => {
    const ws = workspace()
    await ws.open('index.mjs')
    ws.update('index.mjs', 'mine')
    api.pluginFiles.write.mockRejectedValueOnce(new HarnessError({ code: 'conflict', message: 'Changed.', details: { reason: 'stale' } }))
    await expect(ws.save('index.mjs')).rejects.toMatchObject({ code: 'conflict' })
    expect(ws.active.value?.content).toBe('mine')
    expect(ws.isDirty('index.mjs')).toBe(true)

    await ws.overwrite('index.mjs')
    expect(api.pluginFiles.write).toHaveBeenLastCalledWith({ params: { id: 'my-tool', path: 'index.mjs' }, body: { content: 'mine' } })
    expect(ws.isDirty('index.mjs')).toBe(false)

    ws.update('index.mjs', 'again')
    await ws.reload('index.mjs')
    expect(ws.active.value?.content).toBe('content of index.mjs')
  })

  it('runs writes and builds through the attached runner (fresh auth)', async () => {
    const ws = workspace()
    const calls = vi.fn()
    const runner: RequestRunner = (task) => {
      calls()
      return task()
    }
    const detach = ws.attach(runner)
    await ws.open('index.mjs')
    ws.update('index.mjs', 'x')
    await ws.save('index.mjs')
    expect(calls).toHaveBeenCalledTimes(1)
    detach()
    ws.update('index.mjs', 'y')
    await ws.save('index.mjs')
    expect(calls).toHaveBeenCalledTimes(1)
  })

  it('build saves dirty files first and keeps the diagnostics', async () => {
    const ws = workspace()
    await ws.open('index.mjs')
    await ws.open('plugin.json')
    ws.update('index.mjs', 'const = 1')
    ws.update('plugin.json', '{}')
    const calls: string[] = []
    api.pluginFiles.write.mockImplementation(async ({ params }: { params: { path: string } }) => {
      calls.push(`write ${params.path}`)
      return entry(params.path)
    })
    const diagnostic = { severity: 'error' as const, file: 'index.mjs', line: 1, column: 7, message: 'Expected identifier' }
    api.pluginFiles.build.mockImplementation(async () => {
      calls.push('build')
      return build({ ok: false, diagnostics: [diagnostic], hash: null })
    })
    const result = await ws.build()
    expect(calls).toEqual(['write index.mjs', 'write plugin.json', 'build'])
    expect(api.pluginFiles.build).toHaveBeenCalledWith({ params: { id: 'my-tool' }, body: { reload: true } })
    expect(result.ok).toBe(false)
    expect(ws.diagnostics.value).toEqual([diagnostic])
    expect(ws.lastBuild.value).toEqual(result)
    expect(ws.busy.value).toBeNull()

    api.pluginFiles.build.mockResolvedValue(build())
    await ws.build()
    expect(ws.diagnostics.value).toEqual([])
  })

  it('does not build when saving fails', async () => {
    const ws = workspace()
    await ws.open('index.mjs')
    ws.update('index.mjs', 'x')
    api.pluginFiles.write.mockRejectedValueOnce(new HarnessError({ code: 'forbidden', message: 'No.' }))
    await expect(ws.build()).rejects.toMatchObject({ code: 'forbidden' })
    expect(api.pluginFiles.build).not.toHaveBeenCalled()
  })

  it('creates, renames and deletes files', async () => {
    const ws = workspace()
    await ws.createFile('lib/util.mjs')
    expect(api.pluginFiles.write).toHaveBeenCalledWith({ params: { id: 'my-tool', path: 'lib/util.mjs' }, body: { content: '' } })
    expect(ws.activePath.value).toBe('lib/util.mjs')

    await ws.open('index.mjs')
    ws.update('index.mjs', 'renamed content')
    await ws.renameFile('index.mjs', 'main.mjs')
    expect(api.pluginFiles.write).toHaveBeenLastCalledWith({ params: { id: 'my-tool', path: 'main.mjs' }, body: { content: 'renamed content' } })
    expect(api.pluginFiles.remove).toHaveBeenLastCalledWith({ params: { id: 'my-tool', path: 'index.mjs' } })
    expect(ws.activePath.value).toBe('main.mjs')
    expect(ws.files.map(file => file.path)).toEqual(['lib/util.mjs', 'main.mjs'])
    expect(ws.isDirty('main.mjs')).toBe(false)

    await ws.deleteFile('lib/util.mjs')
    expect(api.pluginFiles.remove).toHaveBeenLastCalledWith({ params: { id: 'my-tool', path: 'lib/util.mjs' } })
    expect(ws.files.map(file => file.path)).toEqual(['main.mjs'])
  })

  it('closes tabs and activates a neighbour; discardAll drops every edit', async () => {
    const ws = workspace()
    await ws.open('a.mjs')
    await ws.open('b.mjs')
    await ws.open('c.mjs')
    await ws.open('b.mjs')
    ws.close('b.mjs')
    expect(ws.activePath.value).toBe('c.mjs')
    ws.update('a.mjs', 'x')
    ws.update('c.mjs', 'y')
    expect(ws.dirtyPaths.value).toEqual(['a.mjs', 'c.mjs'])
    ws.discardAll()
    expect(ws.dirtyPaths.value).toEqual([])
  })

  it('reports a file that cannot be opened', async () => {
    api.pluginFiles.read.mockRejectedValueOnce(new HarnessError({ code: 'validation_error', message: 'Not a text file.' }))
    const ws = workspace()
    await ws.open('image.png')
    expect(ws.active.value).toMatchObject({ status: 'error', error: 'Not a text file.' })
  })
})

describe('workspace cache', () => {
  it('keeps workspaces with unsaved changes and warns before unload', async () => {
    const client = api as unknown as ApiClient
    const ws = getSourceWorkspace('cached', client)
    expect(getSourceWorkspace('cached', client)).toBe(ws)
    await ws.open('index.mjs')
    ws.update('index.mjs', 'unsaved')
    expect(hasUnsavedSourceChanges()).toBe(true)
    releaseSourceWorkspace('cached')
    expect(getSourceWorkspace('cached', client)).toBe(ws)

    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)

    ws.discardAll()
    releaseSourceWorkspace('cached')
    expect(getSourceWorkspace('cached', client)).not.toBe(ws)
    expect(hasUnsavedSourceChanges()).toBe(false)
  })
})
