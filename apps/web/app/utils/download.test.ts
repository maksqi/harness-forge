import { afterEach, describe, expect, it, vi } from 'vitest'
import { downloadText, fileNameFromDisposition } from './download'

describe('fileNameFromDisposition', () => {
  it('prefers the UTF-8 extended parameter', () => {
    expect(fileNameFromDisposition('attachment; filename="plain.md"; filename*=UTF-8\'\'caf%C3%A9-2026.md')).toBe('café-2026.md')
  })

  it('reads quoted and bare names', () => {
    expect(fileNameFromDisposition('attachment; filename="refactor-auth-2026-09-28.json"')).toBe('refactor-auth-2026-09-28.json')
    expect(fileNameFromDisposition('attachment; filename=dice-roller-1.0.0.zip')).toBe('dice-roller-1.0.0.zip')
  })

  it('strips path separators, control characters and leading dots', () => {
    expect(fileNameFromDisposition('attachment; filename="../../etc/passwd"')).toBe('etcpasswd')
    expect(fileNameFromDisposition('attachment; filename*=UTF-8\'\'..%2F..%2Fx.md')).toBe('x.md')
    expect(fileNameFromDisposition('attachment; filename="a\u0007b.md"')).toBe('ab.md')
  })

  it('returns null without a usable name', () => {
    expect(fileNameFromDisposition(null)).toBeNull()
    expect(fileNameFromDisposition('inline')).toBeNull()
    expect(fileNameFromDisposition('attachment; filename="/"')).toBeNull()
  })
})

describe('downloadText', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    document.body.replaceChildren()
  })

  it('saves the text as a UTF-8 blob through a temporary link and releases the URL later', async () => {
    vi.useFakeTimers()
    const blobs: Blob[] = []
    const createObjectURL = vi.fn((blob: Blob) => {
      blobs.push(blob)
      return 'blob:hf/1'
    })
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', Object.assign(Object.create(URL), { createObjectURL, revokeObjectURL }))
    const clicked: Array<{ href: string, download: string, attached: boolean }> = []
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.href, download: this.download, attached: document.body.contains(this) })
    })

    downloadText('---\nname: reviewer\n---\nReview it.\n', 'reviewer.md', 'text/markdown')

    expect(clicked).toEqual([{ href: 'blob:hf/1', download: 'reviewer.md', attached: true }])
    expect(document.body.querySelector('a')).toBeNull()
    expect(blobs[0]?.type).toBe('text/markdown; charset=utf-8')
    expect(await blobs[0]?.text()).toBe('---\nname: reviewer\n---\nReview it.\n')
    expect(revokeObjectURL).not.toHaveBeenCalled()
    vi.advanceTimersByTime(30_000)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:hf/1')
    click.mockRestore()
  })

  it('cleans the file name and defaults the type to text/plain', async () => {
    const blobs: Blob[] = []
    const createObjectURL = (blob: Blob): string => {
      blobs.push(blob)
      return 'blob:hf/2'
    }
    vi.stubGlobal('URL', Object.assign(Object.create(URL), { createObjectURL, revokeObjectURL: vi.fn() }))
    const names: string[] = []
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download)
    })
    downloadText('x', '../notes/a.md')
    downloadText('y', '/')
    expect(names).toEqual(['notesa.md', 'download'])
    expect(blobs[0]?.type).toBe('text/plain; charset=utf-8')
    click.mockRestore()
  })
})
