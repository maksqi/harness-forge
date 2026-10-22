import type { FileRef } from '@harness-forge/shared'
import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError, LIMITS } from '@harness-forge/shared'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import { projectId } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { useComposerAttachments } from './useComposerAttachments'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))

let api: MockApi

function fileRef(id: string, name: string, mime = 'text/plain'): FileRef {
  return { id: `file_${id.padEnd(16, '0')}`, name, mime, size: 5, url: `/api/files/file_${id.padEnd(16, '0')}` }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function setup(onReject = vi.fn()) {
  const scope = effectScope()
  const attachments = scope.run(() => useComposerAttachments({ onReject }))!
  return { scope, attachments, onReject }
}

describe('useComposerAttachments', () => {
  beforeEach(() => {
    api = createMockApi()
    mock.api = api
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('uploads each file at once through $api (multipart `file`) and exposes the file refs', async () => {
    const upload = deferred<FileRef>()
    api.files.upload.mockReturnValueOnce(upload.promise)
    const { scope, attachments } = setup()

    attachments.add([new File(['hello'], 'notes.md', { type: 'text/markdown' })])
    expect(attachments.items.value).toHaveLength(1)
    expect(attachments.items.value[0]).toMatchObject({ name: 'notes.md', mime: 'text/markdown', state: 'uploading' })
    expect(attachments.uploading.value).toBe(true)

    const [input] = api.files.upload.mock.calls[0]!
    expect(input.form).toBeInstanceOf(FormData)
    expect((input.form as FormData).get('file')).toBeInstanceOf(File)
    expect(input.signal).toBeInstanceOf(AbortSignal)

    upload.resolve(fileRef('a', 'notes.md', 'text/markdown'))
    await flushPromises()
    expect(attachments.items.value[0]!.state).toBe('done')
    expect(attachments.uploading.value).toBe(false)
    expect(attachments.fileRefs.value.map(ref => ref.name)).toEqual(['notes.md'])
    scope.stop()
  })

  it('re-types known text files so the server accepts them', async () => {
    api.files.upload.mockResolvedValue(fileRef('b', 'index.ts'))
    const { scope, attachments } = setup()
    attachments.add([new File(['export {}'], 'index.ts', { type: 'video/mp2t' })])
    const [input] = api.files.upload.mock.calls[0]!
    expect(((input.form as FormData).get('file') as File).type).toBe('text/plain')
    await flushPromises()
    scope.stop()
  })

  it('rejects disallowed and oversized files before uploading', () => {
    const { scope, attachments, onReject } = setup()
    const big = new File(['x'], 'huge.png', { type: 'image/png' })
    Object.defineProperty(big, 'size', { value: LIMITS.uploadBytes + 1 })
    attachments.add([new File(['x'], 'movie.mp4', { type: 'video/mp4' }), big])
    expect(attachments.items.value).toEqual([])
    expect(api.files.upload).not.toHaveBeenCalled()
    expect(onReject.mock.calls.map(([rejection]) => rejection)).toEqual([
      { name: 'movie.mp4', reason: 'type' },
      { name: 'huge.png', reason: 'size' },
    ])
    scope.stop()
  })

  it('marks a failed upload for Retry and uploads again on retry', async () => {
    api.files.upload
      .mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'Could not reach the server.' }))
      .mockResolvedValueOnce(fileRef('c', 'a.txt'))
    const { scope, attachments } = setup()
    attachments.add([new File(['a'], 'a.txt', { type: 'text/plain' })])
    await flushPromises()
    expect(attachments.items.value[0]!.state).toBe('error')
    expect(attachments.failed.value).toBe(true)

    attachments.retry(attachments.items.value[0]!.id)
    expect(attachments.items.value[0]!.state).toBe('uploading')
    await flushPromises()
    expect(attachments.items.value[0]!.state).toBe('done')
    expect(attachments.failed.value).toBe(false)
    expect(api.files.upload).toHaveBeenCalledTimes(2)
    scope.stop()
  })

  it('drops files the server refuses and reports them', async () => {
    api.files.upload
      .mockRejectedValueOnce(new HarnessError({ code: 'payload_too_large', message: 'Too large.' }))
      .mockRejectedValueOnce(new HarnessError({ code: 'validation_error', message: 'The content does not match the type.' }))
    const { scope, attachments, onReject } = setup()
    attachments.add([new File(['a'], 'a.png', { type: 'image/png' }), new File(['b'], 'b.pdf', { type: 'application/pdf' })])
    await flushPromises()
    expect(attachments.items.value).toEqual([])
    expect(onReject.mock.calls.map(([rejection]) => rejection)).toEqual([
      { name: 'a.png', reason: 'size', message: 'Too large.' },
      { name: 'b.pdf', reason: 'server', message: 'The content does not match the type.' },
    ])
    scope.stop()
  })

  it('aborts an upload when its chip is removed', async () => {
    const upload = deferred<FileRef>()
    api.files.upload.mockReturnValueOnce(upload.promise)
    const { scope, attachments } = setup()
    attachments.add([new File(['a'], 'a.txt', { type: 'text/plain' })])
    const [input] = api.files.upload.mock.calls[0]!
    attachments.remove(attachments.items.value[0]!.id)
    expect((input.signal as AbortSignal).aborted).toBe(true)
    expect(attachments.items.value).toEqual([])
    upload.resolve(fileRef('d', 'a.txt'))
    await flushPromises()
    expect(attachments.items.value).toEqual([])
    scope.stop()
  })

  it('settles once every upload finished', async () => {
    const first = deferred<FileRef>()
    const second = deferred<FileRef>()
    api.files.upload.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const { scope, attachments } = setup()
    attachments.add([new File(['a'], 'a.txt', { type: 'text/plain' }), new File(['b'], 'b.txt', { type: 'text/plain' })])
    let settled = false
    void attachments.settled().then(() => {
      settled = true
    })
    first.resolve(fileRef('e', 'a.txt'))
    await flushPromises()
    expect(settled).toBe(false)
    second.resolve(fileRef('f', 'b.txt'))
    await flushPromises()
    expect(settled).toBe(true)
    expect(attachments.fileRefs.value.map(ref => ref.name)).toEqual(['a.txt', 'b.txt'])
    scope.stop()
  })

  it('previews images with a blob URL and revokes it on clear', async () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview-1')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    api.files.upload.mockResolvedValue(fileRef('g', 'shot.png', 'image/png'))
    const { scope, attachments } = setup()
    attachments.add([new File(['png'], 'shot.png', { type: 'image/png' })])
    expect(create).toHaveBeenCalledTimes(1)
    expect(attachments.items.value[0]!.previewUrl).toBe('blob:preview-1')
    await flushPromises()
    attachments.clear()
    expect(revoke).toHaveBeenCalledWith('blob:preview-1')
    expect(attachments.items.value).toEqual([])
    scope.stop()
  })

  describe('project files (Phase 9)', () => {
    it('attaches a picked project file as a project chip: uploading, then done with the stored type and size', async () => {
      const attach = deferred<FileRef>()
      api.projectFiles.attach.mockReturnValueOnce(attach.promise)
      const { scope, attachments } = setup()
      const chip = attachments.addProject(projectId(1), 'src/parser.ts')
      expect(chip).toMatchObject({ source: 'project', path: 'src/parser.ts', projectId: projectId(1), name: 'parser.ts', state: 'uploading' })
      expect(chip.file).toBeUndefined()
      expect(attachments.uploading.value).toBe(true)
      const [input] = api.projectFiles.attach.mock.calls[0]!
      expect(input).toMatchObject({ params: { id: projectId(1) }, body: { path: 'src/parser.ts' } })
      expect(input.signal).toBeInstanceOf(AbortSignal)
      expect(api.files.upload).not.toHaveBeenCalled()

      attach.resolve({ ...fileRef('p', 'parser.ts', 'text/plain'), size: 512 })
      await flushPromises()
      expect(attachments.items.value[0]).toMatchObject({ state: 'done', mime: 'text/plain', size: 512, source: 'project' })
      expect(attachments.fileRefs.value.map(ref => ref.name)).toEqual(['parser.ts'])
      scope.stop()
    })

    it('attaches the same path once (a failed chip is retried instead)', async () => {
      api.projectFiles.attach
        .mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'Could not reach the server.' }))
        .mockResolvedValueOnce(fileRef('q', 'parser.ts'))
      const { scope, attachments } = setup()
      const first = attachments.addProject(projectId(1), 'src/parser.ts')
      await flushPromises()
      expect(attachments.items.value[0]!.state).toBe('error')

      const again = attachments.addProject(projectId(1), 'src/parser.ts')
      expect(again.id).toBe(first.id)
      expect(attachments.items.value).toHaveLength(1)
      await flushPromises()
      expect(attachments.items.value[0]!.state).toBe('done')
      expect(api.projectFiles.attach).toHaveBeenCalledTimes(2)

      attachments.addProject(projectId(1), 'src/parser.ts')
      expect(api.projectFiles.attach).toHaveBeenCalledTimes(2)
      attachments.addProject(projectId(1), 'src/lexer.ts')
      expect(attachments.items.value.map(item => item.path)).toEqual(['src/parser.ts', 'src/lexer.ts'])
      await flushPromises()
      scope.stop()
    })

    it('drops a project file the server refuses and reports it with its path and error', async () => {
      const tooLarge = new HarnessError({ code: 'payload_too_large', message: 'Files are limited to 5 MB.' })
      const missing = new HarnessError({ code: 'not_found', message: 'File not found.' })
      const refused = new HarnessError({ code: 'validation_error', message: 'path: The path is a .git path.' })
      api.projectFiles.attach.mockRejectedValueOnce(tooLarge).mockRejectedValueOnce(missing).mockRejectedValueOnce(refused)
      const { scope, attachments, onReject } = setup()
      attachments.addProject(projectId(1), 'big.log')
      attachments.addProject(projectId(1), 'gone.ts')
      attachments.addProject(projectId(1), '.git/config')
      await flushPromises()
      expect(attachments.items.value).toEqual([])
      expect(onReject.mock.calls.map(([rejection]) => rejection)).toEqual([
        { name: 'big.log', reason: 'size', message: tooLarge.message, source: 'project', path: 'big.log', error: tooLarge },
        { name: 'gone.ts', reason: 'server', message: missing.message, source: 'project', path: 'gone.ts', error: missing },
        { name: '.git/config', reason: 'server', message: refused.message, source: 'project', path: '.git/config', error: refused },
      ])
      scope.stop()
    })

    it('aborts a project attach when its chip is removed', async () => {
      const attach = deferred<FileRef>()
      api.projectFiles.attach.mockReturnValueOnce(attach.promise)
      const { scope, attachments } = setup()
      const chip = attachments.addProject(projectId(1), 'src/parser.ts')
      const [input] = api.projectFiles.attach.mock.calls[0]!
      attachments.remove(chip.id)
      expect((input.signal as AbortSignal).aborted).toBe(true)
      attach.resolve(fileRef('r', 'parser.ts'))
      await flushPromises()
      expect(attachments.items.value).toEqual([])
      scope.stop()
    })

    it('addRefs restores uploaded files as done chips, once each', async () => {
      const create = vi.spyOn(URL, 'createObjectURL')
      const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
      const { scope, attachments } = setup()
      const notes = fileRef('s', 'notes.md', 'text/markdown')
      const shot = fileRef('t', 'shot.png', 'image/png')
      const added = attachments.addRefs([notes, shot, notes])
      expect(added).toHaveLength(2)
      expect(attachments.items.value).toMatchObject([
        { source: 'upload', name: 'notes.md', state: 'done', ref: notes },
        { source: 'upload', name: 'shot.png', state: 'done', ref: shot, previewUrl: shot.url },
      ])
      expect(attachments.items.value[0]!.file).toBeUndefined()
      expect(attachments.uploading.value).toBe(false)
      expect(attachments.fileRefs.value).toEqual([notes, shot])
      expect(attachments.addRefs([shot])).toEqual([])
      expect(api.files.upload).not.toHaveBeenCalled()
      expect(create).not.toHaveBeenCalled()
      attachments.clear()
      // The server URL is not a blob URL.
      expect(revoke).not.toHaveBeenCalled()
      await flushPromises()
      scope.stop()
    })
  })

  describe('mCP resources (Phase 14)', () => {
    const readme = { serverId: 'github', uri: 'repo://owner/name/README.md', name: 'README.md', serverName: 'GitHub', mime: 'text/markdown' }

    it('addResource adds the chip of an attached resource once', () => {
      const { scope, attachments } = setup()
      const ref = fileRef('r', 'README.md', 'text/markdown')
      attachments.addResource(ref)
      attachments.addResource(ref)
      expect(attachments.items.value).toMatchObject([{ source: 'upload', name: 'README.md', state: 'done', ref }])
      expect(attachments.fileRefs.value).toEqual([ref])
      scope.stop()
    })

    it('attachResource shows the upload state while the server reads it, then the stored file', async () => {
      const read = deferred<FileRef>()
      const attach = vi.fn((_signal: AbortSignal) => read.promise)
      const { scope, attachments } = setup()
      const chip = attachments.attachResource(readme, attach)
      expect(chip).toMatchObject({ source: 'resource', serverId: 'github', uri: readme.uri, name: 'README.md', mime: 'text/markdown', state: 'uploading' })
      expect(attachments.uploading.value).toBe(true)
      expect(attach).toHaveBeenCalledTimes(1)
      expect(attach.mock.calls[0]![0]).toBeInstanceOf(AbortSignal)
      const settled = vi.fn()
      void attachments.settled().then(settled)
      await flushPromises()
      expect(settled).not.toHaveBeenCalled()

      const image = fileRef('i', 'diagram.png', 'image/png')
      read.resolve({ ...image, name: 'README.md' })
      await flushPromises()
      expect(settled).toHaveBeenCalled()
      expect(attachments.items.value[0]).toMatchObject({ state: 'done', mime: 'image/png', size: 5, previewUrl: image.url })
      expect(attachments.fileRefs.value).toEqual([{ ...image, name: 'README.md' }])
      scope.stop()
    })

    it('attaches the same server and URI once; a failed chip is retried, also with Retry', async () => {
      const attach = vi.fn<(signal: AbortSignal) => Promise<FileRef>>()
        .mockRejectedValueOnce(new HarnessError({ code: 'provider_unreachable', message: 'The MCP server is not connected.' }))
        .mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'Could not reach the server.' }))
        .mockResolvedValue(fileRef('r', 'README.md'))
      const { scope, attachments, onReject } = setup()
      const first = attachments.attachResource(readme, attach)
      await flushPromises()
      expect(attachments.items.value[0]).toMatchObject({ id: first.id, state: 'error' })
      expect(attachments.failed.value).toBe(true)
      expect(onReject).not.toHaveBeenCalled()

      const again = attachments.attachResource(readme, attach)
      expect(again.id).toBe(first.id)
      await flushPromises()
      expect(attachments.items.value[0]!.state).toBe('error')
      attachments.retry(first.id)
      await flushPromises()
      expect(attachments.items.value).toHaveLength(1)
      expect(attachments.items.value[0]!.state).toBe('done')
      expect(attach).toHaveBeenCalledTimes(3)
      // A done chip of that resource is returned as it is.
      expect(attachments.attachResource(readme, attach).state).toBe('done')
      expect(attach).toHaveBeenCalledTimes(3)
      scope.stop()
    })

    it('drops a resource the server refuses (413, 409 needs-auth, 404, 400) and reports it with the server and error', async () => {
      const errors = [
        new HarnessError({ code: 'payload_too_large', message: 'Too large.', details: { limitBytes: LIMITS.mcpResourceReadBytes } }),
        new HarnessError({ code: 'conflict', message: 'Sign in first.', details: { reason: 'needs-auth' } }),
        new HarnessError({ code: 'not_found', message: 'Unknown resource.' }),
        new HarnessError({ code: 'validation_error', message: 'Unsupported binary type.' }),
      ]
      const { scope, attachments, onReject } = setup()
      for (const [index, error] of errors.entries())
        attachments.attachResource({ ...readme, uri: `repo://owner/name/${index}` }, async () => Promise.reject(error))
      await flushPromises()
      expect(attachments.items.value).toEqual([])
      expect(onReject.mock.calls.map(([info]) => [info.source, info.name, info.reason, info.serverName, info.error?.code])).toEqual([
        ['resource', 'README.md', 'size', 'GitHub', 'payload_too_large'],
        ['resource', 'README.md', 'server', 'GitHub', 'conflict'],
        ['resource', 'README.md', 'server', 'GitHub', 'not_found'],
        ['resource', 'README.md', 'server', 'GitHub', 'validation_error'],
      ])
      scope.stop()
    })

    it('a removed chip ignores its answer', async () => {
      const read = deferred<FileRef>()
      let signal: AbortSignal | null = null
      const { scope, attachments } = setup()
      const chip = attachments.attachResource(readme, (abort) => {
        signal = abort
        return read.promise
      })
      attachments.remove(chip.id)
      expect(signal!.aborted).toBe(true)
      read.resolve(fileRef('r', 'README.md'))
      await flushPromises()
      expect(attachments.items.value).toEqual([])
      expect(attachments.uploading.value).toBe(false)
      scope.stop()
    })
  })
})
