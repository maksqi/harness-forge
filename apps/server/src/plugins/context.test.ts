import type { PluginManifest } from '@harness-forge/plugin-sdk'
import type { Database } from '../db/client.ts'
import type { PluginRuntime, PluginRuntimeServices } from './context.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../db/client.ts'
import { migrateDatabase } from '../db/migrate.ts'
import { createMemoryLogger } from '../logger.ts'
import { createRegistryCore } from '../registry/index.ts'
import { createRedactor } from '../security/redact.ts'
import { createMemorySecretStore } from '../testing/fakes.ts'
import { createPluginRuntime, HOST_AI } from './context.ts'
import { guardCall } from './guard.ts'
import { createPluginStorage } from './state.ts'

const databases: Database[] = []

function unusedModel(): never {
  throw new Error('unused')
}

afterEach(() => {
  for (const database of databases.splice(0))
    database.close()
})

const BASE_MANIFEST: PluginManifest = {
  manifestVersion: 1,
  id: 'ctx-test',
  name: 'Context test',
  version: '1.2.3',
  engines: { harness: '^1.0.0' },
  main: 'index.mjs',
  permissions: ['storage'],
  settings: { type: 'object', properties: { host: { type: 'string', title: 'Host' }, token: { type: 'string', title: 'Token', format: 'secret' } } },
}

interface Setup {
  runtime: PluginRuntime
  registry: ReturnType<typeof createRegistryCore>
  logs: Array<{ level: string, message: string, data?: unknown }>
  requests: Request[]
  secrets: ReturnType<typeof createMemorySecretStore>
  resolved: string[]
}

async function setup(manifest: PluginManifest = BASE_MANIFEST, settings: Record<string, unknown> = { host: 'example.com' }): Promise<Setup> {
  const database = await openDatabase({ path: ':memory:' })
  databases.push(database)
  await migrateDatabase(database.db)
  const logs: Setup['logs'] = []
  const requests: Request[] = []
  const resolved: string[] = []
  const secrets = createMemorySecretStore()
  const registry = createRegistryCore(() => ({
    logger: createMemoryLogger().logger,
    log: () => {},
    isRunnable: () => true,
    guard: (pluginId, fn, options) => guardCall({ log: () => {}, redactText: text => text, lifecycleSignal: () => undefined, isInactive: () => false }, pluginId, fn, options),
  }))
  const services: PluginRuntimeServices = {
    registry,
    secrets,
    storage: createPluginStorage(database.db, manifest.id),
    redactor: createRedactor(),
    log: (level, message, data) => void logs.push({ level, message, data }),
    resolveModel: async (ref) => {
      resolved.push(ref)
      return { specificationVersion: 'v4', provider: 'fake', modelId: ref } as never
    },
    userAgent: `harness-forge/0.0.0 plugin/${manifest.id}`,
    fetch: async (input, init) => {
      requests.push(new Request(input, init))
      return new Response('ok')
    },
  }
  const runtime = createPluginRuntime({ manifest, dir: '/plugins/ctx-test', dataDir: '/data/plugins/.data/ctx-test', settings, services })
  return { runtime, registry, logs, requests, secrets, resolved }
}

describe('plugin context', () => {
  it('exposes the plugin identity, host libraries and a frozen surface', async () => {
    const { runtime } = await setup()
    const { ctx } = runtime
    expect(ctx.plugin).toEqual({ id: 'ctx-test', version: '1.2.3', dir: '/plugins/ctx-test', dataDir: '/data/plugins/.data/ctx-test' })
    expect(Object.isFrozen(ctx)).toBe(true)
    expect(ctx.ai).toBe(HOST_AI)
    expect(typeof ctx.ai.z.object).toBe('function')
    expect(typeof ctx.ai.createGoogleGenerativeAI).toBe('function')
    expect(ctx.signal.aborted).toBe(false)
  })

  it('tracks registrations and removes all of them on dispose; later calls throw', async () => {
    const { runtime, registry } = await setup()
    const { ctx } = runtime
    ctx.providers.register({ id: 'ctx-test', name: 'Ctx', credentials: [], createLanguageModel: unusedModel })
    ctx.models.register('openai', [{ id: 'extra' }])
    const tool = ctx.tools.register({ name: 'ctx_tool', description: 'Tool', inputSchema: ctx.ai.z.object({}), execute: async () => 1 })
    ctx.commands.register({ name: 'ctx', description: 'Cmd', template: '{{input}}' })
    ctx.hooks.on('chat.headers', () => {})
    ctx.mcp.register({ id: 'ctx-test', name: 'Mcp', transport: { type: 'http', url: 'https://{{settings.host}}/mcp' } })
    expect(registry.contributions('ctx-test')).toMatchObject({ providers: ['ctx-test'], models: 1, tools: ['ctx_tool'], commands: ['ctx'], hooks: ['chat.headers'], mcpServers: ['ctx-test'] })
    tool.dispose()
    expect(registry.tools.get('ctx_tool')).toBeUndefined()

    runtime.disposeContributions()
    expect(registry.contributions('ctx-test')).toEqual({ providers: [], models: 0, tools: [], mcpServers: [], commands: [], hooks: [] })
    expect(runtime.isDisposed).toBe(true)
    expect(() => ctx.commands.register({ name: 'late', description: 'Late', template: 'x' })).toThrow(expect.objectContaining({ code: 'plugin_error' }))
    await expect(ctx.storage.get('x')).rejects.toMatchObject({ code: 'plugin_error' })
    runtime.abort()
    expect(ctx.signal.aborted).toBe(true)
  })

  it('surfaces registry errors (conflict, validation) to the plugin', async () => {
    const { runtime } = await setup()
    const { ctx } = runtime
    ctx.commands.register({ name: 'dup', description: 'One', template: 'x' })
    expect(() => ctx.commands.register({ name: 'dup', description: 'Two', template: 'x' })).toThrow(expect.objectContaining({ code: 'conflict' }))
    expect(() => ctx.providers.register({ id: 'other', name: 'x', credentials: [], createLanguageModel: unusedModel })).toThrow(/must be "ctx-test"/)
    expect(() => ctx.mcp.register({ id: 'ctx-test', name: 'x', transport: { type: 'http', url: 'https://x.example.com', headers: { A: '{{settings.missing}}' } } })).toThrow(/undefined setting/)
  })

  it('returns settings copies and runs onChange callbacks on update', async () => {
    const { runtime, registry } = await setup()
    const { ctx } = runtime
    const first = ctx.settings.get<{ host: string }>()
    first.host = 'mutated'
    expect(ctx.settings.get()).toEqual({ host: 'example.com' })
    const seen: unknown[] = []
    const subscription = ctx.settings.onChange(values => void seen.push(values))
    ctx.mcp.register({ id: 'ctx-test', name: 'Mcp', transport: { type: 'http', url: 'https://{{settings.host}}/mcp' } })
    const changes: string[] = []
    registry.onChange(change => changes.push(`${change.kind}:${change.action}`))
    await runtime.updateSettings({ host: 'new.example.com', token: 'secret' }, async (callback, values) => {
      await callback(values)
    })
    expect(seen).toEqual([{ host: 'new.example.com', token: 'secret' }])
    expect(ctx.settings.get()).toEqual({ host: 'new.example.com', token: 'secret' })
    expect(changes).toEqual(['mcpServer:removed', 'mcpServer:added'])
    subscription.dispose()
    await runtime.updateSettings({ host: 'x' }, async (callback, values) => {
      await callback(values)
    })
    expect(seen).toHaveLength(1)
  })

  it('keeps plugin secrets under plugin:<id> with kv. names and lists keys only', async () => {
    const { runtime, secrets, logs } = await setup()
    const { ctx } = runtime
    await ctx.secrets.set('oauth.token', 'refresh-token-value')
    await ctx.secrets.set('other', 'x')
    expect(await ctx.secrets.get('oauth.token')).toBe('refresh-token-value')
    expect(await secrets.get('plugin:ctx-test', 'kv.oauth.token')).toBe('refresh-token-value')
    expect(await ctx.secrets.list()).toEqual(['oauth.token', 'other'])
    expect(await ctx.secrets.list('oauth')).toEqual(['oauth.token'])
    await ctx.secrets.delete('other')
    expect(await ctx.secrets.get('other')).toBeUndefined()
    await expect(ctx.secrets.set('bad key', 'x')).rejects.toMatchObject({ code: 'validation_error' })
    await expect(ctx.secrets.set('big', 'x'.repeat(16_385))).rejects.toMatchObject({ code: 'payload_too_large' })
    // `secrets` is not declared in the manifest: one warning, once.
    expect(logs.filter(entry => entry.level === 'warn').map(entry => entry.message)).toEqual(['The plugin uses ctx.secrets without declaring the "secrets" permission in plugin.json.'])
  })

  it('stores JSON values in ctx.storage with limits', async () => {
    const { runtime, logs } = await setup()
    const { ctx } = runtime
    await ctx.storage.set('counter', 1)
    await ctx.storage.set('nested/key', { list: [1, 'two'], ok: true })
    expect(await ctx.storage.get('counter')).toBe(1)
    expect(await ctx.storage.get('nested/key')).toEqual({ list: [1, 'two'], ok: true })
    expect(await ctx.storage.get('missing')).toBeUndefined()
    expect(await ctx.storage.list()).toEqual(['counter', 'nested/key'])
    expect(await ctx.storage.list('nest')).toEqual(['nested/key'])
    await ctx.storage.delete('counter')
    expect(await ctx.storage.list()).toEqual(['nested/key'])
    await expect(ctx.storage.set('u', undefined)).rejects.toMatchObject({ code: 'validation_error' })
    await expect(ctx.storage.set('', 1)).rejects.toMatchObject({ code: 'validation_error' })
    await expect(ctx.storage.set('big', 'x'.repeat(262_145))).rejects.toMatchObject({ code: 'payload_too_large' })
    // `storage` is declared: no warning.
    expect(logs.filter(entry => entry.level === 'warn')).toEqual([])
  })

  it('fetches with the plugin signal and a default User-Agent; resolves models with the runtime signal', async () => {
    const { runtime, requests, logs } = await setup()
    const { ctx } = runtime
    await ctx.fetch('https://api.example.com/x', { headers: { 'x-custom': '1' } })
    await ctx.fetch(new Request('https://api.example.com/y', { headers: { 'user-agent': 'custom-agent' } }))
    expect(requests[0]?.headers.get('user-agent')).toBe('harness-forge/0.0.0 plugin/ctx-test')
    expect(requests[0]?.headers.get('x-custom')).toBe('1')
    expect(requests[1]?.headers.get('user-agent')).toBe('custom-agent')
    runtime.abort()
    expect(requests[0]?.signal.aborted).toBe(true)
    expect(logs.some(entry => entry.message.includes('"network" permission'))).toBe(true)
    const other = await setup()
    await other.runtime.ctx.models.resolve('openai:gpt-x')
    expect(other.resolved).toEqual(['openai:gpt-x'])
  })

  it('warns about undeclared hooks and stdio process permissions', async () => {
    const { runtime, logs } = await setup({ ...BASE_MANIFEST, permissions: [] })
    runtime.ctx.hooks.on('chat.params', () => {})
    runtime.ctx.mcp.register({ id: 'ctx-test', name: 'Local', transport: { type: 'stdio', command: 'node' } })
    expect(logs.map(entry => entry.message)).toEqual([
      'The plugin uses ctx.hooks without declaring the "hooks" permission in plugin.json.',
      'The plugin uses the stdio MCP server "ctx-test" without declaring the "process" permission in plugin.json.',
    ])
  })
})
