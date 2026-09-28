import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { AddressClass, SafeFetchConfig } from './ssrf.ts'
import { Buffer } from 'node:buffer'
import { createServer } from 'node:http'
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib'
import { HarnessError } from '@harness-forge/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { classifyAddress, createSafeFetch, isBlockedAddress, safeFetch } from './ssrf.ts'

interface SeenRequest {
  method: string
  path: string
  headers: IncomingMessage['headers']
}

type Handler = (request: IncomingMessage, response: ServerResponse) => void

let server: Server
let port: number
let seen: SeenRequest[] = []
const routes = new Map<string, Handler>()

function origin(): string {
  return `http://127.0.0.1:${port}`
}

function redirect(location: string, status = 302): Handler {
  return (_request, response) => {
    response.writeHead(status, { location })
    response.end()
  }
}

function text(body: string | Uint8Array, headers: Record<string, string> = {}): Handler {
  return (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', ...headers })
    response.end(body)
  }
}

function decode(body: Uint8Array): string {
  return new TextDecoder().decode(body)
}

beforeAll(async () => {
  server = createServer((request, response) => {
    const path = request.url ?? '/'
    seen.push({ method: request.method ?? 'GET', path, headers: request.headers })
    const loop = path.match(/^\/loop\/(\d+)$/)
    if (loop) {
      redirect(`/loop/${Number(loop[1]) + 1}`)(request, response)
      return
    }
    const chain = path.match(/^\/chain\/(\d+)$/)
    if (chain) {
      const step = Number(chain[1])
      if (step < 5)
        redirect(`/chain/${step + 1}`)(request, response)
      else
        text('end of chain')(request, response)
      return
    }
    const handler = routes.get(path)
    if (handler) {
      handler(request, response)
      return
    }
    response.writeHead(404, { 'content-type': 'text/plain' })
    response.end('not found')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port

  routes.set('/ok', text('hello'))
  routes.set('/headers', (request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(request.headers))
  })
  routes.set('/redirect-metadata', redirect('http://169.254.169.254/latest/meta-data'))
  routes.set('/redirect-private', redirect('http://10.0.0.1/'))
  routes.set('/redirect-mapped', redirect('http://[::ffff:192.168.0.1]/'))
  routes.set('/redirect-rebind', redirect('http://metadata.test/'))
  routes.set('/redirect-local', redirect('/ok'))
  routes.set('/redirect-see-other', redirect('/ok', 303))
  routes.set('/redirect-ftp', redirect('ftp://example.com/file'))
  routes.set('/redirect-same-origin', redirect('/headers'))
  routes.set('/redirect-cross-origin', (_request, response) => {
    response.writeHead(307, { location: `http://other.test:${port}/headers` })
    response.end()
  })
  routes.set('/big-declared', text('x'.repeat(100)))
  routes.set('/big-chunked', (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.write('a'.repeat(40))
    response.write('b'.repeat(40))
    response.write('c'.repeat(40))
    response.end()
  })
  routes.set('/gzip', text(gzipSync('hello gzip'), { 'content-encoding': 'gzip' }))
  routes.set('/deflate', text(deflateSync('hello deflate'), { 'content-encoding': 'deflate' }))
  routes.set('/br', text(brotliCompressSync('hello brotli'), { 'content-encoding': 'br' }))
  routes.set('/gzip-bomb', text(gzipSync(Buffer.alloc(1_000_000)), { 'content-encoding': 'gzip' }))
  routes.set('/broken-gzip', text('this is not gzip at all', { 'content-encoding': 'gzip' }))
  routes.set('/weird-encoding', text('abc', { 'content-encoding': 'compress' }))
  routes.set('/status-500', (_request, response) => {
    response.writeHead(500, { 'content-type': 'text/plain' })
    response.end('boom')
  })
  routes.set('/hang', () => {
    // Never answers: the client times out or aborts.
  })
})

beforeEach(() => {
  seen = []
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
})

const NAMES: Record<string, Array<{ address: string, family: 4 | 6 }>> = {
  'rebind.test': [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }],
  'loop.test': [{ address: '127.0.0.1', family: 4 }],
  'other.test': [{ address: '127.0.0.1', family: 4 }],
  'mapped.test': [{ address: '::ffff:192.168.1.1', family: 6 }],
  'metadata.test': [{ address: '169.254.169.254', family: 4 }],
  'ula.test': [{ address: 'fd12:3456::1', family: 6 }],
  'empty.test': [],
}

/** Test resolver: known names only; anything else fails like NXDOMAIN (no real DNS in tests). */
const lookup: NonNullable<SafeFetchConfig['lookup']> = async (hostname) => {
  const answers = NAMES[hostname]
  if (answers === undefined)
    throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' })
  return answers
}

/** A resolver that must never be reached (the request is refused before DNS). */
const forbiddenLookup: NonNullable<SafeFetchConfig['lookup']> = async (hostname) => {
  throw new Error(`DNS must not be used for ${hostname}`)
}

const guarded = createSafeFetch({ lookup })
const loopback = createSafeFetch({ lookup, allowLoopback: true })

async function failure(promise: Promise<unknown>): Promise<HarnessError> {
  try {
    await promise
  }
  catch (error) {
    expect(error).toBeInstanceOf(HarnessError)
    return error as HarnessError
  }
  throw new Error('Expected the request to fail.')
}

describe('classifyAddress', () => {
  const table: Array<[string, AddressClass]> = [
    ['8.8.8.8', 'public'],
    ['93.184.216.34', 'public'],
    ['1.1.1.1', 'public'],
    ['0.0.0.0', 'unspecified'],
    ['0.1.2.3', 'unspecified'],
    ['10.0.0.1', 'private'],
    ['10.255.255.255', 'private'],
    ['100.64.0.1', 'cgnat'],
    ['100.127.255.255', 'cgnat'],
    ['100.128.0.1', 'public'],
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['169.254.169.254', 'metadata'],
    ['169.254.0.1', 'link-local'],
    ['169.254.170.2', 'link-local'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['172.32.0.1', 'public'],
    ['192.0.0.8', 'reserved'],
    ['192.0.2.1', 'reserved'],
    ['192.88.99.1', 'reserved'],
    ['192.168.1.1', 'private'],
    ['198.18.0.1', 'reserved'],
    ['198.19.255.255', 'reserved'],
    ['198.51.100.7', 'reserved'],
    ['203.0.113.9', 'reserved'],
    ['224.0.0.1', 'multicast'],
    ['239.255.255.250', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'reserved'],
    ['::', 'unspecified'],
    ['::1', 'loopback'],
    ['[::1]', 'loopback'],
    ['0:0:0:0:0:0:0:1', 'loopback'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:7f00:1', 'loopback'],
    ['::ffff:10.0.0.1', 'private'],
    ['::ffff:a9fe:a9fe', 'metadata'],
    ['::ffff:8.8.8.8', 'public'],
    ['::ffff:0:10.0.0.1', 'private'],
    ['::127.0.0.1', 'loopback'],
    ['::0.0.0.2', 'unspecified'],
    ['64:ff9b::a9fe:a9fe', 'metadata'],
    ['64:ff9b::10.1.2.3', 'private'],
    ['64:ff9b::808:808', 'public'],
    ['64:ff9b:1::1', 'reserved'],
    ['2002:c0a8:0101::1', 'private'],
    ['2002:7f00:0001::', 'loopback'],
    ['2002:0808:0808::1', 'public'],
    ['2001::1', 'reserved'],
    ['2001:db8::1', 'reserved'],
    ['100::1', 'reserved'],
    ['fc00::1', 'private'],
    ['fd00::1', 'private'],
    ['fd00:ec2::254', 'metadata'],
    ['fe80::1', 'link-local'],
    ['fe80::1%eth0', 'link-local'],
    ['febf::1', 'link-local'],
    ['fec0::1', 'private'],
    ['ff02::1', 'multicast'],
    ['2606:4700:4700::1111', 'public'],
    ['2a00:1450:4001:80b::200e', 'public'],
    ['not-an-ip', 'invalid'],
    ['', 'invalid'],
    ['1.2.3', 'invalid'],
    ['256.1.1.1', 'invalid'],
    ['example.com', 'invalid'],
  ]

  it.each(table)('%s -> %s', (address, expected) => {
    expect(classifyAddress(address)).toBe(expected)
  })

  it('blocks everything that is not public, loopback only on request', () => {
    expect(isBlockedAddress('8.8.8.8')).toBe(false)
    expect(isBlockedAddress('127.0.0.1')).toBe(true)
    expect(isBlockedAddress('127.0.0.1', { allowLoopback: true })).toBe(false)
    expect(isBlockedAddress('::1', { allowLoopback: true })).toBe(false)
    expect(isBlockedAddress('::ffff:127.0.0.1', { allowLoopback: true })).toBe(false)
    for (const address of ['10.0.0.1', '169.254.169.254', 'fd00::1', 'fe80::1', '100.64.0.1', '0.0.0.0', 'garbage'])
      expect(isBlockedAddress(address, { allowLoopback: true }), address).toBe(true)
  })
})

describe('sSRF table (refused before any connection)', () => {
  const urls = (): string[] => [
    `http://127.0.0.1:${port}/ok`,
    `http://localhost:${port}/ok`,
    `http://LOCALHOST.:${port}/ok`,
    `http://app.localhost:${port}/ok`,
    `http://[::1]:${port}/ok`,
    `http://[::ffff:127.0.0.1]:${port}/ok`,
    `http://2130706433:${port}/ok`,
    `http://0x7f.1:${port}/ok`,
    `http://127.1:${port}/ok`,
    `http://0177.0.0.1:${port}/ok`,
    'http://10.0.0.1/',
    'http://169.254.169.254/latest/meta-data',
    'http://[fd00::1]/',
    'http://[fd00:ec2::254]/latest/meta-data',
    'http://[fe80::1]/',
    'http://100.64.0.1/',
    'http://0.0.0.0/',
    'http://[::]/',
    'http://224.0.0.1/',
  ]

  it('rejects loopback, private, link-local, metadata and other non-public targets', async () => {
    const noDns = createSafeFetch({ lookup: forbiddenLookup })
    for (const url of urls()) {
      const error = await failure(noDns(url, { maxBytes: 1024 }))
      expect(error.code, url).toBe('validation_error')
      expect(error.message, url).toMatch(/only public internet addresses/)
    }
    expect(seen).toEqual([])
  })

  it('the default safeFetch refuses the local test server', async () => {
    const error = await failure(safeFetch(`http://127.0.0.1:${port}/ok`, { maxBytes: 1024 }))
    expect(error.code).toBe('validation_error')
    expect(error.message).toContain('127.0.0.1 is a loopback address')
    expect(seen).toEqual([])
  })

  it('rejects other protocols, credentials and invalid URLs before DNS', async () => {
    const noDns = createSafeFetch({ lookup: forbiddenLookup })
    for (const url of ['ftp://example.com/file', 'file:///etc/passwd', 'data:text/plain,hi', 'javascript:alert(1)', 'not a url', '/relative', ''])
      expect((await failure(noDns(url, { maxBytes: 1024 }))).code, url).toBe('validation_error')
    const https = await failure(noDns('http://example.com/', { maxBytes: 1024, protocols: ['https:'] }))
    expect(https.code).toBe('validation_error')
    expect(https.message).toContain('only https URLs are allowed')
    const credentials = await failure(noDns('http://user:hunter22@example.com/', { maxBytes: 1024 }))
    expect(credentials.code).toBe('validation_error')
    expect(credentials.message).not.toContain('hunter22')
  })

  it('rejects invalid options', async () => {
    expect((await failure(guarded('http://loop.test/', { maxBytes: -1 }))).code).toBe('validation_error')
    expect((await failure(guarded('http://loop.test/', { maxBytes: 10, method: 'POST' as 'GET' }))).code).toBe('validation_error')
    expect((await failure(guarded('http://loop.test/', { maxBytes: 10, headers: { 'x-evil': 'a\r\nb: c' } }))).code).toBe('validation_error')
  })
})

describe('dNS checks', () => {
  it('rejects a name when any resolved address is private (DNS rebinding)', async () => {
    const error = await failure(guarded('http://rebind.test/', { maxBytes: 1024 }))
    expect(error.code).toBe('validation_error')
    expect(error.message).toContain('"rebind.test" resolves to 10.0.0.5')
  })

  it('rejects names resolving to IPv4-mapped private, ULA or metadata addresses', async () => {
    for (const host of ['mapped.test', 'ula.test', 'metadata.test'])
      expect((await failure(guarded(`http://${host}/`, { maxBytes: 1024 }))).code, host).toBe('validation_error')
  })

  it('rejects a name resolving to loopback unless loopback is allowed, then connects to the checked address', async () => {
    const refused = await failure(guarded(`http://loop.test:${port}/headers`, { maxBytes: 4096 }))
    expect(refused.code).toBe('validation_error')
    expect(seen).toEqual([])

    // `loop.test` does not exist in real DNS: the request can only reach the server through the pinned address.
    const result = await loopback(`http://loop.test:${port}/headers`, { maxBytes: 4096 })
    expect(result.status).toBe(200)
    expect(JSON.parse(decode(result.body))).toMatchObject({ host: `loop.test:${port}` })
  })

  it('reports unknown names and empty answers as unreachable', async () => {
    const unknown = await failure(guarded('http://nowhere.test/', { maxBytes: 1024 }))
    expect(unknown).toMatchObject({ code: 'provider_unreachable' })
    expect(unknown.message).toContain('ENOTFOUND')
    expect((await failure(guarded('http://empty.test/', { maxBytes: 1024 }))).code).toBe('provider_unreachable')
  })
})

describe('allowLoopback', () => {
  it('fetches from a local server and returns status, headers, body and final URL', async () => {
    const result = await loopback(`${origin()}/ok`, { maxBytes: 1024 })
    expect(result.status).toBe(200)
    expect(result.url).toBe(`${origin()}/ok`)
    expect(result.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(result.body).toBeInstanceOf(Uint8Array)
    expect(decode(result.body)).toBe('hello')
    expect(seen[0]?.headers['user-agent']).toBe('harness-forge')
  })

  it('returns non-2xx statuses instead of throwing', async () => {
    const missing = await loopback(`${origin()}/nope`, { maxBytes: 1024 })
    expect(missing.status).toBe(404)
    const failed = await loopback(`${origin()}/status-500`, { maxBytes: 1024 })
    expect(failed.status).toBe(500)
    expect(decode(failed.body)).toBe('boom')
  })

  it('supports HEAD and caller headers (the User-Agent of the config is the default)', async () => {
    const custom = createSafeFetch({ allowLoopback: true, userAgent: 'harness-forge/9.9.9' })
    const head = await custom(`${origin()}/ok`, { maxBytes: 1024, method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.body.byteLength).toBe(0)
    expect(seen[0]).toMatchObject({ method: 'HEAD' })
    expect(seen[0]?.headers['user-agent']).toBe('harness-forge/9.9.9')
    await custom(`${origin()}/headers`, { maxBytes: 4096, headers: { 'User-Agent': 'custom-agent', 'X-Test': '1', 'Host': 'evil.test' } })
    expect(seen[1]?.headers).toMatchObject({ 'user-agent': 'custom-agent', 'x-test': '1', 'host': `127.0.0.1:${port}` })
  })

  it('still refuses private and metadata addresses', async () => {
    expect((await failure(loopback('http://10.0.0.1/', { maxBytes: 1024 }))).code).toBe('validation_error')
    expect((await failure(loopback('http://169.254.169.254/', { maxBytes: 1024 }))).code).toBe('validation_error')
    expect((await failure(loopback('http://[fd00::1]/', { maxBytes: 1024 }))).code).toBe('validation_error')
  })

  it('maps a refused connection to provider_unreachable', async () => {
    const closed = createServer()
    await new Promise<void>(resolve => closed.listen(0, '127.0.0.1', resolve))
    const closedPort = (closed.address() as AddressInfo).port
    await new Promise<void>(resolve => closed.close(() => resolve()))
    const error = await failure(loopback(`http://127.0.0.1:${closedPort}/`, { maxBytes: 1024 }))
    expect(error.code).toBe('provider_unreachable')
    expect(error.message).toContain('ECONNREFUSED')
  })
})

describe('redirects', () => {
  it('follows a relative redirect and reports the final URL', async () => {
    const result = await loopback(`${origin()}/redirect-local`, { maxBytes: 1024 })
    expect(result.status).toBe(200)
    expect(result.url).toBe(`${origin()}/ok`)
    expect(decode(result.body)).toBe('hello')
    expect(seen.map(request => request.path)).toEqual(['/redirect-local', '/ok'])
  })

  it('follows 303 See Other', async () => {
    const result = await loopback(`${origin()}/redirect-see-other`, { maxBytes: 1024 })
    expect(result.url).toBe(`${origin()}/ok`)
  })

  it('re-checks every hop: redirects to metadata, private, mapped or rebinding names are refused', async () => {
    for (const path of ['/redirect-metadata', '/redirect-private', '/redirect-mapped', '/redirect-rebind']) {
      const error = await failure(loopback(`${origin()}${path}`, { maxBytes: 1024 }))
      expect(error.code, path).toBe('validation_error')
    }
    // Only the first hops reached the local server.
    expect(seen.map(request => request.path)).toEqual(['/redirect-metadata', '/redirect-private', '/redirect-mapped', '/redirect-rebind'])
  })

  it('refuses a redirect to another protocol', async () => {
    const error = await failure(loopback(`${origin()}/redirect-ftp`, { maxBytes: 1024 }))
    expect(error.code).toBe('validation_error')
    expect(error.message).toContain('redirected to a URL that is not allowed')
  })

  it('follows exactly maxRedirects hops and fails after that', async () => {
    const result = await loopback(`${origin()}/chain/0`, { maxBytes: 1024 })
    expect(decode(result.body)).toBe('end of chain')
    const error = await failure(loopback(`${origin()}/loop/0`, { maxBytes: 1024 }))
    expect(error.code).toBe('provider_error')
    expect(error.message).toContain('Too many redirects')
    const strict = await failure(loopback(`${origin()}/chain/0`, { maxBytes: 1024, maxRedirects: 2 }))
    expect(strict.code).toBe('provider_error')
  })

  it('keeps credentials on same-origin hops and drops them on cross-origin hops', async () => {
    const headers = { 'authorization': 'Bearer secret-token', 'cookie': 'a=b', 'x-keep': 'yes' }
    const same = await loopback(`${origin()}/redirect-same-origin`, { maxBytes: 4096, headers })
    expect(JSON.parse(decode(same.body))).toMatchObject({ 'authorization': 'Bearer secret-token', 'cookie': 'a=b', 'x-keep': 'yes' })
    const cross = await loopback(`${origin()}/redirect-cross-origin`, { maxBytes: 4096, headers })
    expect(cross.url).toBe(`http://other.test:${port}/headers`)
    const received = JSON.parse(decode(cross.body)) as Record<string, string>
    expect(received['x-keep']).toBe('yes')
    expect(received.authorization).toBeUndefined()
    expect(received.cookie).toBeUndefined()
  })
})

describe('limits', () => {
  it('fails with payload_too_large when Content-Length exceeds maxBytes', async () => {
    const error = await failure(loopback(`${origin()}/big-declared`, { maxBytes: 50 }))
    expect(error.code).toBe('payload_too_large')
    expect(error.details).toEqual({ limitBytes: 50 })
  })

  it('fails with payload_too_large when a chunked body grows over maxBytes', async () => {
    const error = await failure(loopback(`${origin()}/big-chunked`, { maxBytes: 100 }))
    expect(error.code).toBe('payload_too_large')
    expect(error.details).toEqual({ limitBytes: 100 })
    const exact = await loopback(`${origin()}/big-chunked`, { maxBytes: 120 })
    expect(exact.body.byteLength).toBe(120)
  })

  it('decodes gzip, deflate and brotli bodies', async () => {
    const read = async (path: string): Promise<string> => decode((await loopback(`${origin()}${path}`, { maxBytes: 1024 })).body)
    expect(await read('/gzip')).toBe('hello gzip')
    expect(await read('/deflate')).toBe('hello deflate')
    expect(await read('/br')).toBe('hello brotli')
    expect(seen[0]?.headers['accept-encoding']).toBe('gzip, deflate, br')
  })

  it('caps the decoded size of a compressed body (zip bomb)', async () => {
    const error = await failure(loopback(`${origin()}/gzip-bomb`, { maxBytes: 10_000 }))
    expect(error.code).toBe('payload_too_large')
    expect(error.details).toEqual({ limitBytes: 10_000 })
  })

  it('reports undecodable and unsupported encodings as provider errors', async () => {
    expect((await failure(loopback(`${origin()}/broken-gzip`, { maxBytes: 1024 }))).code).toBe('provider_error')
    expect((await failure(loopback(`${origin()}/weird-encoding`, { maxBytes: 1024 }))).code).toBe('provider_error')
  })

  it('times out as provider_unreachable', async () => {
    const started = Date.now()
    const error = await failure(loopback(`${origin()}/hang`, { maxBytes: 1024, timeoutMs: 150 }))
    expect(error.code).toBe('provider_unreachable')
    expect(error.message).toContain('timed out after 150 ms')
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('honors the caller signal (an abort is not a network failure)', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 50)
    await expect(loopback(`${origin()}/hang`, { maxBytes: 1024, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    const aborted = new AbortController()
    aborted.abort()
    await expect(loopback(`${origin()}/ok`, { maxBytes: 1024, signal: aborted.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })
})
