import type { ChatDetail } from '../schemas/chats.ts'
import type { Settings } from '../schemas/system.ts'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { HarnessError } from '../errors.ts'
import { apiUrl, createApiClient } from './client.ts'

interface Call {
  url: string
  init: RequestInit
}

function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = []
  const fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const call = { url: String(input), init }
    calls.push(call)
    return respond(call)
  }
  return { calls, fetch: fetch as typeof globalThis.fetch }
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

const settings: Settings = {
  displayName: '',
  defaultModelRef: null,
  titleModelRef: null,
  instructions: '',
  sendKey: 'enter',
  defaultToolMode: 'ask',
  defaultReasoningEffort: 'auto',
  maxSteps: 20,
  altShortcuts: true,
  showThinking: false,
  density: 'comfortable',
  readingFont: 'sans',
  textSize: 'md',
}

describe('createApiClient', () => {
  it('sends GET requests with same-origin credentials and parses JSON', async () => {
    const { calls, fetch } = fakeFetch(() => json(settings))
    const client = createApiClient({ fetch })
    const result = await client.settings.get()
    expect(result).toEqual(settings)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('/api/settings')
    expect(calls[0]?.init).toMatchObject({ method: 'GET', credentials: 'same-origin', body: undefined })
    expect(calls[0]?.init.headers).toEqual({ accept: 'application/json' })
  })

  it('sends JSON bodies with a content type', async () => {
    const { calls, fetch } = fakeFetch(() => json({ ...settings, maxSteps: 5 }))
    const client = createApiClient({ fetch, baseUrl: 'http://127.0.0.1:8899/api/' })
    await client.settings.update({ body: { maxSteps: 5 } })
    expect(calls[0]?.url).toBe('http://127.0.0.1:8899/api/settings')
    expect(calls[0]?.init.method).toBe('PUT')
    expect(calls[0]?.init.headers).toMatchObject({ 'content-type': 'application/json', 'accept': 'application/json' })
    expect(calls[0]?.init.body).toBe('{"maxSteps":5}')
  })

  it('sends an empty JSON object when an optional body is omitted', async () => {
    const { calls, fetch } = fakeFetch(() => json({ ok: true, latencyMs: 3 }))
    await createApiClient({ fetch }).providers.test({ params: { id: 'openai' } })
    expect(calls[0]?.url).toBe('/api/providers/openai/test')
    expect(calls[0]?.init.body).toBe('{}')
  })

  it('sends no body for routes without one', async () => {
    const { calls, fetch } = fakeFetch(() => json({ stopped: true }))
    const result = await createApiClient({ fetch }).chat.stop({ params: { id: '0199a8f0-0000-7000-8000-000000000001' } })
    expect(result).toEqual({ stopped: true })
    expect(calls[0]?.init).toMatchObject({ method: 'POST', body: undefined })
    expect(calls[0]?.init.headers).not.toHaveProperty('content-type')
  })

  it('encodes path params and serializes the query', async () => {
    const { calls, fetch } = fakeFetch(() => json({ items: [], nextCursor: null }))
    const client = createApiClient({ fetch })
    await client.chats.list({ query: { q: 'a&b c', limit: 20, archived: true } })
    expect(calls[0]?.url).toBe('/api/chats?q=a%26b+c&limit=20&archived=true')
    await client.chats.list()
    expect(calls[1]?.url).toBe('/api/chats')
  })

  it('keeps / in rest paths and encodes each segment', async () => {
    const { calls, fetch } = fakeFetch(() => json({ path: 'src/a b.ts', content: '', etag: 'a'.repeat(64), mtime: 1 }))
    await createApiClient({ fetch }).pluginFiles.read({ params: { id: 'my-tool', path: 'src/a b.ts' } })
    expect(calls[0]?.url).toBe('/api/plugins/my-tool/files/src/a%20b.ts')
  })

  it('rejects missing params and dot segments before sending', async () => {
    const { calls, fetch } = fakeFetch(() => json({}))
    const client = createApiClient({ fetch })
    await expect(client.chats.get({ params: { id: '' } })).rejects.toMatchObject({ code: 'validation_error' })
    await expect(client.pluginFiles.read({ params: { id: 'x', path: '../secret' } })).rejects.toBeInstanceOf(HarnessError)
    expect(calls).toHaveLength(0)
  })

  it('sends multipart forms without a content type', async () => {
    const { calls, fetch } = fakeFetch(() => json({ id: 'file_ABCdef0123456789', name: 'a.txt', mime: 'text/plain', size: 1, url: '/api/files/file_ABCdef0123456789' }, 201))
    const form = new FormData()
    form.append('file', new Blob(['x'], { type: 'text/plain' }), 'a.txt')
    const file = await createApiClient({ fetch }).files.upload({ form })
    expect(file.id).toBe('file_ABCdef0123456789')
    expect(calls[0]?.init.body).toBe(form)
    expect(calls[0]?.init.headers).not.toHaveProperty('content-type')
  })

  it('accepts either a JSON body or a form on install routes', async () => {
    const { calls, fetch } = fakeFetch(() => json({}, 200))
    const client = createApiClient({ fetch })
    await client.pluginInstall.inspect({ body: { source: 'npm', spec: 'harness-forge-plugin-dice@1.0.0' } })
    expect(calls[0]?.init.headers).toMatchObject({ 'content-type': 'application/json' })
    await client.pluginInstall.inspect({ form: new FormData() })
    expect(calls[1]?.init.headers).not.toHaveProperty('content-type')
  })

  it('resolves void for 204 responses', async () => {
    const { fetch } = fakeFetch(() => new Response(null, { status: 204 }))
    const client = createApiClient({ fetch })
    await expect(client.chats.remove({ params: { id: '0199a8f0-0000-7000-8000-000000000001' } })).resolves.toBeUndefined()
    await expect(client.auth.logout()).resolves.toBeUndefined()
  })

  it('returns the raw Response for streams and binary routes', async () => {
    const response = new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
    const { calls, fetch } = fakeFetch(() => response)
    const client = createApiClient({ fetch })
    const result = await client.chat.resume({ params: { id: '0199a8f0-0000-7000-8000-000000000001' } })
    expect(result).toBe(response)
    expect(calls[0]?.init.headers).toEqual({ accept: 'text/event-stream' })
  })

  it('throws the HarnessError of the envelope with the request id', async () => {
    const { fetch } = fakeFetch(() => json(
      { error: { code: 'provider_not_configured', message: 'Add a key', providerId: 'openai', action: 'configure-provider' } },
      400,
      { 'x-request-id': 'req-42' },
    ))
    const error = await createApiClient({ fetch }).models.list().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(HarnessError)
    expect(error).toMatchObject({ code: 'provider_not_configured', providerId: 'openai', action: 'configure-provider', requestId: 'req-42' })
  })

  it('keeps an internal_error envelope from the server', async () => {
    const { fetch } = fakeFetch(() => json({ error: { code: 'internal_error', message: 'Boom', details: { requestId: 'r1' } } }, 500))
    await expect(createApiClient({ fetch }).tools.list()).rejects.toMatchObject({ code: 'internal_error', message: 'Boom' })
  })

  it('falls back to internal_error for non-envelope bodies', async () => {
    const { fetch } = fakeFetch(() => new Response('<html>Bad gateway</html>', { status: 502, headers: { 'x-request-id': 'req-7' } }))
    const error = await createApiClient({ fetch }).tools.list().catch((caught: unknown) => caught) as HarnessError
    expect(error).toBeInstanceOf(HarnessError)
    expect(error.code).toBe('internal_error')
    expect(error.message).toContain('502')
    expect(error.requestId).toBe('req-7')
  })

  it('maps network failures to internal_error', async () => {
    const { fetch } = fakeFetch(() => {
      throw new TypeError('fetch failed')
    })
    const error = await createApiClient({ fetch }).health.get().catch((caught: unknown) => caught) as HarnessError
    expect(error).toBeInstanceOf(HarnessError)
    expect(error.code).toBe('internal_error')
    expect(error.cause).toBeInstanceOf(TypeError)
  })

  it('rethrows aborts', async () => {
    const controller = new AbortController()
    const { fetch } = fakeFetch(() => {
      controller.abort()
      throw new DOMException('The operation was aborted.', 'AbortError')
    })
    const error = await createApiClient({ fetch }).health.get({ signal: controller.signal }).catch((caught: unknown) => caught)
    expect(error).not.toBeInstanceOf(HarnessError)
    expect((error as Error).name).toBe('AbortError')
  })

  it('throws internal_error for invalid JSON', async () => {
    const { fetch } = fakeFetch(() => new Response('not json', { status: 200 }))
    await expect(createApiClient({ fetch }).health.get()).rejects.toMatchObject({ code: 'internal_error' })
  })

  it('merges extra headers and credentials options', async () => {
    const { calls, fetch } = fakeFetch(() => json(settings))
    await createApiClient({ fetch, credentials: 'include' }).settings.get({ headers: { 'x-test': '1' } })
    expect(calls[0]?.init).toMatchObject({ credentials: 'include', headers: { 'accept': 'application/json', 'x-test': '1' } })
  })

  it('uses globalThis.fetch lazily by default', async () => {
    const original = globalThis.fetch
    const { calls, fetch } = fakeFetch(() => json(settings))
    const client = createApiClient()
    globalThis.fetch = fetch
    try {
      await client.settings.get()
    }
    finally {
      globalThis.fetch = original
    }
    expect(calls).toHaveLength(1)
  })

  it('is typed per route', () => {
    const client = createApiClient({ fetch: fakeFetch(() => json({})).fetch })
    expectTypeOf(client.chats.get).parameter(0).toHaveProperty('params')
    expectTypeOf(client.chats.get).returns.resolves.toEqualTypeOf<ChatDetail>()
    expectTypeOf(client.chats.remove).returns.resolves.toEqualTypeOf<void>()
    expectTypeOf(client.chat.send).returns.resolves.toEqualTypeOf<Response>()
    expectTypeOf(client.settings.get).returns.resolves.toEqualTypeOf<Settings>()
  })
})

describe('apiUrl', () => {
  it('builds URLs for img, EventSource and downloads', () => {
    expect(apiUrl('events.stream')).toBe('/api/events')
    expect(apiUrl('icons.get', { params: { slug: 'claude-color' } })).toBe('/api/icons/lobe/claude-color')
    expect(apiUrl('chats.export', { params: { id: '0199a8f0-0000-7000-8000-000000000001' }, query: { format: 'md' } }))
      .toBe('/api/chats/0199a8f0-0000-7000-8000-000000000001/export?format=md')
    expect(apiUrl('plugins.icon', { params: { id: 'my-plugin' } }, 'http://localhost:8787/api')).toBe('http://localhost:8787/api/plugins/my-plugin/icon')
    expect(apiUrl('models.list', { query: { providerId: 'openai', includeHidden: false } })).toBe('/api/models?providerId=openai&includeHidden=false')
  })
})
