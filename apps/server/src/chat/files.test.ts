import type { HarnessUIMessage } from '@harness-forge/shared'
import type { FilesService, StoredFile } from '../services/files/types.ts'
import { Buffer } from 'node:buffer'
import { HarnessError, LIMITS } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { createSilentLogger } from '../logger.ts'
import {
  assistantForModel,
  CARRIED_IMAGES_TEXT,
  carriedImages,
  fileTreatment,
  generatedFileText,
  INLINE_TEXT_MAX_CHARS,
  normalizeUserParts,
  prepareModelFiles,
  UNREADABLE_ATTACHMENTS_TEXT,
} from './files.ts'

const stored: Record<string, StoredFile & { data: Uint8Array }> = {
  file_img0000000000001: { id: 'file_img0000000000001', sha256: 'a'.repeat(64), name: 'cat.png', mime: 'image/png', size: 3, createdAt: 1, data: new Uint8Array([1, 2, 3]) },
  file_pdf0000000000001: { id: 'file_pdf0000000000001', sha256: 'b'.repeat(64), name: 'doc.pdf', mime: 'application/pdf', size: 3, createdAt: 1, data: new Uint8Array([4, 5, 6]) },
  file_txt0000000000001: { id: 'file_txt0000000000001', sha256: 'c'.repeat(64), name: 'notes.txt', mime: 'text/plain; charset=utf-8', size: 5, createdAt: 1, data: new TextEncoder().encode('hello') },
}

for (const n of [1, 2, 3, 4, 5]) {
  const id = `file_gen000000000000${n}`
  stored[id] = { id, sha256: String(n).repeat(64), name: `gen-${n}.png`, mime: 'image/png', size: 1, createdAt: 1, data: new Uint8Array([n]) }
}

function userText(id: string, text: string): HarnessUIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] }
}

/** A reply with generated images (stored files, named like `finalMessage` names them). */
function generatedReply(id: string, ...fileIds: string[]): HarnessUIMessage {
  return {
    id,
    role: 'assistant',
    parts: fileIds.map(fileId => ({ type: 'file' as const, mediaType: 'image/png', filename: stored[fileId]?.name ?? 'gone.png', url: `/api/files/${fileId}` })),
  }
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

  it('turns assistant files into text in place, drops reasoning files and never fetches other URLs', async () => {
    const assistant: HarnessUIMessage = {
      id: 'msg_a000000000000001',
      role: 'assistant',
      parts: [
        { type: 'reasoning-file', mediaType: 'image/png', url: '/api/files/file_img0000000000001' },
        { type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,AAAA' },
        { type: 'file', mediaType: 'image/png', filename: 'image-2.png', url: 'https://example.com/x.png' },
        { type: 'file', mediaType: 'application/pdf', filename: 'report.pdf', url: '/api/files/file_pdf0000000000001' },
        { type: 'text', text: 'drawn' },
      ],
    }
    for (const vision of [false, true]) {
      const result = await prepareModelFiles([assistant], { capabilities: { vision, pdf: true }, files, logger: createSilentLogger() })
      expect(result.messages[0]?.parts).toEqual([
        { type: 'text', text: '[Generated image: image]' },
        { type: 'text', text: '[Generated image: image-2.png]' },
        { type: 'text', text: '[Generated file: report.pdf]' },
        { type: 'text', text: 'drawn' },
      ])
    }
    // A message without files is passed through unchanged.
    const plain: HarnessUIMessage = { id: 'msg_a000000000000002', role: 'assistant', parts: [{ type: 'text', text: 'hi' }] }
    expect((await prepareModelFiles([plain], { capabilities: { vision: true, pdf: true }, files, logger: createSilentLogger() })).messages[0]).toBe(plain)
  })

  it('carries the latest generated images into the next user message for a vision model', async () => {
    const older = generatedReply('msg_a000000000000001', 'file_gen0000000000001')
    const latest = generatedReply('msg_a000000000000002', 'file_gen0000000000002', 'file_gen0000000000003')
    const history: HarnessUIMessage[] = [
      userText('msg_u000000000000001', 'draw a fox'),
      older,
      userText('msg_u000000000000002', 'now a cat'),
      latest,
      userText('msg_u000000000000003', 'make it blue'),
    ]
    const result = await prepareModelFiles(history, { capabilities: { vision: true, pdf: false }, files, logger: createSilentLogger(), noticeMessageId: 'msg_u000000000000003' })
    expect(result.dropped).toBe(0)
    const [firstUser, olderReply, secondUser, latestReply, lastUser] = result.messages
    expect(firstUser).toBe(history[0])
    expect(secondUser).toBe(history[2])
    // Every generated image becomes text in place: no assistant message reaches a provider empty.
    expect(olderReply?.parts).toEqual([{ type: 'text', text: '[Generated image: gen-1.png]' }])
    expect(latestReply?.parts).toEqual([{ type: 'text', text: '[Generated image: gen-2.png]' }, { type: 'text', text: '[Generated image: gen-3.png]' }])
    // The latest images travel as data URLs at the start of the next user message.
    expect(lastUser?.parts).toEqual([
      { type: 'text', text: CARRIED_IMAGES_TEXT },
      { type: 'file', mediaType: 'image/png', url: `data:image/png;base64,${Buffer.from([2]).toString('base64')}` },
      { type: 'file', mediaType: 'image/png', url: `data:image/png;base64,${Buffer.from([3]).toString('base64')}` },
      { type: 'text', text: 'make it blue' },
    ])
    expect(history[4]?.parts).toEqual([{ type: 'text', text: 'make it blue' }])
  })

  it('carries at most four images and only into the first user message after them', async () => {
    const ids = ['file_gen0000000000001', 'file_gen0000000000002', 'file_gen0000000000003', 'file_gen0000000000004', 'file_gen0000000000005']
    const history: HarnessUIMessage[] = [
      userText('msg_u000000000000001', 'five images'),
      generatedReply('msg_a000000000000001', ...ids),
      userText('msg_u000000000000002', 'next'),
      { id: 'msg_a000000000000002', role: 'assistant', parts: [{ type: 'text', text: 'ok' }] },
      userText('msg_u000000000000003', 'later'),
    ]
    const result = await prepareModelFiles(history, { capabilities: { vision: true, pdf: false }, files, logger: createSilentLogger() })
    const carried = result.messages[2]?.parts.filter(part => part.type === 'file') ?? []
    expect(carried).toHaveLength(LIMITS.imageInputsMax)
    // The latest four.
    expect(carried.map(part => (part.type === 'file' ? Buffer.from(part.url.split(',')[1] ?? '', 'base64')[0] : null))).toEqual([2, 3, 4, 5])
    expect(result.messages[4]?.parts).toEqual([{ type: 'text', text: 'later' }])
  })

  it('carries nothing for a model without vision, without a later user message, or when the files are gone', async () => {
    const reply = generatedReply('msg_a000000000000001', 'file_gen0000000000001')
    const history: HarnessUIMessage[] = [userText('msg_u000000000000001', 'draw'), reply, userText('msg_u000000000000002', 'again')]
    const blind = await prepareModelFiles(history, { capabilities: { vision: false, pdf: false }, files, logger: createSilentLogger() })
    expect(blind.messages[1]?.parts).toEqual([{ type: 'text', text: '[Generated image: gen-1.png]' }])
    expect(blind.messages[2]).toBe(history[2])
    // An approval continuation ends with the assistant message: no user message to carry the images into.
    const continued = await prepareModelFiles(history.slice(0, 2), { capabilities: { vision: true, pdf: false }, files, logger: createSilentLogger() })
    expect(continued.messages.map(message => message.parts)).toEqual([[{ type: 'text', text: 'draw' }], [{ type: 'text', text: '[Generated image: gen-1.png]' }]])
    const gone = generatedReply('msg_a000000000000001', 'file_missing0000000001')
    const missing = await prepareModelFiles([history[0]!, gone, history[2]!], { capabilities: { vision: true, pdf: false }, files, logger: createSilentLogger() })
    expect(missing.messages[2]?.parts).toEqual([{ type: 'text', text: 'again' }])
  })

  it('finds the most recent assistant message that has images, skipping later ones without', () => {
    const history: HarnessUIMessage[] = [
      userText('msg_u000000000000001', 'draw'),
      generatedReply('msg_a000000000000001', 'file_gen0000000000001'),
      userText('msg_u000000000000002', 'thanks'),
      { id: 'msg_a000000000000002', role: 'assistant', parts: [{ type: 'text', text: 'welcome' }] },
      userText('msg_u000000000000003', 'now blue'),
    ]
    expect(carriedImages(history)).toEqual({ parts: history[1]!.parts, toIndex: 2 })
    expect(carriedImages(history.slice(0, 2))).toBeNull()
    expect(carriedImages([userText('msg_u000000000000001', 'x')])).toBeNull()
    expect(generatedFileText({ mediaType: 'image/webp', filename: ' pic.webp ' })).toBe('[Generated image: pic.webp]')
    expect(generatedFileText({ mediaType: 'text/plain' })).toBe('[Generated file: file]')
    expect(assistantForModel(history[3]!)).toBe(history[3])
  })

  it('caps inlined text files', async () => {
    stored.file_big0000000000001 = { ...stored.file_txt0000000000001!, id: 'file_big0000000000001', data: new TextEncoder().encode('z'.repeat(INLINE_TEXT_MAX_CHARS + 10)) }
    const result = await prepareModelFiles([userWith('msg_u000000000000001', 'file_big0000000000001')], { capabilities: { vision: false, pdf: false }, files, logger: createSilentLogger() })
    const text = result.messages[0]?.parts[0]
    expect(text?.type === 'text' ? text.text.endsWith('\n[truncated]') : false).toBe(true)
  })
})
