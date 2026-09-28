import type { HarnessUIMessage } from '@harness-forge/shared'
import type { FilesService, StoredFile } from '../services/files/types.ts'
import { Buffer } from 'node:buffer'
import { HarnessError } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { createSilentLogger } from '../logger.ts'
import { fileTreatment, INLINE_TEXT_MAX_CHARS, normalizeUserParts, prepareModelFiles, UNREADABLE_ATTACHMENTS_TEXT } from './files.ts'

const stored: Record<string, StoredFile & { data: Uint8Array }> = {
  file_img0000000000001: { id: 'file_img0000000000001', sha256: 'a'.repeat(64), name: 'cat.png', mime: 'image/png', size: 3, createdAt: 1, data: new Uint8Array([1, 2, 3]) },
  file_pdf0000000000001: { id: 'file_pdf0000000000001', sha256: 'b'.repeat(64), name: 'doc.pdf', mime: 'application/pdf', size: 3, createdAt: 1, data: new Uint8Array([4, 5, 6]) },
  file_txt0000000000001: { id: 'file_txt0000000000001', sha256: 'c'.repeat(64), name: 'notes.txt', mime: 'text/plain; charset=utf-8', size: 5, createdAt: 1, data: new TextEncoder().encode('hello') },
}

const files: Pick<FilesService, 'idFromUrl' | 'get' | 'read'> = {
  idFromUrl: url => (url.startsWith('/api/files/') ? url.slice('/api/files/'.length) : null),
  get: async id => stored[id] ?? null,
  read: async (id) => {
    const file = stored[id]
    if (file === undefined)
      throw new HarnessError({ code: 'not_found', message: 'gone' })
    return { file, data: file.data }
  },
}

describe('normalizeUserParts', () => {
  it('keeps text parts and rewrites file parts from the stored row', async () => {
    const parts = await normalizeUserParts([
      { type: 'text', text: 'look', providerMetadata: { openai: { x: 1 } }, state: 'done' },
      { type: 'file', mediaType: 'image/gif', filename: 'client-name.gif', url: '/api/files/file_img0000000000001' },
    ], files)
    expect(parts).toEqual([
      { type: 'text', text: 'look' },
      { type: 'file', mediaType: 'image/png', filename: 'cat.png', url: '/api/files/file_img0000000000001' },
    ])
  })

  it.each([
    [[{ type: 'reasoning', text: 'x' }], 'User messages can only contain text and file parts.'],
    [[{ type: 'file', mediaType: 'image/png', url: 'https://example.com/cat.png' }], 'File parts must reference an uploaded file (/api/files/<id>).'],
    [[{ type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,AAAA' }], 'File parts must reference an uploaded file (/api/files/<id>).'],
    [[{ type: 'file', mediaType: 'image/png', url: '/api/files/file_missing0000000001' }], 'The file file_missing0000000001 does not exist.'],
    [[{ type: 'text', text: 42 }], 'Text parts need a text.'],
    [[], 'The message is empty.'],
  ])('rejects %j', async (parts, message) => {
    await expect(normalizeUserParts(parts, files)).rejects.toMatchObject({ code: 'validation_error', message })
  })
})

describe('fileTreatment', () => {
  it('sends images to vision models, PDFs to pdf models, inlines text for everyone', () => {
    expect(fileTreatment('image/png', { vision: true, pdf: false })).toBe('bytes')
    expect(fileTreatment('image/png', { vision: false, pdf: true })).toBe('drop')
    expect(fileTreatment('application/pdf', { vision: true, pdf: true })).toBe('bytes')
    expect(fileTreatment('application/pdf', { vision: true, pdf: false })).toBe('drop')
    expect(fileTreatment('text/markdown; charset=utf-8', { vision: false, pdf: false })).toBe('text')
    expect(fileTreatment('application/zip', { vision: true, pdf: true })).toBe('drop')
  })
})

function userWith(id: string, ...fileIds: string[]): HarnessUIMessage {
  return {
    id,
    role: 'user',
    parts: [...fileIds.map(fileId => ({ type: 'file' as const, mediaType: stored[fileId]?.mime ?? 'image/png', url: `/api/files/${fileId}` })), { type: 'text', text: 'see attached' }],
  }
}

describe('prepareModelFiles', () => {
  it('turns readable files into data URLs and text files into text, without changing the input', async () => {
    const history = [userWith('msg_u000000000000001', 'file_img0000000000001', 'file_pdf0000000000001', 'file_txt0000000000001')]
    const result = await prepareModelFiles(history, { capabilities: { vision: true, pdf: true }, files, logger: createSilentLogger(), noticeMessageId: 'msg_u000000000000001' })
    expect(result.dropped).toBe(0)
    expect(result.messages[0]?.parts).toEqual([
      { type: 'file', mediaType: 'image/png', url: `data:image/png;base64,${Buffer.from([1, 2, 3]).toString('base64')}` },
      { type: 'file', mediaType: 'application/pdf', url: `data:application/pdf;base64,${Buffer.from([4, 5, 6]).toString('base64')}` },
      { type: 'text', text: 'Attached file "notes.txt":\n\nhello' },
      { type: 'text', text: 'see attached' },
    ])
    expect(history[0]?.parts[0]).toMatchObject({ url: '/api/files/file_img0000000000001' })
  })

  it('leaves out unreadable files and counts them for the new message only', async () => {
    const history = [userWith('msg_u000000000000001', 'file_img0000000000001'), userWith('msg_u000000000000002', 'file_img0000000000001', 'file_missing0000000001')]
    const result = await prepareModelFiles(history, { capabilities: { vision: false, pdf: false }, files, logger: createSilentLogger(), noticeMessageId: 'msg_u000000000000002' })
    expect(result.dropped).toBe(2)
    expect(result.messages.map(message => message.parts)).toEqual([[{ type: 'text', text: 'see attached' }], [{ type: 'text', text: 'see attached' }]])
    const onlyFiles: HarnessUIMessage = { id: 'msg_u000000000000003', role: 'user', parts: [{ type: 'file', mediaType: 'image/png', url: '/api/files/file_img0000000000001' }] }
    const empty = await prepareModelFiles([onlyFiles], { capabilities: { vision: false, pdf: false }, files, logger: createSilentLogger() })
    expect(empty.messages[0]?.parts).toEqual([{ type: 'text', text: UNREADABLE_ATTACHMENTS_TEXT }])
  })

  it('keeps assistant data URL files and never fetches other URLs', async () => {
    const assistant: HarnessUIMessage = {
      id: 'msg_a000000000000001',
      role: 'assistant',
      parts: [
        { type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,AAAA' },
        { type: 'file', mediaType: 'image/png', url: 'https://example.com/x.png' },
        { type: 'text', text: 'drawn' },
      ],
    }
    const result = await prepareModelFiles([assistant], { capabilities: { vision: false, pdf: false }, files, logger: createSilentLogger() })
    expect(result.messages[0]?.parts).toEqual([assistant.parts[0], assistant.parts[2]])
  })

  it('caps inlined text files', async () => {
    stored.file_big0000000000001 = { ...stored.file_txt0000000000001!, id: 'file_big0000000000001', data: new TextEncoder().encode('z'.repeat(INLINE_TEXT_MAX_CHARS + 10)) }
    const result = await prepareModelFiles([userWith('msg_u000000000000001', 'file_big0000000000001')], { capabilities: { vision: false, pdf: false }, files, logger: createSilentLogger() })
    const text = result.messages[0]?.parts[0]
    expect(text?.type === 'text' ? text.text.endsWith('\n[truncated]') : false).toBe(true)
  })
})
