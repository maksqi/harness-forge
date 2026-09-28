import type { LogRecord } from '../logger.ts'
import { HarnessError } from '@harness-forge/shared'
import { describe, expect, it, vi } from 'vitest'
import { createLogger } from '../logger.ts'
import { createRedactor } from '../security/redact.ts'
import { createHostFetch, createProviderRuntime, withTimeout } from './runtime.ts'

function recordingLogger(): { logger: ReturnType<typeof createLogger>, records: LogRecord[] } {
  const records: LogRecord[] = []
  return { logger: createLogger({ level: 'debug', sink: record => records.push(record) }), records }
}

interface SeenRequest {
  url: string
  method: string
  body: string | null
  headers: Record<string, string>
  signal: AbortSignal | null | undefined
  redirect: RequestInit['redirect']
}

/** A base fetch answering from a route table (path -> response factory). */
function fakeFetch(routes: Record<string, (request: SeenRequest) => Response>): { fetch: typeof globalThis.fetch, seen: SeenRequest[] } {
  const seen: SeenRequest[] = []
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    const url = String(input)
    const request: SeenRequest = {
      url,
      method: init.method ?? 'GET',
      body: typeof init.body === 'string' ? init.body : null,
      headers: Object.fromEntries(new Headers(init.headers)),
      signal: init.signal,
      redirect: init.redirect,
    }
    seen.push(request)
    const route = routes[new URL(url).href] ?? routes[new URL(url).pathname]
    if (!route)
      throw new Error(`unexpected request ${url}`)
    return route(request)
  }
  return { fetch, seen }
}

function redirect(location: string, status = 302): () => Response {
  return () => new Response('moved', { status, headers: { location } })
}

describe('withTimeout', () => {
  it('resolves with the value of the task', async () => {
    await expect(withTimeout(1000, async () => 42)).resolves.toBe(42)
  })

  it('rejects with a TimeoutError and aborts the signal when the task is too slow', async () => {
    let seen: AbortSignal | undefined
    const pending = withTimeout(20, (signal) => {
      seen = signal
      return new Promise(() => {})
    })
    await expect(pending).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(seen?.aborted).toBe(true)
  })

  it('stops with the parent signal', async () => {
    const parent = new AbortController()
    const pending = withTimeout(5000, () => new Promise(() => {}), parent.signal)
    parent.abort(new Error('stopped'))
    await expect(pending).rejects.toThrow('stopped')
  })

  it('rejects at once for an aborted parent and passes task errors through', async () => {
    const parent = new AbortController()
    parent.abort()
    await expect(withTimeout(1000, async () => 1, parent.signal)).rejects.toMatchObject({ name: 'AbortError' })
    await expect(withTimeout(1000, () => {
      throw new Error('boom')
    })).rejects.toThrow('boom')
  })
})

describe('createHostFetch', () => {
  it('follows same-origin redirects and logs method and URL without headers', async () => {
    const { logger, records } = recordingLogger()
    const { fetch, seen } = fakeFetch({
      '/v1/models': redirect('/v1/models/'),
      '/v1/models/': () => Response.json({ data: [] }),
    })
    const hostFetch = createHostFetch({ providerId: 'acme', logger, fetch })
    const response = await hostFetch('https://api.acme.test/v1/models', { headers: { authorization: 'Bearer sk-secret-value-123456' } })
    expect(await response.json()).toEqual({ data: [] })
    expect(seen.map(request => request.url)).toEqual(['https://api.acme.test/v1/models', 'https://api.acme.test/v1/models/'])
    expect(seen.every(request => request.redirect === 'manual')).toBe(true)
    expect(seen[1]?.headers.authorization).toBe('Bearer sk-secret-value-123456')
    const logged = records.filter(record => record.msg === 'provider request')
    expect(logged).toHaveLength(2)
    expect(logged[0]).toMatchObject({ level: 'debug', providerId: 'acme', method: 'GET', url: 'https://api.acme.test/v1/models' })
    expect(JSON.stringify(records)).not.toContain('sk-secret-value-123456')
  })

  it('refuses a cross-origin redirect (the key never leaves the provider origin)', async () => {
    const { logger } = recordingLogger()
    const { fetch, seen } = fakeFetch({ '/v1/models': redirect('https://evil.test/collect') })
    const hostFetch = createHostFetch({ providerId: 'acme', logger, fetch })
    const error = await hostFetch('https://api.acme.test/v1/models').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(HarnessError)
    expect(error).toMatchObject({ code: 'provider_error', providerId: 'acme' })
    expect(seen).toHaveLength(1)
  })

  it('stops after 5 redirects', async () => {
    const { logger } = recordingLogger()
    const { fetch, seen } = fakeFetch({ '/loop': redirect('/loop', 307) })
    const hostFetch = createHostFetch({ providerId: 'acme', logger, fetch })
    await expect(hostFetch('https://api.acme.test/loop')).rejects.toMatchObject({ code: 'provider_error' })
    expect(seen).toHaveLength(6)
  })

  it('turns a POST into a GET on 303 and replays the body on 307', async () => {
    const { logger } = recordingLogger()
    const { fetch, seen } = fakeFetch({
      '/see-other': redirect('/result', 303),
      '/temporary': redirect('/result', 307),
      '/result': request => Response.json({ method: request.method, body: request.body }),
    })
    const hostFetch = createHostFetch({ providerId: 'acme', logger, fetch })
    const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' }
    expect(await (await hostFetch('https://api.acme.test/see-other', init)).json()).toEqual({ method: 'GET', body: null })
    expect(await (await hostFetch('https://api.acme.test/temporary', init)).json()).toEqual({ method: 'POST', body: '{"a":1}' })
    expect(seen[1]?.headers['content-type']).toBeUndefined()
  })

  it('combines the runtime signal with the request signal', async () => {
    const { logger } = recordingLogger()
    const { fetch, seen } = fakeFetch({ '/ok': () => new Response('ok') })
    const runtimeSignal = new AbortController()
    const hostFetch = createHostFetch({ providerId: 'acme', logger, fetch, signal: runtimeSignal.signal })
    await hostFetch('https://api.acme.test/ok', { signal: new AbortController().signal })
    runtimeSignal.abort()
    expect(seen[0]?.signal?.aborted).toBe(true)
  })

  it('reads globalThis.fetch at call time', async () => {
    const { logger } = recordingLogger()
    const stub = vi.fn(async () => new Response('stubbed'))
    vi.stubGlobal('fetch', stub)
    try {
      const hostFetch = createHostFetch({ providerId: 'acme', logger })
      expect(await (await hostFetch('https://api.acme.test/x')).text()).toBe('stubbed')
      expect(stub).toHaveBeenCalledOnce()
    }
    finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('createProviderRuntime', () => {
  it('copies the credentials and registers secret values with the redactor', () => {
    const { logger } = recordingLogger()
    const redactor = createRedactor()
    const rt = createProviderRuntime({
      definition: {
        id: 'acme',
        name: 'Acme',
        credentials: [
          { key: 'apiKey', label: 'API key', type: 'secret', required: true },
          { key: 'baseURL', label: 'Base URL', type: 'url' },
        ],
        createLanguageModel: () => {
          throw new Error('unused')
        },
      },
      values: { apiKey: 'acme-secret-key-0001', baseURL: 'https://api.acme.test/v1' },
      logger,
      redactor,
    })
    expect(rt.credentials).toEqual({ apiKey: 'acme-secret-key-0001', baseURL: 'https://api.acme.test/v1' })
    expect(redactor.redactText('key acme-secret-key-0001 and https://api.acme.test/v1')).toBe('key [redacted] and https://api.acme.test/v1')
  })
})
