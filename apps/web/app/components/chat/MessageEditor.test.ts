import type { FileRef } from '@harness-forge/shared'
import type { FileUIPart } from 'ai'
import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { COMPOSER_ACCEPT } from '~/components/chat/composer/attachments'
import { testIds } from '~/utils/testids'
import { createMockApi } from '~/utils/testing/mock-api'
import MessageEditor from './MessageEditor.vue'

const mock = vi.hoisted(() => ({ api: null as unknown, toastError: vi.fn() }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api, useApiFetch: () => vi.fn() }))
vi.mock('vue-sonner', () => ({ toast: Object.assign(vi.fn(), { error: (...args: unknown[]) => mock.toastError(...args) }) }))

const photo: FileUIPart = { type: 'file', mediaType: 'image/png', filename: 'photo.png', url: '/api/files/file_photo000000000001' }
const notes: FileUIPart = { type: 'file', mediaType: 'text/plain', filename: 'notes.txt', url: '/api/files/file_notes000000000001' }

function fileRef(label: string, name: string, mime: string): FileRef {
  const id = `file_${label.padEnd(16, '0')}`
  return { id, name, mime, size: 5, url: `/api/files/${id}` }
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

let api: MockApi
let pinia: ReturnType<typeof createPinia>

beforeEach(() => {
  api = createMockApi()
  mock.api = api
  mock.toastError.mockReset()
  pinia = createPinia()
  setActivePinia(pinia)
})

afterEach(() => {
  disposePinia(pinia)
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

function mountEditor(text: string, files: FileUIPart[]) {
  const saved: Array<[string, FileUIPart[]]> = []
  let canceled = 0
  const wrapper = mount(defineComponent({
    setup: () => () => h(TooltipProvider, null, {
      default: () => h(MessageEditor, {
        text,
        files,
        onSave: (value: string, parts: FileUIPart[]) => saved.push([value, parts]),
        onCancel: () => {
          canceled += 1
        },
      }),
    }),
  }), { attachTo: document.body })
  const chips = () => wrapper.findAll(`[data-testid="${testIds.messageEditAttachment}"]`)
  const save = () => wrapper.get<HTMLButtonElement>(`[data-testid="${testIds.messageEditSave}"]`)
  const input = () => wrapper.get<HTMLTextAreaElement>(`[data-testid="${testIds.messageEditInput}"]`)
  const fileInput = () => wrapper.get<HTMLInputElement>('[data-slot="message-edit-file-input"]')
  async function pick(...picked: File[]) {
    Object.defineProperty(fileInput().element, 'files', { value: picked, configurable: true })
    await fileInput().trigger('change')
  }
  return { wrapper, saved, canceled: () => canceled, chips, save, input, fileInput, pick }
}

describe('messageEditor: existing attachments', () => {
  it('shows the message\'s attachments as removable chips and sends the ones left', async () => {
    const editor = mountEditor('Look at these', [photo, notes])
    expect(editor.chips()).toHaveLength(2)
    expect(editor.chips().map(chip => chip.attributes('data-state'))).toEqual(['done', 'done'])
    // The image shows its thumbnail, the text file its name.
    expect(editor.chips()[0]!.find('img').attributes('src')).toBe(photo.url)
    expect(editor.chips()[1]!.text()).toContain('notes.txt')

    await editor.wrapper.get('[aria-label="Remove photo.png"]').trigger('click')
    expect(editor.chips()).toHaveLength(1)
    expect(document.activeElement).toBe(editor.input().element)
    await editor.save().trigger('click')
    await flushPromises()
    expect(editor.saved).toEqual([['Look at these', [notes]]])
  })

  it('sends files with no text, and nothing without text and files', async () => {
    const editor = mountEditor('Caption', [photo])
    await editor.input().setValue('   ')
    expect(editor.save().element.disabled).toBe(false)
    await editor.wrapper.get('[aria-label="Remove photo.png"]').trigger('click')
    expect(editor.save().element.disabled).toBe(true)
    await editor.input().trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(editor.saved).toEqual([])

    const filesOnly = mountEditor('', [photo])
    await filesOnly.save().trigger('click')
    await flushPromises()
    expect(filesOnly.saved).toEqual([['', [photo]]])
  })
})

describe('messageEditor: new attachments', () => {
  it('opens a file picker with the composer\'s accept list', async () => {
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})
    const editor = mountEditor('Hi', [])
    expect(editor.fileInput().attributes('accept')).toBe(COMPOSER_ACCEPT)
    expect(editor.fileInput().attributes('multiple')).toBeDefined()
    const attach = editor.wrapper.get(`[data-testid="${testIds.messageEditAttach}"]`)
    expect(attach.attributes('aria-label')).toBe('Attach files')
    await attach.trigger('click')
    expect(click).toHaveBeenCalledOnce()
  })

  it('uploads picked files at once and sends the kept files, then the new uploads', async () => {
    const upload = deferred<FileRef>()
    api.files.upload.mockReturnValueOnce(upload.promise)
    const editor = mountEditor('With a new file', [photo])
    await editor.pick(new File(['hello'], 'extra.md', { type: 'text/markdown' }))
    expect(api.files.upload).toHaveBeenCalledOnce()
    expect(editor.chips().map(chip => chip.attributes('data-state'))).toEqual(['done', 'uploading'])
    // Send waits for the upload.
    expect(editor.save().element.disabled).toBe(true)

    upload.resolve(fileRef('extra', 'extra.md', 'text/markdown'))
    await flushPromises()
    expect(editor.chips().map(chip => chip.attributes('data-state'))).toEqual(['done', 'done'])
    expect(editor.save().element.disabled).toBe(false)
    await editor.save().trigger('click')
    await flushPromises()
    expect(editor.saved).toEqual([['With a new file', [
      photo,
      { type: 'file', mediaType: 'text/markdown', filename: 'extra.md', url: '/api/files/file_extra00000000000' },
    ]]])
  })

  it('sends with Enter during an upload once the upload finished', async () => {
    const upload = deferred<FileRef>()
    api.files.upload.mockReturnValueOnce(upload.promise)
    const editor = mountEditor('Soon', [])
    await editor.pick(new File(['x'], 'later.txt', { type: 'text/plain' }))
    await editor.input().trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(editor.saved).toEqual([])
    upload.resolve(fileRef('later', 'later.txt', 'text/plain'))
    await flushPromises()
    expect(editor.saved).toHaveLength(1)
    expect(editor.saved[0]![1].map(part => part.filename)).toEqual(['later.txt'])
  })

  it('keeps Send disabled while an upload failed, until it is retried or removed', async () => {
    api.files.upload.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'Disk full' }))
    api.files.upload.mockResolvedValueOnce(fileRef('retry', 'retry.txt', 'text/plain'))
    const editor = mountEditor('Retry me', [])
    await editor.pick(new File(['x'], 'retry.txt', { type: 'text/plain' }))
    await flushPromises()
    expect(editor.chips()[0]!.attributes('data-state')).toBe('error')
    expect(editor.save().element.disabled).toBe(true)
    await editor.input().trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(editor.saved).toEqual([])

    const retry = editor.chips()[0]!.findAll('button').find(button => button.text() === 'Retry')!
    await retry.trigger('click')
    await flushPromises()
    expect(editor.chips()[0]!.attributes('data-state')).toBe('done')
    expect(editor.save().element.disabled).toBe(false)
  })

  it('adds pasted files, and pastes rich text as text', async () => {
    api.files.upload.mockResolvedValue(fileRef('pasted', 'pasted.png', 'image/png'))
    const editor = mountEditor('Pasting', [])
    const file = new File(['png'], 'pasted.png', { type: 'image/png' })
    const paste = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', { value: { types: ['Files'], items: [{ kind: 'file', getAsFile: () => file }] } })
    editor.input().element.dispatchEvent(paste)
    expect(paste.defaultPrevented).toBe(true)
    await flushPromises()
    expect(editor.chips()).toHaveLength(1)

    const rich = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(rich, 'clipboardData', {
      value: { types: ['text/plain', 'text/html', 'Files'], items: [{ kind: 'file', getAsFile: () => file }] },
    })
    editor.input().element.dispatchEvent(rich)
    expect(rich.defaultPrevented).toBe(false)
    expect(api.files.upload).toHaveBeenCalledOnce()
  })

  it('shows the composer\'s toasts for files that cannot be attached', async () => {
    const editor = mountEditor('Nope', [])
    await editor.pick(new File(['x'], 'movie.mp4', { type: 'video/mp4' }))
    expect(mock.toastError).toHaveBeenCalledWith('movie.mp4 can\'t be attached', { description: 'Attach images, PDFs or text files.' })
    expect(api.files.upload).not.toHaveBeenCalled()
    expect(editor.chips()).toHaveLength(0)
  })
})

describe('messageEditor: cancel', () => {
  it('cancel aborts the uploads in flight and drops a pending send', async () => {
    const upload = deferred<FileRef>()
    api.files.upload.mockReturnValueOnce(upload.promise)
    const editor = mountEditor('Never mind', [photo])
    await editor.pick(new File(['x'], 'slow.txt', { type: 'text/plain' }))
    const signal = (api.files.upload.mock.calls[0]![0] as { signal: AbortSignal }).signal
    await editor.input().trigger('keydown', { key: 'Enter' })
    await editor.wrapper.get(`[data-testid="${testIds.messageEditCancel}"]`).trigger('click')
    expect(signal.aborted).toBe(true)
    expect(editor.canceled()).toBe(1)
    upload.resolve(fileRef('slow', 'slow.txt', 'text/plain'))
    await flushPromises()
    expect(editor.saved).toEqual([])
  })

  it('esc cancels; unmounting aborts the uploads too', async () => {
    const upload = deferred<FileRef>()
    api.files.upload.mockReturnValueOnce(upload.promise)
    const editor = mountEditor('Esc', [])
    await editor.input().trigger('keydown', { key: 'Escape' })
    expect(editor.canceled()).toBe(1)

    const other = mountEditor('Unmount', [])
    await other.pick(new File(['x'], 'slow.txt', { type: 'text/plain' }))
    const signal = (api.files.upload.mock.calls[0]![0] as { signal: AbortSignal }).signal
    other.wrapper.unmount()
    await nextTick()
    expect(signal.aborted).toBe(true)
  })
})
