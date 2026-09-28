import type { McpTestApp } from './__fixtures__/harness.ts'
import process from 'node:process'
import { HarnessError, mcpServerSchema, mcpToolName } from '@harness-forge/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { BUILTIN_PLUGINS } from '../builtin-plugins/index.ts'
import { createTestApp } from '../testing/create-test-app.ts'
import { createRecordingEventBus } from '../testing/fakes.ts'
import {
  callTool,
  createMcpTestApp,
  echoStdio,
  LONG_TOOL_NAME,
  outputJson,
  outputText,
  processAlive,
  startHttpEchoServer,
  startSseEchoServer,
  waitFor,
} from './__fixtures__/harness.ts'
import { CORE_MCP_PLUGIN_ID, createMcpManagerCore } from './index.ts'

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
      expect(created.transport).toEqual({ type: 'http', url: endpoint.url, headers: { Authorization: { set: true, hint: expect.any(String), source: 'stored' } } })
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
