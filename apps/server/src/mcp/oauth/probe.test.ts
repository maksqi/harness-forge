// The pre-sign-in probe (W14.1-T4): one unauthenticated request to the MCP URL only, `redirect: 'error'`, the
// `WWW-Authenticate` parameters, an SSE answer cut after its headers, and the timeout. Loopback servers only.
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { probeMcpServer, readBearerChallenge } from './probe.ts'

interface Seen {
  method: string
  path: string
  headers: IncomingMessage['headers']
  body: string
}

const servers: Server[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

async function serve(handler: (req: IncomingMessage, res: ServerResponse, seen: Seen) => void): Promise<{ url: string, seen: Seen[] }> {
  const seen: Seen[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      body += chunk
    })
    req.on('end', () => {
      const entry = { method: req.method ?? '', path: req.url ?? '', headers: req.headers, body }
      seen.push(entry)
      handler(req, res, entry)
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}/mcp`, seen }
}

describe('readBearerChallenge', () => {
  it('reads resource_metadata and scope of a Bearer challenge only', () => {
    expect(readBearerChallenge('Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp", scope="mcp:read mcp:write"')).toEqual({
      resourceMetadataUrl: new URL('https://mcp.example.com/.well-known/oauth-protected-resource/mcp'),
      scope: 'mcp:read mcp:write',
    })
    expect(readBearerChallenge('Bearer realm="mcp"')).toEqual({})
    expect(readBearerChallenge('Basic realm="x", resource_metadata="https://x.example.com/"')).toEqual({})
    expect(readBearerChallenge('Bearer resource_metadata="not a url"')).toEqual({})
    expect(readBearerChallenge(null)).toEqual({})
  })
})

describe('probeMcpServer', () => {
  it('sends one unauthenticated initialize POST and reads the 401 challenge', async () => {
    const endpoint = await serve((_req, res) => {
      res.writeHead(401, { 'www-authenticate': 'Bearer resource_metadata="http://127.0.0.1:1/.well-known/oauth-protected-resource/mcp", scope="mcp:read"' }).end('no')
    })
    const result = await probeMcpServer('http', endpoint.url, { 'X-Team': 'blue' })
    expect(result).toEqual({ status: 401, unauthorized: true, resourceMetadataUrl: new URL('http://127.0.0.1:1/.well-known/oauth-protected-resource/mcp'), scope: 'mcp:read' })
    expect(endpoint.seen).toHaveLength(1)
    const [request] = endpoint.seen
    expect(request).toMatchObject({ method: 'POST', path: '/mcp' })
    expect(request?.headers.authorization).toBeUndefined()
    expect(request?.headers['x-team']).toBe('blue')
    expect(JSON.parse(request?.body ?? '{}')).toMatchObject({ jsonrpc: '2.0', method: 'initialize' })
  })

  it('a 401 without OAuth metadata has no challenge parameters', async () => {
    const endpoint = await serve((_req, res) => {
      res.writeHead(401, { 'www-authenticate': 'Bearer realm="mcp"' }).end()
    })
    expect(await probeMcpServer('http', endpoint.url, {})).toEqual({ status: 401, unauthorized: true })
  })

  it('an SSE server is probed with its event-stream GET; an open stream answer does not hold the probe', async () => {
    const endpoint = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('event: endpoint\ndata: /messages\n\n')
    })
    const result = await probeMcpServer('sse', endpoint.url.replace('/mcp', '/sse'), {})
    expect(result).toEqual({ status: 200, unauthorized: false })
    expect(endpoint.seen[0]).toMatchObject({ method: 'GET', path: '/sse' })
  })

  it('never follows a redirect', async () => {
    const endpoint = await serve((_req, res) => {
      res.writeHead(302, { location: 'http://127.0.0.1:1/elsewhere' }).end()
    })
    await expect(probeMcpServer('http', endpoint.url, {})).rejects.toThrow()
    expect(endpoint.seen).toHaveLength(1)
  })

  it('gives up after its timeout', async () => {
    const endpoint = await serve(() => {})
    await expect(probeMcpServer('http', endpoint.url, {}, { timeoutMs: 100 })).rejects.toThrow()
  })
})
