// The MCP resource cache and the attach mapping (W14.2-T4, T5; ADR-061): listing (paging, caps, URIs an attach accepts,
// normalized fields), `resources/read` (an unknown resource is `not_found`, timeout, abort), and `mcpResourceUpload`
// (text joined, `text/*` types, images and PDF, refused binaries, the 5 MiB cap). The client is a scripted double.
import type { MCPClient } from '@ai-sdk/mcp'
import type { McpCacheServer } from './prompts.ts'
import type { McpResourceContents } from './types.ts'
import { Buffer } from 'node:buffer'
import { MCPClientError } from '@ai-sdk/mcp'
import { LIMITS } from '@harness-forge/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { canonicalMimeType, createResourceCache, mcpResourceUpload, READ_TIMEOUT_MS, RESOURCE_NOT_FOUND_CODE, resourceFileName } from './resources.ts'

const SERVER: McpCacheServer = { key: 'prj_0123456789abcdef/fs', serverId: 'fs', serverName: 'Files', projectId: 'prj_0123456789abcdef' }
const PNG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).toString('base64')

afterEach(() => {
  vi.useRealTimers()
})

function resourceClient(pages: Record<string, { resources: unknown[], nextCursor?: string }>) {
  const listCalls: Array<string | undefined> = []
  const readCalls: Array<{ uri: string, signal: AbortSignal | undefined }> = []
  let readImpl: (uri: string, signal: AbortSignal | undefined) => Promise<unknown> = async uri => ({ contents: [{ uri, text: 'hello' }] })
  const client = {
    listResources: async (options: { params?: { cursor?: string } } = {}) => {
      listCalls.push(options.params?.cursor)
      return pages[options.params?.cursor ?? ''] ?? { resources: [] }
    },
    readResource: async (args: { uri: string, options?: { signal?: AbortSignal } }) => {
      readCalls.push({ uri: args.uri, signal: args.options?.signal })
      return readImpl(args.uri, args.options?.signal)
    },
  }
  return {
    client: client as unknown as MCPClient,
    listCalls,
    readCalls,
    setRead: (impl: typeof readImpl) => {
      readImpl = impl
    },
  }
}

describe('createResourceCache: listing', () => {
  it('lists the resources a mention can attach, normalized, first URI wins', async () => {
    const fake = resourceClient({
      '': { resources: [
        { uri: 'fixture://notes/readme.md', name: 'readme.md', title: 'Fixture\nnotes', description: 'A small note.', mimeType: 'Text/Markdown; charset=utf-8', size: 120 },
        { uri: 'fixture://notes/readme.md', name: 'duplicate' },
        { uri: 'no scheme', name: 'bad' },
        { uri: `x://${'a'.repeat(2100)}`, name: 'too long' },
        { uri: 'x://with space', name: 'blank' },
        { uri: 'file:///odd.bin', name: 'odd', mimeType: 'not a type', size: 1.5 },
        { name: 'no uri' },
        'nope',
      ], nextCursor: 'next' },
      'next': { resources: [{ uri: 'fixture://images/pixel.png', name: 'pixel.png', mimeType: 'image/png', size: -1 }] },
    })
    const list = await createResourceCache().list(SERVER, fake.client)
    expect(list).toEqual({
      truncated: false,
      items: [
        { serverId: 'fs', serverName: 'Files', uri: 'fixture://notes/readme.md', name: 'readme.md', title: 'Fixture notes', description: 'A small note.', mimeType: 'text/markdown', size: 120 },
        { serverId: 'fs', serverName: 'Files', uri: 'file:///odd.bin', name: 'odd', title: null, description: null, mimeType: null, size: null },
        { serverId: 'fs', serverName: 'Files', uri: 'fixture://images/pixel.png', name: 'pixel.png', title: null, description: null, mimeType: 'image/png', size: null },
      ],
    })
    expect(fake.listCalls).toEqual([undefined, 'next'])
  })

  it('caps a listing at LIMITS.mcpResourcesMax (truncated)', async () => {
    const resources = Array.from({ length: LIMITS.mcpResourcesMax + 1 }, (_, index) => ({ uri: `x://r/${index}`, name: `r${index}` }))
    const list = await createResourceCache().list(SERVER, resourceClient({ '': { resources } }).client)
    expect(list.items).toHaveLength(LIMITS.mcpResourcesMax)
    expect(list.truncated).toBe(true)
  })
})

describe('createResourceCache: read', () => {
  it('reads a resource with the signal and maps an unknown resource to not_found', async () => {
    const cache = createResourceCache()
    const fake = resourceClient({})
    expect(await cache.read(SERVER, fake.client, 'fixture://notes/readme.md', new AbortController().signal)).toEqual({ contents: [{ uri: 'fixture://notes/readme.md', text: 'hello' }] })
    expect(fake.readCalls).toEqual([{ uri: 'fixture://notes/readme.md', signal: undefined }])
    fake.setRead(async () => {
      throw new MCPClientError({ message: 'Resource not found', code: RESOURCE_NOT_FOUND_CODE })
    })
    await expect(cache.read(SERVER, fake.client, 'fixture://missing', new AbortController().signal)).rejects.toMatchObject({ code: 'not_found', message: 'The MCP server "Files" has no such resource.' })
    fake.setRead(async () => {
      throw new MCPClientError({ message: 'Method not found', code: -32601 })
    })
    await expect(cache.read(SERVER, fake.client, 'x://a', new AbortController().signal)).rejects.toThrow('Method not found')
  })

  it('times out as provider_error and rejects with the abort reason', async () => {
    const cache = createResourceCache()
    const fake = resourceClient({})
    fake.setRead(() => new Promise(() => {}))
    const controller = new AbortController()
    const aborted = cache.read(SERVER, fake.client, 'x://a', controller.signal)
    controller.abort(new Error('stopped'))
    await expect(aborted).rejects.toThrow('stopped')
    vi.useFakeTimers()
    const slow = cache.read(SERVER, fake.client, 'x://a', new AbortController().signal)
    const outcome = expect(slow).rejects.toMatchObject({ code: 'provider_error', message: 'The MCP server "Files" did not answer within 60 s.' })
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS)
    await outcome
  })
})

function contentsOf(...contents: unknown[]): McpResourceContents {
  return { contents } as unknown as McpResourceContents
}

describe('mcpResourceUpload', () => {
  it('stores text as the server\'s text type or text/plain, several contents joined', () => {
    const one = mcpResourceUpload(contentsOf({ uri: 'fixture://notes/readme.md', mimeType: 'text/markdown', text: '# Notes' }), { uri: 'fixture://notes/readme.md' })
    expect(one).toEqual({ name: 'readme.md', mime: 'text/markdown', bytes: new Uint8Array(Buffer.from('# Notes')) })
    const json = mcpResourceUpload(contentsOf({ uri: 'x://a', mimeType: 'application/json', text: '{}' }), { uri: 'x://data/a.json' })
    expect(json.mime).toBe('text/plain')
    const mixed = mcpResourceUpload(contentsOf(
      { uri: 'x://a', mimeType: 'text/markdown', text: 'one' },
      { uri: 'x://b', mimeType: 'text/csv', text: 'two' },
      { uri: 'x://c', mimeType: 'image/png', blob: PNG },
    ), { uri: 'x://folder/', name: 'Folder' })
    expect(mixed.mime).toBe('text/plain')
    expect(mixed.name).toBe('Folder')
    expect(Buffer.from(mixed.bytes).toString('utf8')).toBe('one\n\ntwo\n\n[Binary resource: x://c (image/png, 16 bytes)]')
    const same = mcpResourceUpload(contentsOf({ uri: 'x://a', mimeType: 'text/markdown', text: 'a' }, { uri: 'x://b', mimeType: 'text/markdown', text: 'b' }), { uri: 'x://ab' })
    expect(same.mime).toBe('text/markdown')
  })

  it('stores an image or a PDF blob as declared and lets the upload path sniff an untyped one', () => {
    const image = mcpResourceUpload(contentsOf({ uri: 'fixture://images/pixel.png', mimeType: 'image/png', blob: PNG }), { uri: 'fixture://images/pixel.png' })
    expect(image).toEqual({ name: 'pixel.png', mime: 'image/png', bytes: new Uint8Array(Buffer.from(PNG, 'base64')) })
    expect(mcpResourceUpload(contentsOf({ uri: 'x://d', mimeType: 'application/pdf', blob: Buffer.from('%PDF-1.7').toString('base64') }), { uri: 'x://doc.pdf' }).mime).toBe('application/pdf')
    expect(mcpResourceUpload(contentsOf({ uri: 'x://d', blob: PNG }), { uri: 'x://d' }).mime).toBe('')
    expect(mcpResourceUpload(contentsOf({ uri: 'x://d', mimeType: 'application/octet-stream', blob: PNG }), { uri: 'x://d' }).mime).toBe('')
    expect(mcpResourceUpload(contentsOf({ uri: 'x://t', mimeType: 'text/plain', blob: Buffer.from('hi').toString('base64') }), { uri: 'x://t' }).mime).toBe('text/plain')
  })

  it('refuses other binaries and resources without content (validation_error)', () => {
    expect(() => mcpResourceUpload(contentsOf({ uri: 'x://z', mimeType: 'application/zip', blob: PNG }), { uri: 'x://z' }))
      .toThrow(expect.objectContaining({ code: 'validation_error', message: 'Only text, images and PDF files can be attached from an MCP server (this resource is application/zip).' }))
    expect(() => mcpResourceUpload(contentsOf(), { uri: 'x://z' })).toThrow(expect.objectContaining({ code: 'validation_error' }))
    expect(() => mcpResourceUpload({ contents: 'nope' }, { uri: 'x://z' })).toThrow(expect.objectContaining({ code: 'validation_error' }))
  })

  it('refuses more than maxBytes (payload_too_large with limitBytes)', () => {
    const limit = LIMITS.mcpResourceReadBytes
    const text = contentsOf({ uri: 'x://big', text: 'x'.repeat(limit + 1) })
    expect(() => mcpResourceUpload(text, { uri: 'x://big' })).toThrow(expect.objectContaining({ code: 'payload_too_large', details: { limitBytes: limit } }))
    expect(mcpResourceUpload(contentsOf({ uri: 'x://ok', text: 'x'.repeat(limit) }), { uri: 'x://ok' }).bytes.byteLength).toBe(limit)
    const blob = contentsOf({ uri: 'x://big', mimeType: 'image/png', blob: Buffer.alloc(101).toString('base64') })
    expect(() => mcpResourceUpload(blob, { uri: 'x://big', maxBytes: 100 })).toThrow(expect.objectContaining({ code: 'payload_too_large', details: { limitBytes: 100 } }))
  })
})

describe('resource helpers', () => {
  it('resourceFileName: the last URI path segment, else the listed name, else resource', () => {
    expect(resourceFileName('repo://owner/name/README.md')).toBe('README.md')
    expect(resourceFileName('file:///notes/My%20Notes.md')).toBe('My Notes.md')
    expect(resourceFileName('file:///bad%E0%A4%A.md')).toBe('bad%E0%A4%A.md')
    expect(resourceFileName('x://host', 'Listed')).toBe('Listed')
    expect(resourceFileName('urn:isbn:123')).toBe('isbn:123')
    expect(resourceFileName('x://host/..', null)).toBe('resource')
    expect(resourceFileName('not a uri')).toBe('resource')
  })

  it('canonicalMimeType: lower case without parameters, null otherwise', () => {
    expect(canonicalMimeType('Text/HTML; charset=utf-8')).toBe('text/html')
    expect(canonicalMimeType('text')).toBeNull()
    expect(canonicalMimeType(undefined)).toBeNull()
  })
})
