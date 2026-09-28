import { beforeEach, describe, expect, it, vi } from 'vitest'
import { attachmentRejectionText, toastAttachmentRejection } from './attachment-toasts'

const mock = vi.hoisted(() => ({ error: vi.fn() }))
vi.mock('vue-sonner', () => ({ toast: { error: (...args: unknown[]) => mock.error(...args) } }))

beforeEach(() => {
  mock.error.mockReset()
})

describe('attachment toasts', () => {
  it('uses the composer texts for each reason', () => {
    expect(attachmentRejectionText({ name: 'huge.png', reason: 'size' }))
      .toEqual({ title: 'huge.png is too large', description: 'Files can be up to 20 MB.' })
    expect(attachmentRejectionText({ name: 'app.exe', reason: 'type' }))
      .toEqual({ title: 'app.exe can\'t be attached', description: 'Attach images, PDFs or text files.' })
    expect(attachmentRejectionText({ name: 'notes.txt', reason: 'server', message: 'The file is not valid UTF-8 text.' }))
      .toEqual({ title: 'notes.txt can\'t be attached', description: 'The file is not valid UTF-8 text.' })
    expect(attachmentRejectionText({ name: 'notes.txt', reason: 'server' })).toEqual({ title: 'notes.txt can\'t be attached' })
  })

  it('shows an error toast', () => {
    toastAttachmentRejection({ name: 'huge.png', reason: 'size' })
    toastAttachmentRejection({ name: 'notes.txt', reason: 'server' })
    expect(mock.error.mock.calls).toEqual([
      ['huge.png is too large', { description: 'Files can be up to 20 MB.' }],
      ['notes.txt can\'t be attached'],
    ])
  })
})
