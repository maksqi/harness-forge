import type { OAuthMcpServer } from '../../mcp/__fixtures__/oauth-mcp-server.mjs'
// MCP resource routes (W14.2-T4, T5; API.md 5.39, ADR-061) with the OAuth MCP fixture on loopback: the list (ranked,
// mentions, `unavailable`, `truncated`), the attach of the text and image resources (201 `FileRef`), the 6 MiB resource
// (413 before any read), a `needs-auth` server (409), unknown servers, projects and resources (404), a disabled server
// (502), and the project scope through the fake project MCP manager (shadowing, the project's server answers).
import type { McpResourceInfo } from '../../mcp/types.ts'
import type { TestApp } from '../../testing/create-test-app.ts'
import type { FakeProjectMcpManager } from '../../testing/fake-project-mcp.ts'
import { Buffer } from 'node:buffer'
import { fileRefSchema, harnessErrorEnvelopeSchema, LIMITS, mcpResourceListSchema } from '@harness-forge/shared'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { LARGE_URI, PIXEL_PNG_BASE64, PIXEL_URI, README_TEXT, README_URI, startOAuthMcpServer } from '../../mcp/__fixtures__/oauth-mcp-server.mjs'
import { createTestApp } from '../../testing/create-test-app.ts'
import { rankResources, resourceEntry } from './mcp-resources.ts'

const PROJECT = 'prj_0123456789abcdef'

function json(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

async function errorOf(response: Response): Promise<{ status: number, code: string, details: unknown, message: string }> {
  const envelope = harnessErrorEnvelopeSchema.parse(await response.json())
  return { status: response.status, code: envelope.error.code, details: envelope.error.details, message: envelope.error.message }
}

function info(serverId: string, uri: string, name: string, fields: Partial<McpResourceInfo> = {}): McpResourceInfo {
  return { serverId, serverName: serverId, uri, name, title: null, description: null, mimeType: null, size: null, ...fields }
}

describe('mcp resource routes with the OAuth MCP fixture', () => {
  let open: OAuthMcpServer
  let locked: OAuthMcpServer
  let t: TestApp

  beforeAll(async () => {
    open = await startOAuthMcpServer({ toggles: { noAuth: true } })
    locked = await startOAuthMcpServer()
    t = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' }, mcpAuth: 'fake' })
    await t.deps.mcp.create({ id: 'fake', name: 'Fake', transport: { type: 'http', url: open.url } })
    await t.deps.mcp.create({ id: 'locked', name: 'Locked', transport: { type: 'http', url: locked.url } })
    await t.deps.mcp.create({ id: 'off', name: 'Off', enabled: false, transport: { type: 'http', url: open.url } })
    await vi.waitFor(async () => {
      expect((await t.deps.mcp.get('fake')).status).toBe('connected')
      expect((await t.deps.mcp.get('locked')).status).toBe('needs-auth')
    }, { timeout: 15_000, interval: 50 })
    await vi.waitFor(async () => expect((await t.deps.mcp.resources()).items).toHaveLength(3), { timeout: 10_000, interval: 50 })
  }, 30_000)

  afterAll(async () => {
    await t?.close()
    await open?.stop()
    await locked?.stop()
  })

  it('lists the resources of the connected servers with mentions and names the servers that are not connected', async () => {
    const response = await t.request('/api/mcp/resources')
    expect(response.status).toBe(200)
    const body = mcpResourceListSchema.parse(await response.json())
    expect(body.items.map(item => item.uri)).toEqual([README_URI, LARGE_URI, PIXEL_URI])
    expect(body.items[0]).toEqual({
      serverId: 'fake',
      serverName: 'Fake',
      scope: 'global',
      uri: README_URI,
      name: 'readme.md',
      title: 'Fixture notes',
      description: 'A small markdown note.',
      mimeType: 'text/markdown',
      size: Buffer.byteLength(README_TEXT),
      mention: `@fake:${README_URI}`,
    })
    expect(body.truncated).toBe(false)
    expect(body.unavailable).toEqual([{ serverId: 'locked', status: 'needs-auth' }])
  })

  it('ranks by the query and honors the limit', async () => {
    const pixel = mcpResourceListSchema.parse(await (await t.request('/api/mcp/resources?q=pixel')).json())
    expect(pixel.items[0]?.uri).toBe(PIXEL_URI)
    const notes = mcpResourceListSchema.parse(await (await t.request('/api/mcp/resources?q=notes&limit=1')).json())
    expect(notes.items).toHaveLength(1)
    expect(notes.truncated).toBe(true)
    const none = mcpResourceListSchema.parse(await (await t.request('/api/mcp/resources?q=zzzzqqq')).json())
    expect(none.items).toEqual([])
    expect(none.truncated).toBe(false)
  })

  it('answers an unknown project with 404', async () => {
    expect(await errorOf(await t.request(`/api/mcp/resources?projectId=${PROJECT}`))).toMatchObject({ status: 404, code: 'not_found' })
  })

  it('attaches the text resource as text/markdown and the image as image/png (201 FileRef)', async () => {
    open.resetCounters()
    const text = await t.request('/api/mcp/resources/attach', json({ serverId: 'fake', uri: README_URI }))
    expect(text.status).toBe(201)
    const textRef = fileRefSchema.parse(await text.json())
    expect(textRef).toMatchObject({ name: 'readme.md', mime: 'text/markdown', size: Buffer.byteLength(README_TEXT) })
    expect(Buffer.from((await t.deps.files.read(textRef.id)).data).toString('utf8')).toBe(README_TEXT)

    const image = await t.request('/api/mcp/resources/attach', json({ serverId: 'fake', uri: PIXEL_URI }))
    expect(image.status).toBe(201)
    const imageRef = fileRefSchema.parse(await image.json())
    expect(imageRef).toMatchObject({ name: 'pixel.png', mime: 'image/png', size: Buffer.from(PIXEL_PNG_BASE64, 'base64').byteLength })
    expect(open.counters().resourcesRead).toBe(2)
    // Resource contents are never logged; URIs never above `debug`.
    expect(t.logs.text()).not.toContain(README_TEXT)
    expect(t.logs.records.filter(record => record.level !== 'debug').map(record => JSON.stringify(record)).join('\n')).not.toContain('fixture://')
  })

  it('refuses the 6 MiB resource with 413 before reading it', async () => {
    open.resetCounters()
    const error = await errorOf(await t.request('/api/mcp/resources/attach', json({ serverId: 'fake', uri: LARGE_URI })))
    expect(error).toMatchObject({ status: 413, code: 'payload_too_large', details: { limitBytes: LIMITS.mcpResourceReadBytes } })
    expect(open.counters().resourcesRead).toBe(0)
  })

  it('answers 409 needs-auth, 404 for unknown servers and resources, 502 for a disabled server', async () => {
    expect(await errorOf(await t.request('/api/mcp/resources/attach', json({ serverId: 'locked', uri: README_URI }))))
      .toMatchObject({ status: 409, code: 'conflict', details: { reason: 'needs-auth' } })
    expect(await errorOf(await t.request('/api/mcp/resources/attach', json({ serverId: 'nope', uri: README_URI }))))
      .toMatchObject({ status: 404, code: 'not_found' })
    expect(await errorOf(await t.request('/api/mcp/resources/attach', json({ serverId: 'fake', uri: 'fixture://notes/missing.md' }))))
      .toMatchObject({ status: 404, code: 'not_found', message: 'The MCP server "Fake" has no such resource.' })
    expect(await errorOf(await t.request('/api/mcp/resources/attach', json({ serverId: 'off', uri: README_URI }))))
      .toMatchObject({ status: 502, code: 'provider_unreachable' })
    expect(await errorOf(await t.request('/api/mcp/resources/attach', json({ serverId: 'fake', uri: README_URI, projectId: PROJECT }))))
      .toMatchObject({ status: 404, code: 'not_found' })
  })
})

describe('mcp resource routes: the project scope (fake project MCP manager)', () => {
  let t: TestApp

  beforeAll(async () => {
    t = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' }, projectMcp: 'fake', mcpAuth: 'fake' })
    vi.spyOn(t.deps.mcp, 'resources').mockResolvedValue({
      items: [info('docs', 'docs://global/a.md', 'a.md'), info('wiki', 'wiki://page/home', 'home')],
      truncated: false,
      unavailable: [{ serverId: 'docs', status: 'error' }],
    })
    const fake = t.deps.projectMcp as FakeProjectMcpManager
    fake.resourceLists.set(PROJECT, {
      items: [info('docs', 'docs://project/b.md', 'b.md', { mimeType: 'text/markdown' })],
      truncated: true,
      unavailable: [{ serverId: 'vars', status: 'needs-variables' }],
      shadowed: new Set(['docs']),
    })
    fake.resourceContents.set(`${PROJECT}/docs/docs://project/b.md`, { contents: [{ uri: 'docs://project/b.md', mimeType: 'text/markdown', text: 'project b' }] })
  })

  afterAll(async () => {
    vi.restoreAllMocks()
    await t.close()
  })

  it('lists the project\'s servers with scope project and hides the global servers they shadow', async () => {
    const body = mcpResourceListSchema.parse(await (await t.request(`/api/mcp/resources?projectId=${PROJECT}`)).json())
    expect(body.items.map(item => `${item.scope}:${item.uri}`)).toEqual(['global:wiki://page/home', 'project:docs://project/b.md'])
    expect(body.unavailable).toEqual([{ serverId: 'vars', status: 'needs-variables' }])
    expect(body.truncated).toBe(true)
    const global = mcpResourceListSchema.parse(await (await t.request('/api/mcp/resources')).json())
    expect(global.items.map(item => item.uri)).toEqual(['docs://global/a.md', 'wiki://page/home'])
    expect(global.unavailable).toEqual([{ serverId: 'docs', status: 'error' }])
  })

  it('attaches from the project\'s server when the project has one, else from the global server', async () => {
    const fake = t.deps.projectMcp as FakeProjectMcpManager
    const readSpy = vi.spyOn(t.deps.mcp, 'readResource').mockResolvedValue({ contents: [{ uri: 'wiki://page/home', text: 'home page' }] } as never)
    const projectRef = fileRefSchema.parse(await (await t.request('/api/mcp/resources/attach', json({ serverId: 'docs', uri: 'docs://project/b.md', projectId: PROJECT }))).json())
    expect(projectRef).toMatchObject({ name: 'b.md', mime: 'text/markdown' })
    expect(fake.resourceCalls).toEqual([{ projectId: PROJECT, serverId: 'docs', target: 'docs://project/b.md' }])
    const globalRef = fileRefSchema.parse(await (await t.request('/api/mcp/resources/attach', json({ serverId: 'wiki', uri: 'wiki://page/home', projectId: PROJECT }))).json())
    expect(globalRef).toMatchObject({ name: 'home', mime: 'text/plain' })
    expect(readSpy).toHaveBeenCalledWith('wiki', 'wiki://page/home', expect.any(AbortSignal))
  })
})

describe('rankResources / resourceEntry', () => {
  const empty = { items: [], truncated: false, unavailable: [] }

  it('ranks by the best match of name, title and URI; the empty query keeps the order', () => {
    const global = { ...empty, items: [
      info('a', 'x://one/zeta.txt', 'zeta.txt'),
      info('a', 'x://two/notes.md', 'unrelated', { title: 'Release notes' }),
      info('b', 'x://three/notes.md', 'notes.md'),
    ] }
    expect(rankResources({ global, project: null }, '', 50).items.map(item => item.name)).toEqual(['zeta.txt', 'unrelated', 'notes.md'])
    expect(rankResources({ global, project: null }, 'notes', 50).items.map(item => item.name)).toEqual(['notes.md', 'unrelated'])
    expect(rankResources({ global, project: null }, 'notes', 1)).toMatchObject({ truncated: true })
  })

  it('builds the mention with the scheme in lower case and leaves out resources that cannot be mentioned', () => {
    expect(resourceEntry(info('fs', 'File:///a.md', 'a.md'), 'global')?.mention).toBe('@fs:file:///a.md')
    expect(resourceEntry(info('fs', 'x://a"b', 'quote'), 'global')).toBeNull()
    expect(resourceEntry(info('fs', 'x://a', 'a', { serverName: 's'.repeat(300) }), 'project')?.serverName).toHaveLength(256)
  })
})
