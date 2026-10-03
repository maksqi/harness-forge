import type { ToolCallContext } from '@harness-forge/plugin-sdk'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { SafeFetch } from '../../security/types.ts'
import { Buffer } from 'node:buffer'
import { createServer } from 'node:http'
import { HarnessError, LIMITS } from '@harness-forge/shared'
import { asSchema } from 'ai'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createSafeFetch } from '../../security/ssrf.ts'
import { promiseTool } from '../core-workspace/test-helpers.ts'
import {
  createWebFetchTool,
  truncateText,
  WEB_FETCH_DEFAULT_CHARS,
  WEB_FETCH_MAX_BYTES,
  WEB_FETCH_TEXT_JSON_BYTES,
  webFetch,
  webFetchInputSchema,
} from './web-fetch.ts'

type Handler = (request: IncomingMessage, response: ServerResponse) => void

let server: Server
let base: string
let seen: IncomingMessage['headers'][] = []
const routes = new Map<string, Handler>()

function respond(status: number, type: string | null, body: string | Uint8Array): Handler {
  return (_request, response) => {
    response.writeHead(status, type === null ? {} : { 'content-type': type })
    response.end(body)
  }
}

const PAGE = `<!doctype html><html><head><title>Example &amp; Co</title><script>alert("x")</script></head>
<body><nav>Menu</nav><h1>Welcome</h1><p>This is <a href="/x">a link</a> in a paragraph.</p><style>p{}</style></body></html>`

beforeAll(async () => {
  server = createServer((request, response) => {
    seen.push(request.headers)
    const handler = routes.get(request.url ?? '/')
    if (handler)
      handler(request, response)
    else
      respond(404, 'text/plain', 'missing')(request, response)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  routes.set('/page', respond(200, 'text/html; charset=utf-8', PAGE))
  routes.set('/xhtml', respond(200, 'application/xhtml+xml', '<html><head><title>X</title></head><body><p>xhtml body</p></body></html>'))
  routes.set('/plain', respond(200, 'text/plain', 'line 1\r\nline 2\n\n\n\nline 3\n'))
  routes.set('/json', respond(200, 'application/json', '{"answer":42}'))
  routes.set('/untyped-html', respond(200, null, '<!DOCTYPE html><title>Untyped</title><p>sniffed</p>'))
  routes.set('/latin1', respond(200, 'text/html; charset=iso-8859-1', Buffer.from('<p>café</p>', 'latin1')))
  routes.set('/meta-charset', respond(200, 'text/html', Buffer.concat([Buffer.from('<meta charset="windows-1252"><p>price '), Buffer.from([0x80]), Buffer.from(' 5</p>')])))
  routes.set('/image', respond(200, 'image/png', Buffer.from([0x89, 0x50, 0x4E, 0x47])))
  routes.set('/pdf', respond(200, 'application/pdf', '%PDF-1.7'))
  routes.set('/server-error', respond(503, 'text/html', '<p>down</p>'))
  routes.set('/long', respond(200, 'text/plain', 'word '.repeat(20_000)))
  routes.set('/cjk', respond(200, 'text/plain; charset=utf-8', '漢字'.repeat(30_000)))
  routes.set('/huge', respond(200, 'text/plain', Buffer.alloc(WEB_FETCH_MAX_BYTES + 1, 0x61)))
  routes.set('/to-metadata', (_request, response) => {
    response.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' })
    response.end()
  })
})

beforeEach(() => {
  seen = []
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
})

const context: ToolCallContext = {
  chatId: '0199a8f0-0000-7000-8000-000000000001',
  modelRef: 'mock:echo',
  toolCallId: 'call_1',
  messages: [],
  signal: new AbortController().signal,
}

const local: SafeFetch = createSafeFetch({ allowLoopback: true })

async function fetchLocal(path: string, maxChars?: number) {
  return webFetch({ url: `${base}${path}`, ...(maxChars === undefined ? {} : { maxChars }) }, { fetch: local, userAgent: 'harness-forge/test web_fetch' })
}

describe('webFetch', () => {
  it('returns the title and readable text of an HTML page', async () => {
    const result = await fetchLocal('/page')
    expect(result).toEqual({
      url: `${base}/page`,
      status: 200,
      contentType: 'text/html',
      title: 'Example & Co',
      text: 'Welcome\n\nThis is a link in a paragraph.',
      truncated: false,
    })
    expect(seen[0]?.['user-agent']).toBe('harness-forge/test web_fetch')
    expect(seen[0]?.accept).toContain('text/html')
  })

  it('reads XHTML, sniffs untyped HTML and returns text documents as they are', async () => {
    expect(await fetchLocal('/xhtml')).toMatchObject({ contentType: 'application/xhtml+xml', title: 'X', text: 'xhtml body' })
    expect(await fetchLocal('/untyped-html')).toMatchObject({ contentType: null, title: 'Untyped', text: 'sniffed' })
    expect(await fetchLocal('/plain')).toMatchObject({ contentType: 'text/plain', title: null, text: 'line 1\nline 2\n\nline 3' })
    expect(await fetchLocal('/json')).toMatchObject({ contentType: 'application/json', text: '{"answer":42}' })
  })

  it('decodes the charset of the Content-Type header or of a meta declaration', async () => {
    expect((await fetchLocal('/latin1')).text).toBe('café')
    expect((await fetchLocal('/meta-charset')).text).toBe('price € 5')
  })

  it('refuses images, PDFs and other binary content', async () => {
    for (const path of ['/image', '/pdf']) {
      const error = await fetchLocal(path).catch((failure: unknown) => failure)
      expect(error, path).toBeInstanceOf(HarnessError)
      expect((error as Error).message, path).toMatch(/^Unsupported content type "(?:image\/png|application\/pdf)"/)
    }
  })

  it('throws on HTTP errors', async () => {
    await expect(fetchLocal('/missing')).rejects.toMatchObject({ message: 'The server answered HTTP 404.', status: 404 })
    await expect(fetchLocal('/server-error')).rejects.toMatchObject({ message: 'The server answered HTTP 503.' })
  })

  it('cuts long text at maxChars on a word boundary', async () => {
    const short = await fetchLocal('/long', 1000)
    expect(short.truncated).toBe(true)
    expect(short.text.length).toBeLessThanOrEqual(1000)
    expect(short.text.endsWith('word')).toBe(true)
    const byDefault = await fetchLocal('/long')
    expect(byDefault.text.length).toBeLessThanOrEqual(WEB_FETCH_DEFAULT_CHARS)
    expect(byDefault.truncated).toBe(true)
  })

  it('keeps the output well under the tool output cap, also for multi-byte text', async () => {
    const result = await fetchLocal('/cjk', 40_000)
    expect(result.truncated).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(result.text))).toBeLessThanOrEqual(WEB_FETCH_TEXT_JSON_BYTES)
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(LIMITS.toolOutputBytes)
  })

  it('fails with payload_too_large above 2 MB', async () => {
    await expect(fetchLocal('/huge')).rejects.toMatchObject({ code: 'payload_too_large', details: { limitBytes: WEB_FETCH_MAX_BYTES } })
  })

  it('surfaces SSRF refusals, also after a redirect', async () => {
    await expect(fetchLocal('/to-metadata')).rejects.toMatchObject({ code: 'validation_error' })
    await expect(webFetch({ url: 'http://10.0.0.1/' }, { fetch: local })).rejects.toMatchObject({ code: 'validation_error' })
    await expect(webFetch({ url: 'file:///etc/passwd' }, { fetch: local })).rejects.toMatchObject({ code: 'validation_error' })
  })
})

describe('truncateText', () => {
  it('leaves short text alone and never splits a surrogate pair', () => {
    expect(truncateText('short', 100)).toEqual({ text: 'short', truncated: false })
    const emoji = '\u{1F600}'.repeat(10)
    const cut = truncateText(emoji, 5)
    expect(cut.truncated).toBe(true)
    expect(cut.text).toBe('\u{1F600}\u{1F600}')
  })

  it('respects the JSON byte budget', () => {
    const cut = truncateText('"\n'.repeat(1000), 5000, 100)
    expect(Buffer.byteLength(JSON.stringify(cut.text))).toBeLessThanOrEqual(100)
    expect(cut.truncated).toBe(true)
  })
})

describe('web_fetch tool', () => {
  it('is an ask tool with a url + maxChars object schema', () => {
    const tool = createWebFetchTool()
    expect(tool).toMatchObject({ name: 'web_fetch', policy: 'ask' })
    expect(tool.description.length).toBeLessThanOrEqual(1024)
    expect(asSchema(webFetchInputSchema).jsonSchema).toMatchObject({
      type: 'object',
      properties: { url: { type: 'string' }, maxChars: { type: 'integer', minimum: 1000, maximum: 40_000 } },
      required: ['url'],
    })
  })

  it('blocks loopback by default and reaches it only while allowLocalhost is on', async () => {
    let allowLocalhost = false
    const tool = promiseTool(createWebFetchTool({ allowLocalhost: () => allowLocalhost, userAgent: 'harness-forge/1.2.3 web_fetch' }))
    const refused = await tool.execute({ url: `${base}/page` }, context).catch((error: unknown) => error)
    expect(refused).toMatchObject({ code: 'validation_error' })
    expect((refused as Error).message).toContain('127.0.0.1 is a loopback address')
    expect(seen).toEqual([])

    allowLocalhost = true
    await expect(tool.execute({ url: `${base}/page` }, context)).resolves.toMatchObject({ title: 'Example & Co' })
    expect(seen[0]?.['user-agent']).toBe('harness-forge/1.2.3 web_fetch')
    // Private addresses stay blocked even with the setting on.
    await expect(tool.execute({ url: 'http://192.168.1.1/' }, context)).rejects.toMatchObject({ code: 'validation_error' })

    allowLocalhost = false
    await expect(tool.execute({ url: `${base}/page` }, context)).rejects.toMatchObject({ code: 'validation_error' })
  })

  it('uses the injected fetchers and passes the call signal', async () => {
    const calls: Array<{ url: string, signal?: AbortSignal }> = []
    const fake: SafeFetch = async (url, options) => {
      calls.push({ url, signal: options.signal })
      return { url, status: 200, headers: new Headers({ 'content-type': 'text/plain' }), body: new TextEncoder().encode('fake body') }
    }
    const tool = createWebFetchTool({ safeFetch: fake })
    await expect(tool.execute({ url: 'https://example.com/doc.txt' }, context)).resolves.toMatchObject({ text: 'fake body', url: 'https://example.com/doc.txt' })
    expect(calls).toEqual([{ url: 'https://example.com/doc.txt', signal: context.signal }])
  })
})
