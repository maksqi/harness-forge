import type { PluginContext, ToolCallContext, ToolDefinition } from '@harness-forge/plugin-sdk'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { TestApp } from '../../testing/create-test-app.ts'
import { createServer } from 'node:http'
import { pluginManifestBaseSchema, settingsSchemaSchema } from '@harness-forge/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp } from '../../testing/create-test-app.ts'
import coreTools, { manifest, webFetchUserAgent } from './index.ts'

const context: ToolCallContext = {
  chatId: '0199a8f0-0000-7000-8000-000000000001',
  modelRef: 'mock:echo',
  toolCallId: 'call_1',
  messages: [],
  signal: new AbortController().signal,
}

describe('core-tools manifest', () => {
  it('is a valid builtin manifest with the allowLocalhost setting (off by default)', () => {
    const parsed = pluginManifestBaseSchema.parse(manifest)
    expect(parsed).toMatchObject({ id: 'core-tools', main: 'index.ts', permissions: ['network'] })
    expect(settingsSchemaSchema.parse(manifest.settings).properties.allowLocalhost).toMatchObject({ type: 'boolean', default: false })
  })

  it('builds a versioned User-Agent', () => {
    expect(webFetchUserAgent()).toMatch(/^harness-forge\/\d+\.\d+\.\d\S* web_fetch$/)
  })

  it('registers current_time, web_fetch and generate_image through ctx.tools.register', async () => {
    const tools: ToolDefinition[] = []
    const ctx = {
      tools: {
        register: (definition: ToolDefinition) => {
          tools.push(definition)
          return { dispose() {} }
        },
      },
      settings: { get: () => ({ allowLocalhost: false }) },
    } as unknown as PluginContext
    await coreTools.setup(ctx)
    expect(tools.map(tool => [tool.name, tool.policy])).toEqual([['current_time', 'safe'], ['web_fetch', 'ask'], ['generate_image', 'ask']])
  })
})

describe('core-tools in the plugin host', () => {
  let t: TestApp
  let server: Server
  let url: string

  beforeAll(async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<title>Local page</title><p>served locally</p>')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
    // Only this builtin, and only the plugin host: the other services of the boot are not needed here.
    t = await createTestApp({ builtins: [{ id: 'core-tools', manifest, module: coreTools }], start: false })
    await t.deps.plugins.start()
  })

  afterAll(async () => {
    await t.close()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  it('is active and contributes the three tools with their policies', async () => {
    expect(t.deps.plugins.state('core-tools')).toBe('active')
    expect(t.deps.registry.tools.get('current_time')).toMatchObject({ pluginId: 'core-tools', mcpServerId: null, definition: { policy: 'safe' } })
    expect(t.deps.registry.tools.get('web_fetch')).toMatchObject({ pluginId: 'core-tools', mcpServerId: null, definition: { policy: 'ask' } })
    expect(t.deps.registry.tools.get('generate_image')).toMatchObject({ pluginId: 'core-tools', mcpServerId: null, definition: { policy: 'ask', timeoutMs: 300_000 } })
    expect([...t.deps.registry.contributions('core-tools').tools].sort()).toEqual(['current_time', 'generate_image', 'web_fetch'])
    const time = await t.deps.registry.tools.get('current_time')!.definition.execute({ timezone: 'UTC' }, context)
    expect(time).toMatchObject({ timezone: 'UTC' })
  })

  it('exposes the allowLocalhost setting and applies it to web_fetch at call time', async () => {
    const settings = await t.deps.plugins.getSettings('core-tools')
    expect(settings.values).toEqual({ allowLocalhost: false })
    const webFetch = t.deps.registry.tools.get('web_fetch')!.definition
    await expect(webFetch.execute({ url }, context)).rejects.toMatchObject({ code: 'validation_error' })

    await t.deps.plugins.updateSettings('core-tools', { allowLocalhost: true })
    await expect(webFetch.execute({ url }, context)).resolves.toMatchObject({ title: 'Local page', text: 'served locally' })
    await expect(webFetch.execute({ url: 'http://10.1.2.3/' }, context)).rejects.toMatchObject({ code: 'validation_error' })

    await t.deps.plugins.updateSettings('core-tools', { allowLocalhost: false })
    await expect(webFetch.execute({ url }, context)).rejects.toMatchObject({ code: 'validation_error' })
  })
})
