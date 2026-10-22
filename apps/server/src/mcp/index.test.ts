import type { MCPClient, MCPClientConfig } from '@ai-sdk/mcp'
import type { McpTestApp } from './__fixtures__/harness.ts'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { createMCPClient } from '@ai-sdk/mcp'
import { HarnessError, mcpServerSchema, mcpToolName } from '@harness-forge/shared'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { BUILTIN_PLUGINS } from '../builtin-plugins/index.ts'
import { mcpServers } from '../db/schema.ts'
import { createTestApp } from '../testing/create-test-app.ts'
import { createFakeElicitationBroker } from '../testing/fake-elicitations.ts'
import { createFakeMcpAuthService, fakeMcpAuthInfo, mcpAuthTargetKey } from '../testing/fake-mcp-auth.ts'
import { createRecordingEventBus } from '../testing/fakes.ts'
import {
  callTool,
  createMcpTestApp,
  echoStdio,
  LONG_TOOL_NAME,
  outputJson,
  outputText,
  processAlive,
  spyMcpCaches,
  startElicitServer,
  startHttpEchoServer,
  startSseEchoServer,
  startStatusServer,
  waitFor,
} from './__fixtures__/harness.ts'
import { HEADER_REJECTED_MESSAGE, mcpConfigError, NEEDS_AUTH_MESSAGE } from './errors.ts'
import { CORE_MCP_PLUGIN_ID, createMcpManagerCore, MCP_NO_ELICITATION_PROTOCOL } from './index.ts'

const SECRET = 'echo-secret-value-123456'

let app: McpTestApp | null = null

afterEach(async () => {
  await app?.close()
  app = null
})

async function open(options: Parameters<typeof createMcpTestApp>[0] = {}): Promise<McpTestApp> {
  app = await createMcpTestApp(options)
  return app
}

async function connected(h: McpTestApp, id: string) {
  return waitFor(async () => {
    const server = await h.t.deps.mcp.get(id)
    if (server.status === 'error')
      throw new Error(`MCP server ${id} failed: ${server.error?.message}`)
    return server.status === 'connected' ? server : null
  })
}

async function pidOf(h: McpTestApp, tool: string): Promise<number> {
  return outputJson<{ pid: number }>(await callTool(h.t, tool)).pid
}

describe('user stdio servers', () => {
  it('connects, registers the tools with their policies and calls them', async () => {
    const h = await open()
    const created = await h.t.deps.mcp.create({ id: 'echo', name: 'Echo', transport: echoStdio([], { ECHO_SECRET: SECRET }) })
    expect(mcpServerSchema.parse(created)).toMatchObject({ id: 'echo', pluginId: 'core-mcp', editable: true, enabled: true, policy: 'ask' })
    expect(created.transport).toMatchObject({ type: 'stdio', command: process.execPath, env: { ECHO_SECRET: { set: true, source: 'stored' } } })
    expect(JSON.stringify(created)).not.toContain(SECRET)

    const server = await connected(h, 'echo')
    expect(server.connectedAt).toEqual(expect.any(Number))
    expect(server.tools).toContain('mcp__echo__echo')

    const registry = h.t.deps.registry.tools
    expect(registry.get('mcp__echo__echo')).toMatchObject({ pluginId: 'core-mcp', mcpServerId: 'echo', title: 'Echo', definition: { policy: 'safe' } })
    expect(registry.get('mcp__echo__wipe')?.definition.policy).toBe('always')
    expect(registry.get('mcp__echo__plain')?.definition.policy).toBe('ask')
    expect(registry.get('mcp__echo__dotted_name')).toBeDefined()
    const long = mcpToolName('echo', LONG_TOOL_NAME)
    expect(long).toHaveLength(64)
    expect(long).toMatch(/^mcp__echo__long_x+_[\da-f]{8}$/)
    expect(outputText(await callTool(h.t, long))).toBe('long')

    expect(outputText(await callTool(h.t, 'mcp__echo__echo', { text: 'hello' }))).toBe('hello')
    expect(outputJson(await callTool(h.t, 'mcp__echo__env', { name: 'ECHO_SECRET' }))).toEqual({ value: SECRET })
    await expect(callTool(h.t, 'mcp__echo__fail')).rejects.toThrow('The echo server refused.')
  })

  it('never inherits HF_* variables; passes the declared env and runs in the core-mcp data directory', async () => {
    const h = await open()
    process.env.HF_MCP_TEST_LEAK = 'must-not-leak'
    try {
      await h.t.deps.mcp.create({ id: 'env-check', name: 'Env', transport: echoStdio([], { DECLARED: 'yes' }) })
      await connected(h, 'env-check')
      expect(outputJson(await callTool(h.t, 'mcp__env-check__env', { name: 'HF_MCP_TEST_LEAK' }))).toEqual({ value: null })
      expect(outputJson(await callTool(h.t, 'mcp__env-check__env', { name: 'DECLARED' }))).toEqual({ value: 'yes' })
      expect(outputJson<{ value: string | null }>(await callTool(h.t, 'mcp__env-check__env', { name: 'PATH' })).value).toBeTruthy()
      const { cwd } = outputJson<{ cwd: string }>(await callTool(h.t, 'mcp__env-check__cwd'))
      expect(cwd.endsWith('core-mcp')).toBe(true)
    }
    finally {
      delete process.env.HF_MCP_TEST_LEAK
    }
  })

  it('forwards stderr lines to the core-mcp plugin log', async () => {
    const h = await open()
    await h.t.deps.mcp.create({ id: 'noisy', name: 'Noisy', transport: echoStdio() })
    await connected(h, 'noisy')
    await callTool(h.t, 'mcp__noisy__stderr', { text: 'hello from stderr' })
    await waitFor(async () => (await h.t.deps.plugins.logs('core-mcp')).some(entry => entry.message === '[noisy] hello from stderr'))
  })

  it('disabling closes the client and the child, lists the tools offline, enabling reconnects', async () => {
    const h = await open()
    await h.t.deps.mcp.create({ id: 'echo', name: 'Echo', transport: echoStdio() })
    await connected(h, 'echo')
    const pid = await pidOf(h, 'mcp__echo__pid')
    expect(processAlive(pid)).toBe(true)

    const disabled = await h.t.deps.mcp.update('echo', { enabled: false })
    expect(disabled).toMatchObject({ enabled: false, status: 'disabled', tools: [], connectedAt: null })
    await waitFor(() => !processAlive(pid))
    expect(h.t.deps.registry.tools.get('mcp__echo__echo')).toBeUndefined()
    const offline = (await h.t.deps.tools.list()).filter(tool => tool.mcpServerId === 'echo')
    expect(offline.length).toBeGreaterThan(5)
    expect(offline.every(tool => !tool.available)).toBe(true)
    expect(offline.find(tool => tool.name === 'mcp__echo__echo')).toMatchObject({ policy: 'safe', pluginId: 'core-mcp' })

    await h.t.deps.mcp.update('echo', { enabled: true })
    await connected(h, 'echo')
    const again = await pidOf(h, 'mcp__echo__pid')
    expect(again).not.toBe(pid)
    expect((await h.t.deps.tools.list()).find(tool => tool.name === 'mcp__echo__echo')?.available).toBe(true)
  })

  it('applies a new server policy and a new transport by reconnecting', async () => {
    const h = await open()
    await h.t.deps.mcp.create({ id: 'echo', name: 'Echo', transport: echoStdio(['first']) })
    await connected(h, 'echo')
    expect(outputJson(await callTool(h.t, 'mcp__echo__args'))).toEqual({ args: ['first'] })

    await h.t.deps.mcp.update('echo', { policy: 'always', transport: echoStdio(['second']) })
    await waitFor(() => h.t.deps.registry.tools.get('mcp__echo__plain')?.definition.policy === 'always')
    await connected(h, 'echo')
    expect(outputJson(await callTool(h.t, 'mcp__echo__args'))).toEqual({ args: ['second'] })
    expect(h.t.deps.registry.tools.get('mcp__echo__echo')?.definition.policy).toBe('safe')
    expect(h.t.deps.registry.tools.get('mcp__echo__wipe')?.definition.policy).toBe('always')
  })

  it('keeps a stored env secret on null, removes missing keys and stores new values', async () => {
    const h = await open()
    await h.t.deps.mcp.create({ id: 'echo', name: 'Echo', transport: echoStdio([], { KEEP: 'keep-value-1234', DROP: 'drop-value-1234' }) })
    const updated = await h.t.deps.mcp.update('echo', { transport: { ...echoStdio(), env: { KEEP: null, ADDED: 'added-value-1234' } } })
    expect(Object.keys((updated.transport as { env: object }).env)).toEqual(['KEEP', 'ADDED'])
    const names = (await h.t.deps.secrets.list('mcp:echo')).map(entry => entry.name)
    expect(names).toEqual(['env.ADDED', 'env.KEEP'])
    await connected(h, 'echo')
    expect(outputJson(await callTool(h.t, 'mcp__echo__env', { name: 'KEEP' }))).toEqual({ value: 'keep-value-1234' })
    expect(outputJson(await callTool(h.t, 'mcp__echo__env', { name: 'DROP' }))).toEqual({ value: null })
  })

  it('removes a server: closes it, deletes its row, secrets and tools', async () => {
    const h = await open()
    await h.t.deps.mcp.create({ id: 'echo', name: 'Echo', transport: echoStdio([], { TOKEN: 'token-value-1234' }) })
    await connected(h, 'echo')
    const pid = await pidOf(h, 'mcp__echo__pid')
    await h.t.deps.mcp.remove('echo')
    await waitFor(() => !processAlive(pid))
    expect(h.t.deps.registry.tools.list().filter(tool => tool.mcpServerId === 'echo')).toEqual([])
    expect(await h.t.deps.secrets.list('mcp:echo')).toEqual([])
    expect(await h.t.deps.mcp.list()).toEqual([])
    await expect(h.t.deps.mcp.get('echo')).rejects.toMatchObject({ code: 'not_found' })
    await expect(h.t.deps.mcp.remove('echo')).rejects.toMatchObject({ code: 'not_found' })
    expect((await h.t.deps.tools.list()).filter(tool => tool.mcpServerId === 'echo')).toEqual([])
  })

  it('reconnects with backoff after the process exits', async () => {
    const h = await open()
    await h.t.deps.mcp.create({ id: 'echo', name: 'Echo', transport: echoStdio() })
    await connected(h, 'echo')
    const pid = await pidOf(h, 'mcp__echo__pid')
    await callTool(h.t, 'mcp__echo__exit')
    await waitFor(async () => (await h.t.deps.mcp.get('echo')).status === 'error' || !processAlive(pid))
    await waitFor(async () => {
      const server = await h.t.deps.mcp.get('echo')
      return server.status === 'connected' && !processAlive(pid)
    })
    expect(await pidOf(h, 'mcp__echo__pid')).not.toBe(pid)
    expect((await h.t.deps.plugins.logs('core-mcp')).some(entry => entry.message.includes('exited (code 3)'))).toBe(true)
  })

  it('reports a command that cannot start as an error and gives up after the retries', async () => {
    const h = await open({ manager: { retryDelaysMs: [10, 10] } })
    await h.t.deps.mcp.create({ id: 'missing', name: 'Missing', transport: { type: 'stdio', command: '/nonexistent/harness-forge-mcp-binary' } })
    const failed = await waitFor(async () => {
      const server = await h.t.deps.mcp.get('missing')
      return server.status === 'error' ? server : null
    })
    expect(failed.error).toMatchObject({ code: 'provider_unreachable' })
    expect(failed.error?.message).toContain('ENOENT')
    await waitFor(async () => (await h.t.deps.plugins.logs('core-mcp')).filter(entry => entry.message.includes('Connection failed')).length === 3)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect((await h.t.deps.plugins.logs('core-mcp')).filter(entry => entry.message.includes('Connection failed'))).toHaveLength(3)
  })

  it('does not retry when the core-mcp setting autoReconnect is off', async () => {
    const h = await open({ manager: { retryDelaysMs: [10, 10] } })
    await h.t.deps.plugins.updateSettings('core-mcp', { autoReconnect: false })
    await h.t.deps.mcp.create({ id: 'missing', name: 'Missing', transport: { type: 'stdio', command: '/nonexistent/harness-forge-mcp-binary' } })
    await waitFor(async () => (await h.t.deps.mcp.get('missing')).status === 'error')
    await new Promise(resolve => setTimeout(resolve, 100))
    const messages = (await h.t.deps.plugins.logs('core-mcp')).map(entry => entry.message)
    expect(messages.filter(message => message.includes('Connection failed'))).toHaveLength(1)
    expect(messages.some(message => message.includes('Reconnecting in'))).toBe(false)
  })

  it('reconnect(): not_found, conflict when disabled, the fresh state otherwise', async () => {
    const h = await open()
    await expect(h.t.deps.mcp.reconnect('nope')).rejects.toMatchObject({ code: 'not_found' })
    await h.t.deps.mcp.create({ id: 'off', name: 'Off', enabled: false, transport: echoStdio() })
    await expect(h.t.deps.mcp.reconnect('off')).rejects.toMatchObject({ code: 'conflict', details: { reason: 'disabled' } })
    await h.t.deps.mcp.create({ id: 'echo', name: 'Echo', transport: echoStdio() })
    await connected(h, 'echo')
    const pid = await pidOf(h, 'mcp__echo__pid')
    const server = await h.t.deps.mcp.reconnect('echo')
    expect(server.status).toBe('connected')
    expect(await pidOf(h, 'mcp__echo__pid')).not.toBe(pid)
    await waitFor(() => !processAlive(pid))
  })

  it('rejects duplicate ids and asks for fresh auth before storing a stdio server', async () => {
    const h = await open()
    await h.t.deps.mcp.create({ id: 'echo', name: 'Echo', enabled: false, transport: echoStdio() })
    await expect(h.t.deps.mcp.create({ id: 'echo', name: 'Again', transport: { type: 'http', url: 'https://mcp.example.com/mcp' } }))
      .rejects
      .toMatchObject({ code: 'conflict', details: { reason: 'exists' } })

    const stale = { requireFreshAuth: () => {
      throw new HarnessError({ code: 'forbidden', message: 'Confirm your password.', action: 'login' })
    } }
    await expect(h.t.deps.mcp.create({ id: 'fresh', name: 'Fresh', transport: echoStdio([], { A: 'value-1234' }) }, stale))
      .rejects
      .toMatchObject({ code: 'forbidden', action: 'login' })
    expect((await h.t.deps.mcp.list()).map(server => server.id)).toEqual(['echo'])
    expect(await h.t.deps.secrets.list('mcp:fresh')).toEqual([])

    // HTTP servers and non-transport edits never need it; changing a stdio transport does.
    await h.t.deps.mcp.create({ id: 'web', name: 'Web', enabled: false, transport: { type: 'http', url: 'https://mcp.example.com/mcp' } }, stale)
    await h.t.deps.mcp.update('echo', { name: 'Renamed', enabled: false }, stale)
    await h.t.deps.mcp.update('echo', { transport: echoStdio() }, stale)
    await expect(h.t.deps.mcp.update('echo', { transport: echoStdio(['changed']) }, stale)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(h.t.deps.mcp.update('web', { transport: echoStdio() }, stale)).rejects.toMatchObject({ code: 'forbidden' })
    expect((await h.t.deps.mcp.get('web')).transport.type).toBe('http')
  })

  it('follows core-mcp: disabling it closes and removes the user servers, enabling it restores them', async () => {
    const h = await open()
    await h.t.deps.mcp.create({ id: 'echo', name: 'Echo', transport: echoStdio() })
    await connected(h, 'echo')
    const pid = await pidOf(h, 'mcp__echo__pid')
    expect(h.t.deps.registry.contributions('core-mcp').mcpServers).toEqual(['echo'])

    await h.t.deps.plugins.disable('core-mcp')
    await waitFor(() => !processAlive(pid))
    expect(h.t.deps.registry.mcpServers.get('echo')).toBeUndefined()
    expect(await h.t.deps.mcp.get('echo')).toMatchObject({ status: 'disabled', enabled: true })
    expect((await h.t.deps.tools.list()).filter(tool => tool.mcpServerId === 'echo')).toEqual([])

    await h.t.deps.plugins.enable('core-mcp')
    await connected(h, 'echo')
    expect(h.t.deps.registry.contributions('core-mcp').mcpServers).toEqual(['echo'])
  })

  it('follows core-mcp in-process (no event-bus subscriber): a reload re-declares and reconnects the servers', async () => {
    const h = await open()
    expect(h.events.subscriberCount()).toBe(0)
    await h.t.deps.mcp.create({ id: 'echo', name: 'Echo', transport: echoStdio() })
    await connected(h, 'echo')
    const pid = await pidOf(h, 'mcp__echo__pid')

    expect((await h.t.deps.plugins.reload('core-mcp')).state).toBe('active')
    await waitFor(async () => (await pidOf(h, 'mcp__echo__pid')) !== pid)
    await waitFor(() => !processAlive(pid))
    expect((await connected(h, 'echo')).pluginId).toBe('core-mcp')
    expect(h.t.deps.registry.contributions('core-mcp').mcpServers).toEqual(['echo'])
    expect(h.events.subscriberCount()).toBe(0)
  })

  it('emits plugin.changed for core-mcp on connection changes', async () => {
    const h = await open()
    h.events.clear()
    await h.t.deps.mcp.create({ id: 'echo', name: 'Echo', transport: echoStdio() })
    await connected(h, 'echo')
    await waitFor(() => h.events.ofType('plugin.changed').some(event => event.data.id === 'core-mcp' && event.data.plugin?.contributions.tools.includes('mcp__echo__echo')))
  })

  it('stop() terminates the stdio children', async () => {
    const h = await open()
    await h.t.deps.mcp.create({ id: 'echo', name: 'Echo', transport: echoStdio() })
    await connected(h, 'echo')
    const pid = await pidOf(h, 'mcp__echo__pid')
    await h.t.deps.mcp.stop()
    expect(processAlive(pid)).toBe(false)
  })
})

describe('following core-mcp without host state notifications', () => {
  it('declares the servers at start() when core-mcp is active (a host without onStateChange)', async () => {
    const coreMcp = BUILTIN_PLUGINS.filter(plugin => plugin.id === CORE_MCP_PLUGIN_ID)
    const t = await createTestApp({
      start: false,
      builtins: coreMcp,
      overrides: { events: createRecordingEventBus() },
      factories: {
        // The manager sees a host without `onStateChange` (like the fakes of other test suites).
        mcp: deps => createMcpManagerCore(new Proxy(deps, {
          get: (target, key) => key === 'plugins'
            ? new Proxy(target.plugins, { get: (host, name) => (name === 'onStateChange' ? undefined : Reflect.get(host, name)) })
            : Reflect.get(target, key),
        }), { retryDelaysMs: [], eventDelayMs: 5 }),
      },
    })
    try {
      await t.deps.plugins.start()
      await t.deps.mcp.create({ id: 'later', name: 'Later', enabled: false, transport: { type: 'http', url: 'http://127.0.0.1:9/mcp' } })
      // Not followed yet: nothing declared before start().
      expect(t.deps.registry.mcpServers.get('later')).toBeUndefined()
      await t.deps.mcp.start()
      await waitFor(() => t.deps.registry.mcpServers.get('later')?.pluginId === CORE_MCP_PLUGIN_ID)
      expect(t.deps.registry.contributions(CORE_MCP_PLUGIN_ID).mcpServers).toEqual(['later'])
      expect((await t.deps.mcp.get('later')).status).toBe('disabled')
    }
    finally {
      await t.close()
    }
  })
})

describe('user http servers', () => {
  it('connects over Streamable HTTP with the stored headers and masks them in the DTO', async () => {
    const endpoint = await startHttpEchoServer()
    try {
      const h = await open()
      const created = await h.t.deps.mcp.create({
        id: 'remote',
        name: 'Remote',
        policy: 'always',
        transport: { type: 'http', url: endpoint.url, headers: { Authorization: `Bearer ${SECRET}` } },
      })
      expect(created.transport).toEqual({ type: 'http', url: endpoint.url, headers: { Authorization: { set: true, hint: expect.any(String), source: 'stored' } }, oauth: null })
      expect(JSON.stringify(created)).not.toContain(SECRET)
      await connected(h, 'remote')
      expect(h.t.deps.registry.tools.get('mcp__remote__plain')?.definition.policy).toBe('always')
      expect(outputText(await callTool(h.t, 'mcp__remote__echo', { text: 'over http' }))).toBe('over http')
      const { headers } = outputJson<{ headers: Record<string, string> }>(await callTool(h.t, 'mcp__remote__headers'))
      expect(headers.authorization).toBe(`Bearer ${SECRET}`)
      expect(endpoint.requests.every(request => request.authorization === `Bearer ${SECRET}`)).toBe(true)
      expect(JSON.stringify(await h.t.deps.mcp.list())).not.toContain(SECRET)
    }
    finally {
      await endpoint.close()
    }
  })

  it('connects over the legacy HTTP+SSE transport', async () => {
    const endpoint = await startSseEchoServer()
    try {
      const h = await open()
      await h.t.deps.mcp.create({ id: 'legacy', name: 'Legacy', transport: { type: 'sse', url: endpoint.url, headers: { 'X-Token': SECRET } } })
      const server = await connected(h, 'legacy')
      expect(server.transport.type).toBe('sse')
      expect(outputText(await callTool(h.t, 'mcp__legacy__echo', { text: 'over sse' }))).toBe('over sse')
      expect(endpoint.requests.some(request => request['x-token'] === SECRET)).toBe(true)
      await h.t.deps.mcp.update('legacy', { enabled: false })
      expect(h.t.deps.registry.tools.get('mcp__legacy__echo')).toBeUndefined()
    }
    finally {
      await endpoint.close()
    }
  })

  it('reports an unreachable server as provider_unreachable', async () => {
    const endpoint = await startHttpEchoServer()
    const url = endpoint.url
    await endpoint.close()
    const h = await open({ manager: { retryDelaysMs: [] } })
    await h.t.deps.mcp.create({ id: 'down', name: 'Down', transport: { type: 'http', url } })
    const server = await waitFor(async () => {
      const current = await h.t.deps.mcp.get('down')
      return current.status === 'error' ? current : null
    })
    expect(server.error).toMatchObject({ code: 'provider_unreachable' })
  })
})

// ---------- Phase 14 seams (C51) ----------

/** A dependency-free stdio server (written to a temp folder) with prompts and resources whose tool `notify` sends list_changed. */
const NOTIFY_SERVER = `
import process from 'node:process'
import { createInterface } from 'node:readline'
const send = message => process.stdout.write(JSON.stringify(message) + '\\n')
createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line)
  if (id === undefined || id === null)
    return
  if (method === 'initialize')
    return send({ jsonrpc: '2.0', id, result: { protocolVersion: params.protocolVersion, capabilities: { tools: {}, prompts: { listChanged: true }, resources: { listChanged: true } }, serverInfo: { name: 'notify', version: '1.0.0' } } })
  if (method === 'tools/list')
    return send({ jsonrpc: '2.0', id, result: { tools: [{ name: 'notify', inputSchema: { type: 'object', properties: {} } }] } })
  if (method === 'tools/call') {
    send({ jsonrpc: '2.0', method: 'notifications/prompts/list_changed' })
    send({ jsonrpc: '2.0', method: 'notifications/resources/list_changed' })
    return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'sent' }] } })
  }
  if (method === 'prompts/list')
    return send({ jsonrpc: '2.0', id, result: { prompts: [] } })
  if (method === 'resources/list')
    return send({ jsonrpc: '2.0', id, result: { resources: [] } })
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } })
}).on('close', () => process.exit(0))
`

async function statusOf(h: McpTestApp, id: string, status: string) {
  return waitFor(async () => {
    const server = await h.t.deps.mcp.get(id)
    return server.status === status ? server : null
  })
}

describe('phase 14: the transport configuration (C51-T1)', () => {
  it('gives http / sse transports without an Authorization header the connect-mode provider, never a fetch', async () => {
    const configs: MCPClientConfig[] = []
    const mcpAuth = createFakeMcpAuthService()
    const h = await open({
      overrides: { mcpAuth },
      manager: {
        retryDelaysMs: [],
        createClient: async (config) => {
          configs.push(config)
          throw mcpConfigError('The test stops here.')
        },
      },
    })
    await h.t.deps.mcp.create({ id: 'web', name: 'Web', transport: { type: 'http', url: 'http://127.0.0.1:9/mcp', headers: { 'X-Token': 'x-token-value-1234' } } })
    await h.t.deps.mcp.create({ id: 'legacy', name: 'Legacy', transport: { type: 'sse', url: 'http://127.0.0.1:9/sse' } })
    await h.t.deps.mcp.create({ id: 'keyed', name: 'Keyed', transport: { type: 'http', url: 'http://127.0.0.1:9/mcp', headers: { authorization: 'Bearer header-key-1234' } } })
    await waitFor(() => configs.length === 3)
    const byUrl = (type: string, header: boolean) => configs.find((config) => {
      const transport = config.transport as Record<string, unknown>
      return transport.type === type && 'headers' in transport && ('authorization' in (transport.headers as object)) === header
    })
    for (const config of [byUrl('http', false), byUrl('sse', false)]) {
      const transport = config?.transport as Record<string, unknown>
      expect(Object.keys(transport).sort()).toEqual(['authProvider', 'headers', 'redirect', 'type', 'url'])
      expect(transport.redirect).toBe('error')
      expect(transport).not.toHaveProperty('fetch')
      expect(typeof (transport.authProvider as { tokens?: unknown }).tokens).toBe('function')
      expect(config?.capabilities).toEqual({ elicitation: {} })
    }
    const keyed = byUrl('http', true)?.transport as Record<string, unknown>
    expect(Object.keys(keyed).sort()).toEqual(['headers', 'redirect', 'type', 'url'])
    expect(keyed.redirect).toBe('error')
    expect(mcpAuth.providers).toEqual(expect.arrayContaining([
      { target: { kind: 'global', serverId: 'web' }, mode: 'connect' },
      { target: { kind: 'global', serverId: 'legacy' }, mode: 'connect' },
    ]))
    expect(mcpAuth.providers.some(call => call.target.serverId === 'keyed')).toBe(false)
  })
})

describe('phase 14: needs-auth (C51-T2)', () => {
  it('a 401 is needs-auth after one connect attempt (no backoff retry, no tools); a reconnect tries once more', async () => {
    const endpoint = await startStatusServer(401)
    try {
      const h = await open({ manager: { retryDelaysMs: [20, 20, 20] } })
      await h.t.deps.mcp.create({ id: 'locked', name: 'Locked', transport: { type: 'http', url: endpoint.url } })
      const server = await statusOf(h, 'locked', 'needs-auth')
      expect(mcpServerSchema.parse(server)).toMatchObject({ status: 'needs-auth', error: { code: 'auth_invalid', status: 401, message: NEEDS_AUTH_MESSAGE }, tools: [], connectedAt: null, auth: null })
      expect(JSON.stringify(server)).not.toContain('secret-body-text')
      await new Promise(resolve => setTimeout(resolve, 300))
      expect(endpoint.methods.filter(method => method === 'initialize')).toHaveLength(1)
      const logs = (await h.t.deps.plugins.logs('core-mcp')).map(entry => entry.message)
      expect(logs.filter(message => message === '[locked] Needs a sign-in.')).toHaveLength(1)
      expect(logs.some(message => message.includes('Reconnecting in'))).toBe(false)
      expect(h.t.deps.registry.tools.list().filter(tool => tool.mcpServerId === 'locked')).toEqual([])
      expect(mcpInternalsStatus(h, 'locked')).toBe('needs-auth')

      const again = await h.t.deps.mcp.reconnect('locked')
      expect(again.status).toBe('needs-auth')
      expect(endpoint.methods.filter(method => method === 'initialize')).toHaveLength(2)
    }
    finally {
      await endpoint.close()
    }
  })

  it('a server with an Authorization header that answers 401 is needs-auth with the header message', async () => {
    const endpoint = await startStatusServer(401)
    try {
      const h = await open({ manager: { retryDelaysMs: [20, 20] } })
      await h.t.deps.mcp.create({ id: 'keyed', name: 'Keyed', transport: { type: 'http', url: endpoint.url, headers: { Authorization: 'Bearer wrong-key-1234' } } })
      const server = await statusOf(h, 'keyed', 'needs-auth')
      expect(server.error).toEqual({ code: 'auth_invalid', message: HEADER_REJECTED_MESSAGE, status: 401 })
      await new Promise(resolve => setTimeout(resolve, 200))
      expect(endpoint.methods.filter(method => method === 'initialize')).toHaveLength(1)
      // No OAuth discovery for a server with its own credentials.
      expect(endpoint.paths.some(path => path.startsWith('/.well-known/'))).toBe(false)
    }
    finally {
      await endpoint.close()
    }
  })

  it('a 500 is still an error that retries with backoff', async () => {
    const endpoint = await startStatusServer(500)
    try {
      const h = await open({ manager: { retryDelaysMs: [20, 20] } })
      await h.t.deps.mcp.create({ id: 'broken', name: 'Broken', transport: { type: 'http', url: endpoint.url } })
      await waitFor(() => endpoint.methods.filter(method => method === 'initialize').length === 3)
      const server = await statusOf(h, 'broken', 'error')
      expect(server.error).toMatchObject({ code: 'provider_error', status: 500 })
    }
    finally {
      await endpoint.close()
    }
  })
})

function mcpInternalsStatus(h: McpTestApp, id: string): unknown {
  return (h.t.deps.mcp as unknown as { serverStatus: (id: string) => unknown }).serverStatus(id)
}

describe('phase 14: the DTO decoration (C51-T3)', () => {
  it('a v1.8.1 row has oauth null and auth null; the row\'s oauth and the sign-in state are shown, never a secret', async () => {
    const endpoint = await startHttpEchoServer()
    try {
      const mcpAuth = createFakeMcpAuthService()
      const h = await open({ overrides: { mcpAuth } })
      const plain = await h.t.deps.mcp.create({ id: 'plain', name: 'Plain', transport: { type: 'http', url: endpoint.url } })
      expect(plain.transport).toEqual({ type: 'http', url: endpoint.url, headers: {}, oauth: null })
      expect(plain.auth).toBeNull()
      await connected(h, 'plain')

      await h.t.deps.mcp.create({ id: 'oauth', name: 'OAuth', enabled: false, transport: { type: 'http', url: endpoint.url } })
      await h.t.deps.db.update(mcpServers).set({ transport: { type: 'http', url: endpoint.url, headerNames: [], oauth: { clientId: 'client-1', scopes: 'read write' } } }).where(eq(mcpServers.id, 'oauth'))
      await h.t.deps.secrets.set('mcp:oauth', 'oauth.clientSecret', 'client-secret-value-1234')
      mcpAuth.infos.set(mcpAuthTargetKey({ kind: 'global', serverId: 'oauth' }), fakeMcpAuthInfo({ scope: 'read' }))
      const server = mcpServerSchema.parse(await h.t.deps.mcp.get('oauth'))
      expect(server.transport).toEqual({
        type: 'http',
        url: endpoint.url,
        headers: {},
        oauth: { clientId: 'client-1', clientSecret: { set: true, hint: expect.any(String), source: 'stored' }, scopes: 'read write' },
      })
      expect(server.auth).toEqual(fakeMcpAuthInfo({ scope: 'read' }))
      expect(JSON.stringify(await h.t.deps.mcp.list())).not.toContain('client-secret-value-1234')

      const stdio = await h.t.deps.mcp.create({ id: 'local', name: 'Local', enabled: false, transport: echoStdio() })
      expect(stdio.auth).toBeNull()
      expect(mcpAuth.calls.info).toBeGreaterThan(0)
    }
    finally {
      await endpoint.close()
    }
  })

  it('a plugin declaration shows its oauth as declared (no client secret)', async () => {
    const endpoint = await startHttpEchoServer()
    try {
      const h = await open({
        beforeStart: async (t) => {
          const { mkdirSync, writeFileSync } = await import('node:fs')
          const dir = join(t.env.paths.plugins, 'oauth-plugin')
          mkdirSync(dir, { recursive: true })
          writeFileSync(join(dir, 'plugin.json'), `${JSON.stringify({
            manifestVersion: 1,
            id: 'oauth-plugin',
            name: 'OAuth plugin',
            version: '1.0.0',
            engines: { harness: '^1.0.0' },
            settings: { type: 'object', properties: { clientId: { type: 'string', title: 'Client id' } } },
            contributes: { mcpServers: [{ id: 'oauth-plugin', name: 'Remote', transport: { type: 'http', url: endpoint.url, oauth: { clientId: '{{settings.clientId}}', scopes: 'read' } } }] },
          })}\n`)
          await t.deps.plugins.saveRecord({ id: 'oauth-plugin', source: 'copy', version: '1.0.0' })
        },
      })
      const server = mcpServerSchema.parse(await connected(h, 'oauth-plugin'))
      expect(server.transport).toMatchObject({ type: 'http', oauth: { clientId: '{{settings.clientId}}', clientSecret: { set: false, hint: null, source: null }, scopes: 'read' } })
      expect(server.auth).toBeNull()
      expect(h.t.deps.mcp.authTarget('oauth-plugin')).toEqual({ kind: 'plugin', scope: 'plugin:oauth-plugin', name: 'mcp-oauth.oauth-plugin' })
    }
    finally {
      await endpoint.close()
    }
  })

  it('authTarget: personal servers, unknown ids', async () => {
    const h = await open()
    await h.t.deps.mcp.create({ id: 'mine', name: 'Mine', enabled: false, transport: { type: 'http', url: 'http://127.0.0.1:9/mcp' } })
    expect(h.t.deps.mcp.authTarget('mine')).toEqual({ kind: 'user', scope: 'mcp:mine', name: 'oauth.record' })
    expect(h.t.deps.mcp.authTarget('nope')).toBeNull()
  })
})

describe('phase 14: elicitation (C51-T4)', () => {
  it('declares the capability and hands the server\'s request to the broker (the C50 stub declines it)', async () => {
    const endpoint = await startElicitServer()
    try {
      const h = await open()
      await h.t.deps.mcp.create({ id: 'elicit', name: 'Elicit', transport: { type: 'http', url: endpoint.url } })
      await connected(h, 'elicit')
      expect(JSON.parse(outputText(await callTool(h.t, 'mcp__elicit__ask')))).toEqual({ action: 'decline' })
    }
    finally {
      await endpoint.close()
    }
  })

  it('registers each call with the broker under the key of the client whose handler gets the request', async () => {
    const endpoint = await startElicitServer()
    try {
      const fake = createFakeElicitationBroker()
      const begun: Array<Parameters<typeof fake.begin>[0]> = []
      fake.handlerAnswer = { action: 'accept', content: { name: 'Ada' } }
      const h = await open({ overrides: { elicitations: { ...fake, begin: (call) => {
        begun.push(call)
        return fake.begin(call)
      } } } })
      await h.t.deps.mcp.create({ id: 'elicit', name: 'Elicit server', transport: { type: 'http', url: endpoint.url } })
      await connected(h, 'elicit')
      expect(JSON.parse(outputText(await callTool(h.t, 'mcp__elicit__ask')))).toEqual({ action: 'accept', content: { name: 'Ada' } })
      expect(fake.handled).toHaveLength(1)
      expect(fake.handled[0]?.request.params.message).toBe('Your name?')
      expect(fake.handled[0]?.runtimeKey).toMatch(/^mcp:elicit#\d+$/)
      expect(begun).toEqual([expect.objectContaining({ runtimeKey: fake.handled[0]?.runtimeKey, serverId: 'elicit', serverName: 'Elicit server', toolCallId: 'call_1', interactive: false })])
      expect(fake.inFlight).toEqual([])
    }
    finally {
      await endpoint.close()
    }
  })

  it(`reconnects once without the capability when a server negotiates ${MCP_NO_ELICITATION_PROTOCOL}, remembered until the declaration changes`, async () => {
    const configs: MCPClientConfig[] = []
    const createClient = async (config: MCPClientConfig): Promise<MCPClient> => {
      configs.push(config)
      const client = await createMCPClient({ ...config, experimental_events: undefined })
      if (config.capabilities?.elicitation === undefined)
        return client
      return new Proxy(client, {
        get: (target, key) => {
          if (key === 'initializeResult')
            return { ...target.initializeResult, protocolVersion: MCP_NO_ELICITATION_PROTOCOL }
          const value: unknown = Reflect.get(target, key)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    }
    const h = await open({ manager: { createClient } })
    await h.t.deps.mcp.create({ id: 'echo', name: 'Echo', transport: echoStdio() })
    await connected(h, 'echo')
    expect(configs.map(config => config.capabilities)).toEqual([{ elicitation: {} }, undefined])
    expect(outputText(await callTool(h.t, 'mcp__echo__echo', { text: 'still works' }))).toBe('still works')

    await h.t.deps.mcp.reconnect('echo')
    expect(configs.map(config => config.capabilities)).toEqual([{ elicitation: {} }, undefined, undefined])

    await h.t.deps.mcp.update('echo', { name: 'Echo 2' })
    await waitFor(() => configs.length === 5)
    expect(configs.slice(3).map(config => config.capabilities)).toEqual([{ elicitation: {} }, undefined])
    await connected(h, 'echo')
  })
})

describe('phase 14: prompts and resources (C51-T6)', () => {
  it('fills the caches of servers with the capabilities after connecting and lists through them', async () => {
    const endpoint = await startElicitServer()
    try {
      const caches = spyMcpCaches()
      const h = await open({ manager: { createPromptCache: caches.prompts, createResourceCache: caches.resources } })
      await h.t.deps.mcp.create({ id: 'elicit', name: 'Elicit', transport: { type: 'http', url: endpoint.url } })
      await h.t.deps.mcp.create({ id: 'echo', name: 'Echo', transport: echoStdio() })
      await h.t.deps.mcp.create({ id: 'off', name: 'Off', enabled: false, transport: echoStdio() })
      await connected(h, 'elicit')
      await connected(h, 'echo')
      await waitFor(() => caches.refreshed.length === 2)
      expect(caches.refreshed).toEqual(expect.arrayContaining([
        { kind: 'prompts', key: 'elicit', serverName: 'Elicit', projectId: null },
        { kind: 'resources', key: 'elicit', serverName: 'Elicit', projectId: null },
      ]))
      expect(await h.t.deps.mcp.prompts()).toEqual({ items: [], truncated: false, unavailable: [] })
      expect(await h.t.deps.mcp.resources()).toEqual({ items: [], truncated: false, unavailable: [] })
      const signal = new AbortController().signal
      await expect(h.t.deps.mcp.getPrompt('elicit', 'greet', {}, signal)).rejects.toMatchObject({ code: 'not_implemented' })
      await expect(h.t.deps.mcp.readResource('elicit', 'file:///a', signal)).rejects.toMatchObject({ code: 'not_implemented' })
      await expect(h.t.deps.mcp.getPrompt('echo', 'greet', {}, signal)).rejects.toMatchObject({ code: 'not_found' })
      await expect(h.t.deps.mcp.getPrompt('nope', 'greet', {}, signal)).rejects.toMatchObject({ code: 'not_found' })
      await expect(h.t.deps.mcp.getPrompt('off', 'greet', {}, signal)).rejects.toMatchObject({ code: 'provider_unreachable' })
      const aborted = new AbortController()
      aborted.abort(new Error('gone'))
      await expect(h.t.deps.mcp.readResource('elicit', 'file:///a', aborted.signal)).rejects.toThrow('gone')
    }
    finally {
      await endpoint.close()
    }
  })

  it('names servers that are not connected as unavailable and refuses requests to a needs-auth server', async () => {
    const endpoint = await startStatusServer(401)
    try {
      const h = await open({ manager: { retryDelaysMs: [] } })
      await h.t.deps.mcp.create({ id: 'locked', name: 'Locked', transport: { type: 'http', url: endpoint.url } })
      await statusOf(h, 'locked', 'needs-auth')
      expect(await h.t.deps.mcp.prompts()).toEqual({ items: [], truncated: false, unavailable: [{ serverId: 'locked', status: 'needs-auth' }] })
      expect((await h.t.deps.mcp.resources()).unavailable).toEqual([{ serverId: 'locked', status: 'needs-auth' }])
      await expect(h.t.deps.mcp.getPrompt('locked', 'greet', {}, new AbortController().signal)).rejects.toMatchObject({ code: 'conflict', details: { reason: 'needs-auth' } })
    }
    finally {
      await endpoint.close()
    }
  })

  it('refreshes the caches on a stdio prompts / resources list_changed notification', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'hf-mcp-notify-')))
    try {
      const script = join(dir, 'notify-server.mjs')
      await writeFile(script, NOTIFY_SERVER)
      const caches = spyMcpCaches()
      const h = await open({ manager: { createPromptCache: caches.prompts, createResourceCache: caches.resources } })
      await h.t.deps.mcp.create({ id: 'notify', name: 'Notify', transport: { type: 'stdio', command: process.execPath, args: [script] } })
      await connected(h, 'notify')
      await waitFor(() => caches.refreshed.length === 2)
      expect(outputText(await callTool(h.t, 'mcp__notify__notify'))).toBe('sent')
      await waitFor(() => caches.refreshed.length === 4)
      expect(caches.refreshed.map(entry => entry.kind).sort()).toEqual(['prompts', 'prompts', 'resources', 'resources'])
    }
    finally {
      await app?.close()
      app = null
      await rm(dir, { recursive: true, force: true })
    }
  })
})
