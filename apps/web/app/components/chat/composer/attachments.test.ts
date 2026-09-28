import { LIMITS } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { catalogModel } from '~/utils/testing/fixtures'
import { capabilityWarnings, checkAttachment, COMPOSER_ACCEPT, uploadMimeOf } from './attachments'

describe('attachment validation', () => {
  it('keeps the MIME types the server accepts', () => {
    expect(uploadMimeOf({ name: 'shot.png', type: 'image/png' })).toBe('image/png')
    expect(uploadMimeOf({ name: 'paper.pdf', type: 'application/pdf' })).toBe('application/pdf')
    expect(uploadMimeOf({ name: 'notes.md', type: 'text/markdown' })).toBe('text/markdown')
  })

  it('uploads known text extensions as text whatever the browser reported', () => {
    expect(uploadMimeOf({ name: 'index.ts', type: 'video/mp2t' })).toBe('text/plain')
    expect(uploadMimeOf({ name: 'data.json', type: 'application/json' })).toBe('text/plain')
    expect(uploadMimeOf({ name: 'README.MD', type: '' })).toBe('text/markdown')
    expect(uploadMimeOf({ name: 'table.csv', type: '' })).toBe('text/csv')
  })

  it('rejects other types', () => {
    expect(uploadMimeOf({ name: 'movie.mp4', type: 'video/mp4' })).toBeNull()
    expect(uploadMimeOf({ name: 'archive.zip', type: 'application/zip' })).toBeNull()
    expect(uploadMimeOf({ name: 'noextension', type: '' })).toBeNull()
    expect(checkAttachment({ name: 'movie.mp4', type: 'video/mp4', size: 10 })).toEqual({ ok: false, reason: 'type' })
  })

  it('rejects files above the upload limit', () => {
    expect(checkAttachment({ name: 'big.png', type: 'image/png', size: LIMITS.uploadBytes + 1 })).toEqual({ ok: false, reason: 'size' })
    expect(checkAttachment({ name: 'ok.png', type: 'image/png', size: LIMITS.uploadBytes })).toEqual({ ok: true, mime: 'image/png' })
  })

  it('lets the file picker offer the accepted families and text extensions', () => {
    expect(COMPOSER_ACCEPT.split(',')).toEqual(expect.arrayContaining(['image/*', 'application/pdf', 'text/*', '.md', '.ts', '.json']))
  })
})

describe('capability warnings', () => {
  const images = [{ mime: 'image/png' }]
  const pdfs = [{ mime: 'application/pdf' }]

  it('warns when the model cannot see images or read PDFs', () => {
    const haiku = catalogModel({ id: 'claude-haiku-5', name: 'Claude Haiku 5', capabilities: { tools: true, vision: false, pdf: false, reasoning: false, structuredOutput: true, imageOutput: false } })
    expect(capabilityWarnings([...images, ...pdfs], haiku)).toEqual([
      'Claude Haiku 5 can\'t see images. Remove them or choose another model.',
      'Claude Haiku 5 can\'t read PDFs. Remove them or choose another model.',
    ])
  })

  it('stays quiet for capable or unknown models and for text files', () => {
    const sonnet = catalogModel({ capabilities: { tools: true, vision: true, pdf: true, reasoning: true, structuredOutput: true, imageOutput: false } })
    expect(capabilityWarnings([...images, ...pdfs], sonnet)).toEqual([])
    expect(capabilityWarnings(images, undefined)).toEqual([])
    const textOnly = catalogModel({ capabilities: { tools: false, vision: false, pdf: false, reasoning: false, structuredOutput: false, imageOutput: false } })
    expect(capabilityWarnings([{ mime: 'text/plain' }], textOnly)).toEqual([])
  })
})
