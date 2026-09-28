import type { TestApp } from '../testing/create-test-app.ts'
import type { McpTestApp } from './__fixtures__/harness.ts'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { mcpServerSchema } from '@harness-forge/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { callTool, createMcpTestApp, ECHO_SERVER_PATH, outputJson, processAlive, startHttpEchoServer, waitFor } from './__fixtures__/harness.ts'

const TOKEN = 'plugin-token-value-123456'

let app: McpTestApp | null = null

afterEach(async () => {
  await app?.close()
  app = null
})

function stdioPlugin(id: string, extra: { args?: string[], settings?: Record<string, unknown> } = {}) {
  return {
    manifestVersion: 1,
    id,
    name: `Plugin ${id}`,
    version: '1.0.0',
    engines: { harness: '^1.0.0' },
    permissions: ['process'],
    settings: {
      type: 'object',
      properties: {
        token: { type: 'string', format: 'secret', title: 'Token' },
        mode: { type: 'string', title: 'Mode', default: 'fast' },
        ...extra.settings,
      },
    },
    contributes: {
      mcpServers: [{
        id,
        name: 'Echo',
        policy: 'always',
        transport: {
          type: 'stdio',
          command: process.execPath,
          args: [ECHO_SERVER_PATH, ...(extra.args ?? ['--mode={{settings.mode}}'])],
          env: { ECHO_TOKEN: '{{settings.token}}', FIXED: 'fixed-value' },
        },
      }],
    },
  }
}

/** Writes `data/plugins/<id>/plugin.json` and pins its trust hash (stdio servers need trust). */
async function install(t: TestApp, manifest: Record<string, unknown>, trust = true): Promise<string> {
  const id = String(manifest.id)
  const dir = join(t.env.paths.plugins, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  const inspection = await t.deps.plugins.inspectDirectory(dir)
  await t.deps.plugins.saveRecord({ id, source: 'copy', version: '1.0.0', ...(trust ? { trustedHash: inspection.sha256 } : {}) })
  return dir
}

async function open(manifests: Record<string, unknown>[], options: { trust?: boolean } = {}): Promise<McpTestApp> {
  app = await createMcpTestApp({
    beforeStart: async (t) => {
      for (const manifest of manifests)
        await install(t, manifest, options.trust ?? true)
    },
  })
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

describe('plugin-declared MCP servers', () => {
  it('connects with templated args, omits env entries of empty settings and runs in the plugin directory', async () => {
    const h = await open([stdioPlugin('echo-plugin')])
    const server = await connected(h, 'echo-plugin')
    expect(mcpServerSchema.parse(server)).toMatchObject({
      pluginId: 'echo-plugin',
      editable: false,
      enabled: true,
      policy: 'always',
      transport: {
        type: 'stdio',
        args: [ECHO_SERVER_PATH, '--mode={{settings.mode}}'],
        env: { ECHO_TOKEN: { set: true, hint: null }, FIXED: { set: true, hint: null } },
      },
    })
    expect(outputJson(await callTool(h.t, 'mcp__echo-plugin__args'))).toEqual({ args: ['--mode=fast'] })
    expect(outputJson(await callTool(h.t, 'mcp__echo-plugin__env', { name: 'ECHO_TOKEN' }))).toEqual({ value: null })
    expect(outputJson(await callTool(h.t, 'mcp__echo-plugin__env', { name: 'FIXED' }))).toEqual({ value: 'fixed-value' })
    const { cwd } = outputJson<{ cwd: string }>(await callTool(h.t, 'mcp__echo-plugin__cwd'))
    expect(realpathSync(cwd)).toBe(realpathSync(join(h.t.env.paths.plugins, 'echo-plugin')))
    expect(h.t.deps.registry.tools.get('mcp__echo-plugin__plain')).toMatchObject({ pluginId: 'echo-plugin', definition: { policy: 'always' } })
    expect(h.t.deps.registry.tools.get('mcp__echo-plugin__echo')?.definition.policy).toBe('safe')
    expect(h.t.deps.registry.contributions('echo-plugin').tools).toContain('mcp__echo-plugin__echo')
  })

  it('reconnects with the new values after a settings change', async () => {
    const h = await open([stdioPlugin('echo-plugin')])
    await connected(h, 'echo-plugin')
    const { pid } = outputJson<{ pid: number }>(await callTool(h.t, 'mcp__echo-plugin__pid'))
    await h.t.deps.plugins.updateSettings('echo-plugin', { token: TOKEN, mode: 'slow' })
    await waitFor(async () => (await h.t.deps.mcp.get('echo-plugin')).status === 'connected' && !processAlive(pid))
    expect(outputJson(await callTool(h.t, 'mcp__echo-plugin__env', { name: 'ECHO_TOKEN' }))).toEqual({ value: TOKEN })
    expect(outputJson(await callTool(h.t, 'mcp__echo-plugin__args'))).toEqual({ args: ['--mode=slow'] })
    expect(JSON.stringify(await h.t.deps.mcp.list())).not.toContain(TOKEN)
  })

  it('is read-only here but can be reconnected', async () => {
    const h = await open([stdioPlugin('echo-plugin')])
    await connected(h, 'echo-plugin')
    await expect(h.t.deps.mcp.update('echo-plugin', { name: 'x' })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(h.t.deps.mcp.remove('echo-plugin')).rejects.toMatchObject({ code: 'forbidden' })
    await expect(h.t.deps.mcp.create({ id: 'echo-plugin', name: 'Mine', transport: { type: 'http', url: 'https://mcp.example.com/mcp' } }))
      .rejects
      .toMatchObject({ code: 'conflict', details: { reason: 'exists' } })
    expect((await h.t.deps.mcp.reconnect('echo-plugin')).status).toBe('connected')
    expect((await h.t.deps.mcp.list()).map(server => server.id)).toEqual(['echo-plugin'])
  })

  it('closes the client and removes every tool when the plugin is disabled', async () => {
    const h = await open([stdioPlugin('echo-plugin')])
    await connected(h, 'echo-plugin')
    const { pid } = outputJson<{ pid: number }>(await callTool(h.t, 'mcp__echo-plugin__pid'))
    await h.t.deps.plugins.disable('echo-plugin')
    await waitFor(() => !processAlive(pid))
    expect(h.t.deps.registry.tools.list().filter(tool => tool.pluginId === 'echo-plugin')).toEqual([])
    expect((await h.t.deps.tools.list()).filter(tool => tool.pluginId === 'echo-plugin')).toEqual([])
    expect(await h.t.deps.mcp.list()).toEqual([])
    await expect(h.t.deps.mcp.get('echo-plugin')).rejects.toMatchObject({ code: 'not_found' })

    await h.t.deps.plugins.enable('echo-plugin')
    await connected(h, 'echo-plugin')
  })

  it('fails with a message naming a missing setting and does not retry', async () => {
    const manifest = stdioPlugin('strict-plugin', {
      args: ['--key={{settings.required}}'],
      settings: { required: { type: 'string', title: 'Required' } },
    })
    const h = await open([manifest])
    const server = await waitFor(async () => {
      const current = await h.t.deps.mcp.get('strict-plugin')
      return current.status === 'error' ? current : null
    })
    expect(server.error).toMatchObject({ code: 'validation_error' })
    expect(server.error?.message).toContain('"required"')
    await new Promise(resolve => setTimeout(resolve, 150))
    expect((await h.t.deps.plugins.logs('strict-plugin')).filter(entry => entry.message.includes('Connection failed'))).toHaveLength(1)
  })

  it('never starts the stdio server of an untrusted plugin', async () => {
    const h = await open([stdioPlugin('echo-plugin')], { trust: false })
    expect(h.t.deps.plugins.state('echo-plugin')).toBe('untrusted')
    expect(await h.t.deps.mcp.list()).toEqual([])
  })

  it('templates the URL and headers of an HTTP server; an empty setting omits its header', async () => {
    const endpoint = await startHttpEchoServer()
    try {
      const origin = endpoint.url.replace(/\/mcp$/, '')
      const h = await open([{
        manifestVersion: 1,
        id: 'remote-plugin',
        name: 'Remote plugin',
        version: '1.0.0',
        engines: { harness: '^1.0.0' },
        settings: {
          type: 'object',
          properties: {
            path: { type: 'string', title: 'Path', default: 'mcp' },
            token: { type: 'string', format: 'secret', title: 'Token' },
          },
        },
        contributes: {
          mcpServers: [{
            id: 'remote-plugin',
            name: 'Remote',
            transport: { type: 'http', url: `${origin}/{{settings.path}}`, headers: { 'Authorization': 'Bearer {{settings.token}}', 'X-Static': 'static' } },
          }],
        },
      }])
      await connected(h, 'remote-plugin')
      let headers = outputJson<{ headers: Record<string, string> }>(await callTool(h.t, 'mcp__remote-plugin__headers')).headers
      expect(headers.authorization).toBeUndefined()
      expect(headers['x-static']).toBe('static')

      await h.t.deps.plugins.updateSettings('remote-plugin', { token: TOKEN })
      await waitFor(async () => {
        const server = await h.t.deps.mcp.get('remote-plugin')
        if (server.status !== 'connected')
          return false
        headers = outputJson<{ headers: Record<string, string> }>(await callTool(h.t, 'mcp__remote-plugin__headers')).headers
        return headers.authorization === `Bearer ${TOKEN}`
      })
    }
    finally {
      await endpoint.close()
    }
  })
})
