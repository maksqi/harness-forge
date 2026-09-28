import type { HarnessUIMessage, HarnessUIMessagePart, MessageMetadata } from '@harness-forge/shared'
import type { FilesService, GeneratedFileInput, StoredFile } from '../services/files/types.ts'
import type { HarnessUIMessageChunk, StoreGeneratedFilesOptions } from './generated-files.ts'
import { Buffer } from 'node:buffer'
import { GENERATE_IMAGE_TOOL_NAME, HarnessError, LIMITS } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { createSilentLogger } from '../logger.ts'
import {
  base64ByteLength,
  canonicalMediaType,
  GeneratedFiles,
  IMAGE_TOOL_PLUGIN_ID,
  isDataUrl,
  isGeneratedImageType,
  parseDataUrl,
  storeGeneratedFiles,
  toolNamesOf,
} from './generated-files.ts'
import { NOTICES } from './notices.ts'

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3])

function dataUrl(mediaType: string, bytes: Uint8Array): string {
  return `data:${mediaType};base64,${Buffer.from(bytes).toString('base64')}`
}

/** `saveGenerated` / `get` in memory: refuses what `refuse` names; ids `file_gen<n>` (16 characters after `file_`). */
function fakeFiles(refuse: (input: GeneratedFileInput) => HarnessError | null = () => null) {
  const rows = new Map<string, StoredFile>()
  const saved: GeneratedFileInput[] = []
  let next = 0
  const files: Pick<FilesService, 'saveGenerated' | 'get'> = {
    saveGenerated: async (input) => {
      saved.push(input)
      const refusal = refuse(input)
      if (refusal !== null)
        throw refusal
      next += 1
      const id = `file_gen${String(next).padStart(13, '0')}`
      const row: StoredFile = { id, sha256: String(next).repeat(64), name: input.name, mime: input.mediaType, size: input.data.byteLength, createdAt: 1 }
      rows.set(id, row)
      return row
    },
    get: async id => rows.get(id) ?? null,
  }
  return { files, rows, saved }
}

async function run(chunks: HarnessUIMessageChunk[], options: Partial<StoreGeneratedFilesOptions> & Pick<StoreGeneratedFilesOptions, 'files'>): Promise<HarnessUIMessageChunk[]> {
  const transform = storeGeneratedFiles({
    generated: new GeneratedFiles(),
    logger: createSilentLogger(),
    toolOwner: () => undefined,
    ...options,
  })
  const input = new ReadableStream<HarnessUIMessageChunk>({
    start(controller) {
      for (const chunk of chunks)
        controller.enqueue(chunk)
      controller.close()
    },
  })
  const out: HarnessUIMessageChunk[] = []
  const reader = input.pipeThrough(transform).getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done)
      return out
    out.push(value)
  }
}

/** Every URL in the chunks (a streamed `data:` URL would fail the no-base64 rule). */
function urls(chunks: readonly HarnessUIMessageChunk[]): string[] {
  return chunks.flatMap(chunk => ('url' in chunk && typeof chunk.url === 'string' ? [chunk.url] : []))
}

describe('data URL helpers', () => {
  it('parses base64 data URLs only and canonicalizes the media type', () => {
    expect(parseDataUrl('data:Image/PNG;base64,AAAA')).toEqual({ mediaType: 'image/png', base64: 'AAAA' })
    expect(parseDataUrl('DATA:image/jpg;name=x;base64,QQ==')).toEqual({ mediaType: 'image/jpeg', base64: 'QQ==' })
    expect(parseDataUrl('data:text/plain,hello')).toBeNull()
    expect(parseDataUrl('data:image/png;base64')).toBeNull()
    expect(parseDataUrl('https://example.com/a.png')).toBeNull()
    expect(isDataUrl('data:,x')).toBe(true)
    expect(isDataUrl('/api/files/file_0000000000000000')).toBe(false)
    expect(isDataUrl(undefined)).toBe(false)
  })

  it('computes the decoded size without decoding and knows the stored raster types', () => {
    expect(base64ByteLength(Buffer.from('hello').toString('base64'))).toBe(5)
    expect(base64ByteLength(Buffer.from('hell').toString('base64'))).toBe(4)
    expect(base64ByteLength('')).toBe(0)
    expect(canonicalMediaType(' image/WEBP ; q=1')).toBe('image/webp')
    for (const type of ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'])
      expect(isGeneratedImageType(type)).toBe(true)
    for (const type of ['image/svg+xml', 'image/avif', 'application/pdf', 'text/plain', ''])
      expect(isGeneratedImageType(type)).toBe(false)
  })
})

describe('generatedFiles', () => {
  it('names new images and adds the name of stored files to the saved parts', () => {
    const generated = new GeneratedFiles()
    expect(generated.nextName('image/png')).toBe('image-1.png')
    expect(generated.nextName('image/jpeg')).toBe('image-2.jpg')
    expect(generated.nextName('image/webp;x=y')).toBe('image-3.webp')
    expect(new GeneratedFiles(2).nextName('image/gif')).toBe('image-3.gif')
    const url = generated.add({ id: 'file_gen0000000000001', name: 'fox.png' })
    expect(url).toBe('/api/files/file_gen0000000000001')
    expect(generated.nameOf(url)).toBe('fox.png')
    const parts: HarnessUIMessagePart[] = [
      { type: 'text', text: 'here' },
      { type: 'file', mediaType: 'image/png', url },
      { type: 'file', mediaType: 'image/png', url, filename: 'kept.png' },
      { type: 'file', mediaType: 'image/png', url: '/api/files/file_other00000000001' },
      { type: 'reasoning-file', mediaType: 'image/png', url },
      { type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,AAAA' },
      { type: 'reasoning-file', mediaType: 'image/png', url: 'DATA:image/png;base64,AAAA' },
    ]
    expect(generated.finalizeParts(parts)).toEqual([
      { type: 'text', text: 'here' },
      { type: 'file', mediaType: 'image/png', url, filename: 'fox.png' },
      { type: 'file', mediaType: 'image/png', url, filename: 'kept.png' },
      { type: 'file', mediaType: 'image/png', url: '/api/files/file_other00000000001' },
      { type: 'reasoning-file', mediaType: 'image/png', url },
    ])
  })

  it('reads the tool names of a continued message', () => {
    const message = {
      id: 'msg_a000000000000001',
      role: 'assistant',
      parts: [
        { type: 'step-start' },
        { type: `tool-${GENERATE_IMAGE_TOOL_NAME}`, toolCallId: 'call_1', state: 'approval-responded', input: {} },
        { type: 'dynamic-tool', toolName: 'mcp__demo__lookup', toolCallId: 'call_2', state: 'output-available', input: {}, output: {} },
        { type: 'text', text: 'x' },
      ],
    } as unknown as HarnessUIMessage
    expect([...toolNamesOf(message)]).toEqual([['call_1', GENERATE_IMAGE_TOOL_NAME], ['call_2', 'mcp__demo__lookup']])
    expect(toolNamesOf(null).size).toBe(0)
  })
})

describe('storeGeneratedFiles: generated files', () => {
  it('stores a raster data URL file and re-sends it with its stored URL, keeping the provider metadata', async () => {
    const { files, saved } = fakeFiles()
    const generated = new GeneratedFiles()
    const providerMetadata = { google: { thoughtSignature: 'sig' } }
    const out = await run([
      { type: 'start' },
      { type: 'text-start', id: 't' },
      { type: 'file', mediaType: 'image/png', url: dataUrl('image/png', PNG_BYTES), providerMetadata },
      { type: 'reasoning-file', mediaType: 'image/png', url: dataUrl('image/png', PNG_BYTES) },
      { type: 'finish' },
    ], { files, generated })
    expect(out).toEqual([
      { type: 'start' },
      { type: 'text-start', id: 't' },
      { type: 'file', mediaType: 'image/png', url: '/api/files/file_gen0000000000001', providerMetadata },
      { type: 'reasoning-file', mediaType: 'image/png', url: '/api/files/file_gen0000000000002' },
      { type: 'finish' },
    ])
    expect(saved.map(input => ({ ...input, data: [...input.data] }))).toEqual([
      { data: [...PNG_BYTES], mediaType: 'image/png', name: 'image-1.png' },
      { data: [...PNG_BYTES], mediaType: 'image/png', name: 'image-2.png' },
    ])
    expect(generated.nameOf('/api/files/file_gen0000000000001')).toBe('image-1.png')
    expect(urls(out).some(isDataUrl)).toBe(false)
  })

  it('drops files that are not stored raster images with an inline notice, and never streams their data', async () => {
    const tooLarge = `data:image/png;base64,${'A'.repeat(Math.ceil((LIMITS.generatedImageBytes + 3) / 3) * 4)}`
    const refused = fakeFiles(input => (input.name === 'image-1.png' ? new HarnessError({ code: 'validation_error', message: 'bad bytes' }) : null))
    const out = await run([
      { type: 'file', mediaType: 'image/svg+xml', url: dataUrl('image/svg+xml', new TextEncoder().encode('<svg/>')) },
      { type: 'file', mediaType: 'application/pdf', url: dataUrl('application/pdf', new TextEncoder().encode('%PDF')) },
      { type: 'file', mediaType: 'image/png', url: tooLarge },
      { type: 'file', mediaType: 'image/png', url: 'https://example.com/generated.png' },
      { type: 'reasoning-file', mediaType: 'image/png', url: 'data:image/png,not-base64' },
      { type: 'file', mediaType: 'image/png', url: dataUrl('image/png', PNG_BYTES) },
      { type: 'file', mediaType: 'image/png', url: dataUrl('image/png', PNG_BYTES) },
    ], { files: refused.files })
    const notice = { type: 'data-notice', data: NOTICES.generatedFileDropped() }
    expect(out).toEqual([notice, notice, notice, notice, notice, notice, { type: 'file', mediaType: 'image/png', url: '/api/files/file_gen0000000000001' }])
    // Only the raster images within the size cap reach saveGenerated (the first is refused, the second stored).
    expect(refused.saved.map(input => input.name)).toEqual(['image-1.png', 'image-2.png'])
    expect(urls(out).some(isDataUrl)).toBe(false)
    expect(NOTICES.generatedFileDropped().message).toBe('A file the model generated was not kept: only PNG, JPEG, WebP and GIF images up to 20 MB are stored.')
    expect(NOTICES.generatedFileDropped(2).message).toBe('2 files the model generated were not kept: only PNG, JPEG, WebP and GIF images up to 20 MB are stored.')
  })

  it('survives a failing store: the file is dropped, other chunks pass', async () => {
    const files: Pick<FilesService, 'saveGenerated' | 'get'> = {
      saveGenerated: async () => {
        throw new Error('disk full')
      },
      get: async () => {
        throw new Error('database gone')
      },
    }
    const out = await run([
      { type: 'file', mediaType: 'image/png', url: dataUrl('image/png', PNG_BYTES) },
      { type: 'tool-input-available', toolCallId: 'call_1', toolName: GENERATE_IMAGE_TOOL_NAME, input: {} },
      { type: 'tool-output-available', toolCallId: 'call_1', output: { modelRef: 'mock:image', images: [{ fileId: 'file_gen0000000000001', url: '/api/files/file_gen0000000000001', mediaType: 'image/png', name: 'image-1.png' }] } },
    ], { files, toolOwner: () => IMAGE_TOOL_PLUGIN_ID })
    expect(out.map(chunk => chunk.type)).toEqual(['data-notice', 'tool-input-available', 'tool-output-available'])
  })
})

describe('storeGeneratedFiles: generate_image', () => {
  function output(fileIds: string[], extra: Record<string, unknown> = {}): unknown {
    return {
      modelRef: 'mock:image',
      images: fileIds.map((fileId, index) => ({ fileId, url: `/api/files/${fileId}`, mediaType: 'image/png', name: `image-${index + 1}.png` })),
      ...extra,
    }
  }

  async function storedImages(count: number) {
    const store = fakeFiles()
    const ids: string[] = []
    for (let index = 0; index < count; index++)
      ids.push((await store.files.saveGenerated({ data: PNG_BYTES, mediaType: 'image/png', name: `image-${index + 1}.png` })).id)
    return { ...store, ids }
  }

  it('appends one file chunk per image after the final output of core-tools and adds the tool cost', async () => {
    const { files, ids } = await storedImages(2)
    const costs: number[] = []
    const generated = new GeneratedFiles()
    const out = await run([
      { type: 'tool-input-start', toolCallId: 'call_1', toolName: GENERATE_IMAGE_TOOL_NAME },
      { type: 'tool-input-available', toolCallId: 'call_1', toolName: GENERATE_IMAGE_TOOL_NAME, input: { prompt: 'fox' } },
      { type: 'tool-output-available', toolCallId: 'call_1', output: output(ids), preliminary: true },
      { type: 'tool-output-available', toolCallId: 'call_1', output: output(ids, { costUsd: 0.04 }) },
      { type: 'text-start', id: 't' },
    ], { files, generated, toolOwner: name => (name === GENERATE_IMAGE_TOOL_NAME ? IMAGE_TOOL_PLUGIN_ID : undefined), onToolCost: usd => costs.push(usd) })
    expect(out.map(chunk => chunk.type)).toEqual(['tool-input-start', 'tool-input-available', 'tool-output-available', 'tool-output-available', 'file', 'file', 'text-start'])
    expect(out.slice(4, 6)).toEqual(ids.map(id => ({ type: 'file', url: `/api/files/${id}`, mediaType: 'image/png' })))
    expect(generated.nameOf(`/api/files/${ids[1]}`)).toBe('image-2.png')
    expect(costs).toEqual([0.04])
  })

  it('never adds files for another plugin\'s tool, a dynamic tool, another tool or an invalid output', async () => {
    const { files, ids } = await storedImages(1)
    const costs: number[] = []
    const chunks: HarnessUIMessageChunk[] = [
      { type: 'tool-input-available', toolCallId: 'call_1', toolName: GENERATE_IMAGE_TOOL_NAME, input: {} },
      { type: 'tool-output-available', toolCallId: 'call_1', output: output(ids, { costUsd: 1 }) },
    ]
    const other = await run(chunks, { files, toolOwner: () => 'mock', onToolCost: usd => costs.push(usd) })
    expect(other.map(chunk => chunk.type)).toEqual(['tool-input-available', 'tool-output-available'])
    const coreTools = (): string => IMAGE_TOOL_PLUGIN_ID
    const dynamic = await run([chunks[0]!, { type: 'tool-output-available', toolCallId: 'call_1', output: output(ids), dynamic: true }], { files, toolOwner: coreTools })
    expect(dynamic.map(chunk => chunk.type)).not.toContain('file')
    const renamed = await run([{ ...chunks[0]!, toolName: 'draw' } as HarnessUIMessageChunk, chunks[1]!], { files, toolOwner: coreTools })
    expect(renamed.map(chunk => chunk.type)).not.toContain('file')
    const unknownCall = await run([chunks[1]!], { files, toolOwner: coreTools })
    expect(unknownCall.map(chunk => chunk.type)).toEqual(['tool-output-available'])
    for (const invalid of [{ truncated: true, originalBytes: 1, preview: '' }, { modelRef: 'mock:image', images: [] }, 'text', null]) {
      const out = await run([chunks[0]!, { type: 'tool-output-available', toolCallId: 'call_1', output: invalid }], { files, toolOwner: coreTools })
      expect(out.map(chunk => chunk.type)).toEqual(['tool-input-available', 'tool-output-available'])
    }
    expect(costs).toEqual([])
  })

  it('checks that every URL names its file and that the file is a stored image', async () => {
    const { files, ids, rows } = await storedImages(3)
    rows.set(ids[2]!, { ...rows.get(ids[2]!)!, mime: 'application/pdf' })
    const mismatched = {
      modelRef: 'mock:image',
      images: [
        { fileId: ids[0], url: `/api/files/${ids[1]}`, mediaType: 'image/png', name: 'a.png' },
        { fileId: 'file_missing000000001', url: '/api/files/file_missing000000001', mediaType: 'image/png', name: 'b.png' },
        { fileId: ids[2], url: `/api/files/${ids[2]}`, mediaType: 'image/png', name: 'c.png' },
        { fileId: ids[1], url: `/api/files/${ids[1]}`, mediaType: 'image/png', name: 'd.png' },
      ],
    }
    const out = await run([
      { type: 'tool-input-available', toolCallId: 'call_1', toolName: GENERATE_IMAGE_TOOL_NAME, input: {} },
      { type: 'tool-output-available', toolCallId: 'call_1', output: mismatched },
    ], { files, toolOwner: () => IMAGE_TOOL_PLUGIN_ID })
    expect(out.filter(chunk => chunk.type === 'file')).toEqual([{ type: 'file', url: `/api/files/${ids[1]}`, mediaType: 'image/png' }])
  })

  it('knows the tool calls of a continued message (approval continuations)', async () => {
    const { files, ids } = await storedImages(1)
    const continued = {
      id: 'msg_a000000000000001',
      role: 'assistant',
      parts: [{ type: `tool-${GENERATE_IMAGE_TOOL_NAME}`, toolCallId: 'call_9', state: 'approval-responded', input: { prompt: 'fox' } }],
    } as unknown as HarnessUIMessage
    const out = await run([{ type: 'tool-output-available', toolCallId: 'call_9', output: output(ids) }], { files, continued, toolOwner: () => IMAGE_TOOL_PLUGIN_ID })
    expect(out.map(chunk => chunk.type)).toEqual(['tool-output-available', 'file'])
  })

  it('rewrites the finish metadata after every earlier chunk', async () => {
    const seen: (MessageMetadata | undefined)[] = []
    const out = await run([
      { type: 'finish', finishReason: 'stop', messageMetadata: { modelRef: 'mock:echo', startedAt: 1, costUsd: 1 } },
    ], {
      files: fakeFiles().files,
      finishMetadata: (metadata) => {
        seen.push(metadata)
        return metadata === undefined ? undefined : { ...metadata, costUsd: 2 }
      },
    })
    expect(seen).toEqual([{ modelRef: 'mock:echo', startedAt: 1, costUsd: 1 }])
    expect(out).toEqual([{ type: 'finish', finishReason: 'stop', messageMetadata: { modelRef: 'mock:echo', startedAt: 1, costUsd: 2 } }])
    const untouched = await run([{ type: 'finish' }], { files: fakeFiles().files, finishMetadata: () => undefined })
    expect(untouched).toEqual([{ type: 'finish' }])
  })
})
