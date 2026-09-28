import type { PluginDetail } from '@harness-forge/shared'
import type { PluginTestApp } from './__fixtures__/harness.ts'
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { pluginDetailSchema, pluginSummarySchema } from '@harness-forge/shared'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getBuiltinPlugins } from '../builtin-plugins/index.ts'
import { pluginKv, plugins, providerConfigs } from '../db/schema.ts'
import { createPluginTestApp, fixturePath, manifest, removeTempDirs, tempDir, waitFor, writeFiles } from './__fixtures__/harness.ts'
import { pathPin } from './loader.ts'

const apps: PluginTestApp[] = []

async function app(options: Parameters<typeof createPluginTestApp>[0] = {}): Promise<PluginTestApp> {
  const created = await createPluginTestApp(options)
  apps.push(created)
  return created
}

afterEach(async () => {
  vi.useRealTimers()
  for (const created of apps.splice(0))
    await created.close()
  removeTempDirs()
})

async function detail(h: PluginTestApp, id: string): Promise<PluginDetail> {
  return pluginDetailSchema.parse(await h.t.deps.plugins.get(id))
}

describe('loading and states', () => {
  it('loads every fixture into its documented state; a broken plugin never blocks the others', async () => {
    const h = await app({
      plugins: [
        { fixture: 'acme-docs' },
        { fixture: 'dice-roller', trust: true },
        { fixture: 'word-count', trust: true },
        { fixture: 'throwing-setup', trust: true },
        { fixture: 'incompatible-api' },
        { fixture: 'stdio-server' },
        { fixture: 'broken-import', trust: true },
        { fixture: 'dice-roller', id: 'untrusted-dice' },
      ],
    })
    const { plugins: host } = h.t.deps
    const states = Object.fromEntries((await host.list()).map(plugin => [plugin.id, plugin.state]))
    expect(states).toEqual({
      'acme-docs': 'active',
      'broken-import': 'error',
      'dice-roller': 'active',
      'incompatible-api': 'incompatible',
      'stdio-server': 'untrusted',
      'throwing-setup': 'error',
      'untrusted-dice': 'error',
      'word-count': 'active',
    })
    // The copy under another folder name fails the "directory name equals id" check.
    expect((await host.get('untrusted-dice')).lastError?.message).toMatch(/does not match the directory name/)
    expect((await host.get('throwing-setup')).lastError).toMatchObject({ code: 'plugin_error', message: 'boom from setup', details: { pluginId: 'throwing-setup', phase: 'setup' } })
    // Registrations made before setup failed are removed.
    expect(h.t.deps.registry.commands.get('never-kept')).toBeUndefined()
    const broken = await host.get('broken-import')
    expect(broken.lastError?.message).toMatch(/use ctx\.ai\.z instead/)
    expect(broken.lastError?.details).toMatchObject({ phase: 'build' })
    for (const plugin of await host.list())
      pluginSummarySchema.parse(plugin)
    for (const plugin of await host.list())
      pluginDetailSchema.parse(await host.get(plugin.id))
  })

  it('registers declarative contributions through the registry', async () => {
    const h = await app({ plugins: [{ fixture: 'acme-docs' }] })
    const dataDir = join(h.t.env.paths.pluginData, 'acme-docs')
    expect(existsSync(dataDir)).toBe(true)
    if (process.platform !== 'win32')
      expect(statSync(dataDir).mode & 0o777).toBe(0o700)
    const { registry, plugins: host } = h.t.deps
    const provider = registry.providers.get('acme-docs')
    expect(provider).toMatchObject({ pluginId: 'acme-docs', definition: { id: 'acme-docs', name: 'Acme', smallModelId: 'acme-small', keyUrl: 'https://example.com/keys' } })
    expect(registry.models.list('acme-docs')[0]?.models.map(model => model.id)).toEqual(['acme-large', 'acme-small'])
    expect(registry.commands.get('acme')?.definition.template).toContain('{{input}}')
    expect(registry.mcpServers.get('acme-docs')?.decl.transport).toMatchObject({ type: 'http' })
    const summary = await host.summary('acme-docs')
    expect(summary.contributions).toEqual({ providers: ['acme-docs'], models: 3, tools: [], mcpServers: ['acme-docs'], commands: ['acme'], hooks: [] })
    expect(summary).toMatchObject({ kind: 'declarative', runsCode: false, source: 'copy', builtin: false, removable: true, enabled: true })
    expect(summary.icon?.color).toMatch(/^\/api\/plugins\/acme-docs\/icon\?v=[\da-f]{8}$/)
    const view = await detail(h, 'acme-docs')
    expect(view).toMatchObject({ editable: true, hasSettings: true, trust: { required: false, trusted: true } })
    expect(view.trust.hash).toMatch(/^[\da-f]{64}$/)
  })

  it('loads code plugins (.mjs and compiled .ts) with their contributions', async () => {
    const h = await app({ plugins: [{ fixture: 'dice-roller', trust: true }, { fixture: 'word-count', trust: true }] })
    const { registry, plugins: host } = h.t.deps
    expect(registry.tools.get('roll_dice')?.pluginId).toBe('dice-roller')
    expect(registry.tools.get('word_count')?.pluginId).toBe('word-count')
    const result = await registry.tools.get('word_count')?.definition.execute({ text: 'one two  three' }, {} as never)
    expect(result).toEqual({ words: 3 })
    expect((await host.summary('dice-roller')).contributions).toMatchObject({ tools: ['roll_dice'], commands: ['roll'], hooks: ['chat.params'] })
    const output = { instructions: 'Be brief.', maxSteps: 20, providerOptions: {} }
    await registry.hooks.run('chat.params', { chatId: 'c', modelRef: 'mock:echo', model: { id: 'echo' }, reasoningEffort: 'auto', toolMode: 'ask' }, output)
    expect(output.instructions).toBe('Be brief.\nDice are available.')
    const logs = await host.logs('word-count')
    expect(logs.map(entry => entry.message)).toEqual(expect.arrayContaining(['word count ready (plugin API 1.0.0)']))
    const compiled = join(h.t.env.paths.pluginCache, 'word-count')
    expect(existsSync(compiled)).toBe(true)
    // Build output never lands inside the plugin directory.
    expect(existsSync(join(h.pluginDir('word-count'), 'src', 'index.mjs'))).toBe(false)
    expect((await detail(h, 'dice-roller'))).toMatchObject({ kind: 'code', runsCode: true, trust: { required: true, trusted: true } })
  })

  it('reports invalid, mismatched, reserved and escaping plugins as errors', async () => {
    const outside = tempDir()
    writeFileSync(join(outside, 'evil.mjs'), 'export default { setup() {} }\n')
    const h = await app({ start: false })
    await h.install({ id: 'bad-json', files: { 'plugin.json': '{ "manifestVersion": 1, ' } })
    await h.install({ id: 'bad-schema', files: { 'plugin.json': manifest('bad-schema', { name: '', unknownKey: true }) } })
    await h.install({ id: 'openai', files: { 'plugin.json': manifest('openai') } })
    await h.install({ id: 'escape', files: { 'plugin.json': manifest('escape', { main: 'link.mjs' }) } })
    symlinkSync(join(outside, 'evil.mjs'), join(h.pluginDir('escape'), 'link.mjs'))
    await h.install({ id: 'no-icon', files: { 'plugin.json': manifest('no-icon', { icon: 'missing.svg' }) } })
    mkdirSync(join(h.pluginsDir, 'Not A Plugin'))
    mkdirSync(join(h.pluginsDir, '.hidden'))
    await h.t.deps.plugins.start()

    const host = h.t.deps.plugins
    const byId = Object.fromEntries((await host.list()).map(plugin => [plugin.id, plugin]))
    expect(Object.keys(byId).sort()).toEqual(['bad-json', 'bad-schema', 'escape', 'no-icon', 'openai'])
    for (const id of Object.keys(byId))
      expect(byId[id]?.state, id).toBe('error')
    expect(byId['bad-json']?.lastError?.message).toMatch(/not valid JSON/)
    expect(byId['bad-schema']?.lastError?.message).toMatch(/Invalid plugin\.json/)
    expect(byId['bad-schema']?.lastError?.details).toMatchObject({ issues: expect.any(Array) })
    expect(byId.openai?.lastError?.message).toMatch(/reserved/)
    expect(byId.escape?.lastError?.message).toMatch(/outside the plugin directory/)
    expect(byId['no-icon']?.lastError?.message).toMatch(/icon/)
    // Plugins whose manifest failed still have a DTO manifest that satisfies the schema.
    const badJson = await detail(h, 'bad-json')
    expect(badJson.manifest).toMatchObject({ id: 'bad-json', name: 'bad-json', version: '0.0.0' })
  })

  it('reports a manifest written for a newer plugin API as incompatible, not invalid', async () => {
    const h = await app({ plugins: [{ fixture: 'incompatible-api' }] })
    const plugin = await detail(h, 'incompatible-api')
    expect(plugin.state).toBe('incompatible')
    expect(plugin.lastError?.message).toMatch(/needs plugin API \^2\.0\.0/)
    expect(plugin.manifest).toMatchObject({ id: 'incompatible-api', name: 'Needs plugin API 2', version: '2.0.0', engines: { harness: '^2.0.0' } })
  })

  it('keeps code and stdio plugins untrusted until their hash is pinned, then loads them on trust', async () => {
    const h = await app({ plugins: [{ fixture: 'dice-roller' }, { fixture: 'stdio-server' }] })
    const host = h.t.deps.plugins
    expect(host.state('dice-roller')).toBe('untrusted')
    expect(h.t.deps.registry.tools.get('roll_dice')).toBeUndefined()
    const before = await detail(h, 'dice-roller')
    expect(before.trust).toMatchObject({ required: true, trusted: false, trustedHash: null })

    await expect(host.trust('dice-roller', '0'.repeat(64))).rejects.toMatchObject({ code: 'conflict', details: { reason: 'stale' } })
    const trusted = await host.trust('dice-roller', before.trust.hash as string)
    expect(trusted).toMatchObject({ state: 'active', trust: { trusted: true, trustedHash: before.trust.hash } })

    const stdio = await detail(h, 'stdio-server')
    expect(stdio).toMatchObject({ state: 'untrusted', runsCode: true, trust: { required: true } })
    await host.trust('stdio-server', stdio.trust.hash as string)
    expect(host.state('stdio-server')).toBe('active')
    expect(h.t.deps.registry.mcpServers.get('stdio-server')?.decl.transport.type).toBe('stdio')

    // Changing a pinned file on disk makes the plugin untrusted at the next load.
    writeFileSync(join(h.pluginDir('dice-roller'), 'index.mjs'), `${readFileSync(join(fixturePath('dice-roller'), 'index.mjs'), 'utf8')}\n// edited\n`)
    const reloaded = await host.reload('dice-roller')
    expect(reloaded.state).toBe('untrusted')
    expect(h.t.deps.registry.tools.get('roll_dice')).toBeUndefined()
  })

  it('skips a declarative command that collides with a builtin command, and fails a colliding provider', async () => {
    const h = await app({
      builtins: getBuiltinPlugins({ mockProvider: false }),
      plugins: [
        {
          id: 'cmd-clash',
          files: { 'plugin.json': manifest('cmd-clash', { contributes: { commands: [{ name: 'explain', description: 'Mine', template: 'x {{input}}' }, { name: 'mine', description: 'Mine', template: 'y {{input}}' }] } }) },
        },
        { id: 'prov', files: { 'plugin.json': manifest('prov', { contributes: { providers: [{ id: 'prov-x', name: 'X', baseURL: 'https://x.example.com/v1', apiFormat: 'openai-chat' }] } }) } },
        { id: 'prov-x', files: { 'plugin.json': manifest('prov-x', { contributes: { providers: [{ id: 'prov-x', name: 'X again', baseURL: 'https://y.example.com/v1', apiFormat: 'openai-chat' }] } }) } },
      ],
    })
    const { plugins: host, registry } = h.t.deps
    expect(host.state('cmd-clash')).toBe('active')
    expect(registry.commands.get('explain')?.pluginId).toBe('core-commands')
    expect(registry.commands.get('mine')?.pluginId).toBe('cmd-clash')
    expect((await host.logs('cmd-clash')).some(entry => entry.level === 'warn' && entry.message.includes('"/explain" was skipped'))).toBe(true)
    // Load order is by id: "prov" registers "prov-x" first, so the plugin "prov-x" conflicts.
    expect(host.state('prov')).toBe('active')
    expect(host.state('prov-x')).toBe('error')
    expect((await host.get('prov-x')).lastError?.message).toMatch(/already registered by the plugin "prov"/)
  })

  it('loads builtins first and keeps them loaded in safe mode while user plugins are listed disabled', async () => {
    const h = await app({
      env: { HF_SAFE_MODE: '1' },
      builtins: getBuiltinPlugins({ mockProvider: false }),
      plugins: [{ fixture: 'acme-docs' }],
    })
    const list = await h.t.deps.plugins.list()
    expect(list.map(plugin => plugin.id)).toEqual(['core-providers', 'core-tools', 'core-commands', 'core-mcp', 'acme-docs'])
    expect(list.slice(0, 4).every(plugin => plugin.state === 'active' && plugin.builtin && !plugin.removable && plugin.source === 'builtin')).toBe(true)
    expect(list[4]).toMatchObject({ id: 'acme-docs', state: 'disabled', enabled: true })
    expect(h.t.deps.registry.providers.list().map(provider => provider.definition.id)).toHaveLength(13)
    expect(h.t.deps.registry.providers.get('acme-docs')).toBeUndefined()
    const core = await detail(h, 'core-providers')
    expect(core).toMatchObject({ kind: 'code', runsCode: false, trust: { required: false, trusted: true, hash: null, trustedHash: null }, editable: false })
    expect(core.contributions.providers).toContain('anthropic')
    expect(h.t.deps.registry.commands.get('explain')?.pluginId).toBe('core-commands')
  })

  it('skips a plugin that crashed the previous process while loading (boot sentinel) until it is enabled', async () => {
    const h = await app({ start: false, plugins: [{ fixture: 'acme-docs', enabled: true }] })
    await h.t.db.update(plugins).set({ loadingSince: 1234 }).where(eq(plugins.id, 'acme-docs'))
    await h.t.deps.plugins.start()
    const host = h.t.deps.plugins
    expect(host.state('acme-docs')).toBe('error')
    expect((await host.get('acme-docs')).lastError?.message).toMatch(/crashed during load/)
    expect(h.t.deps.registry.providers.get('acme-docs')).toBeUndefined()

    const enabled = await host.enable('acme-docs')
    expect(enabled.state).toBe('active')
    expect((await host.record('acme-docs'))?.loadingSince).toBeNull()
  })

  it('ends a plugin whose setup never resolves in error after 10 s while the others become active', async () => {
    const h = await app({
      start: false,
      plugins: [{ fixture: 'acme-docs' }, { fixture: 'hanging-setup', trust: true }, { fixture: 'word-count', trust: true }],
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const host = h.t.deps.plugins
    const started = host.start()
    // Wait (real I/O) until the hanging setup runs, then let 10 s of timer time pass.
    for (let i = 0; i < 10_000; i++) {
      if (h.t.deps.plugins.state('hanging-setup') === 'loading' && (await host.logs('hanging-setup').catch(() => [])).some(entry => entry.message === 'setup started'))
        break
      await new Promise(resolve => setImmediate(resolve))
    }
    expect(host.state('word-count')).toBeNull()
    await vi.advanceTimersByTimeAsync(10_000)
    await started
    expect(host.state('hanging-setup')).toBe('error')
    expect((await host.get('hanging-setup')).lastError).toMatchObject({ code: 'plugin_error', message: 'Timed out after 10 s (setup).', details: { phase: 'setup' } })
    expect(host.state('acme-docs')).toBe('active')
    expect(host.state('word-count')).toBe('active')
  })
})

describe('lifecycle actions', () => {
  it('disable removes every contribution and aborts ctx.signal; enable restores them', async () => {
    const h = await app({ plugins: [{ fixture: 'acme-docs' }, { fixture: 'dice-roller', trust: true }] })
    const { registry, plugins: host } = h.t.deps
    h.events.clear()
    const disabled = await host.disable('acme-docs')
    expect(disabled).toMatchObject({ state: 'disabled', enabled: false })
    expect(disabled.contributions.providers).toEqual(['acme-docs'])
    expect(registry.providers.get('acme-docs')).toBeUndefined()
    expect(registry.models.list('openrouter')).toEqual([])
    expect(registry.commands.get('acme')).toBeUndefined()
    expect(registry.mcpServers.get('acme-docs')).toBeUndefined()
    expect(registry.contributions('acme-docs')).toEqual({ providers: [], models: 0, tools: [], mcpServers: [], commands: [], hooks: [] })
    expect(h.events.ofType('plugin.changed').at(-1)?.data).toMatchObject({ id: 'acme-docs', plugin: { state: 'disabled' } })
    expect(h.events.ofType('catalog.changed').length).toBeGreaterThan(0)

    await host.disable('dice-roller')
    expect(registry.tools.get('roll_dice')).toBeUndefined()
    expect(registry.hooks.list('chat.params')).toEqual([])
    const [disposals] = await h.t.db.select().from(pluginKv).where(eq(pluginKv.key, 'disposals'))
    expect(disposals?.value).toBe(1)

    expect((await host.enable('acme-docs')).state).toBe('active')
    expect(registry.providers.get('acme-docs')).toBeDefined()
    expect((await host.record('acme-docs'))?.enabled).toBe(true)
  })

  it('reload keeps settings, storage and secrets, and requires the plugin to be enabled', async () => {
    const h = await app({ plugins: [{ fixture: 'dice-roller', trust: true }] })
    const host = h.t.deps.plugins
    await host.reload('dice-roller')
    const [loads] = await h.t.db.select().from(pluginKv).where(eq(pluginKv.key, 'loads'))
    expect(loads?.value).toBe(2)
    await host.disable('dice-roller')
    await expect(host.reload('dice-roller')).rejects.toMatchObject({ code: 'conflict', details: { reason: 'disabled' } })
    await expect(host.reload('nope')).rejects.toMatchObject({ code: 'not_found' })
  })

  it('makes in-flight tool calls of a disabled plugin fail with "tool unavailable"', async () => {
    const h = await app({
      plugins: [{
        id: 'slow-tool',
        trust: true,
        files: {
          'plugin.json': manifest('slow-tool', { main: 'index.mjs' }),
          'index.mjs': [
            'export default {',
            '  setup(ctx) {',
            '    ctx.tools.register({',
            '      name: \'slow_tool\',',
            '      description: \'Waits until it is aborted.\',',
            '      inputSchema: ctx.ai.z.object({}),',
            '      execute: (_input, c) => new Promise((_resolve, reject) => c.signal.addEventListener(\'abort\', () => reject(new Error(\'aborted\')))),',
            '    })',
            '  },',
            '}',
            '',
          ].join('\n'),
        },
      }],
    })
    const { registry, plugins: host } = h.t.deps
    const tool = registry.tools.get('slow_tool')
    expect(tool).toBeDefined()
    const call = host.guard('slow-tool', signal => tool!.definition.execute({}, { chatId: 'c', modelRef: 'm:x', toolCallId: 't', messages: [], signal }), { timeoutMs: 60_000, phase: 'tool', label: 'slow_tool' })
    await host.disable('slow-tool')
    await expect(call).rejects.toMatchObject({ code: 'plugin_error', message: 'Tool unavailable: the plugin "slow-tool" was disabled.' })
    await expect(host.guard('slow-tool', () => 1, { timeoutMs: 1000, phase: 'tool' })).rejects.toMatchObject({ message: /Tool unavailable/ })
  })

  it('uninstall removes the plugin and purges its data unless keepData', async () => {
    const h = await app({ plugins: [{ fixture: 'acme-docs' }, { fixture: 'dice-roller', trust: true }] })
    const { plugins: host } = h.t.deps
    await host.updateSettings('acme-docs', { token: 'tok-secret-value-123', region: 'us' })
    await h.t.db.insert(providerConfigs).values({ providerId: 'acme-docs', options: { team: 'x' } })
    await h.secrets.set('provider:acme-docs', 'apiKey', 'sk-provider-key-123456')
    const dataDir = join(h.t.env.paths.pluginData, 'acme-docs')
    expect(existsSync(dataDir)).toBe(true)
    h.events.clear()

    await host.uninstall('acme-docs', { keepData: false })
    expect(existsSync(h.pluginDir('acme-docs'))).toBe(false)
    expect(existsSync(dataDir)).toBe(false)
    expect(await host.record('acme-docs')).toBeNull()
    expect(await h.secrets.list('plugin:acme-docs')).toEqual([])
    expect(await h.secrets.list('provider:acme-docs')).toEqual([])
    expect(await h.t.db.select().from(providerConfigs)).toEqual([])
    expect(h.t.deps.registry.providers.get('acme-docs')).toBeUndefined()
    expect(h.events.ofType('plugin.changed').at(-1)?.data).toEqual({ id: 'acme-docs', plugin: null })
    await expect(host.get('acme-docs')).rejects.toMatchObject({ code: 'not_found' })

    await host.uninstall('dice-roller', { keepData: true })
    expect(existsSync(h.pluginDir('dice-roller'))).toBe(false)
    expect((await h.t.db.select().from(pluginKv).where(eq(pluginKv.pluginId, 'dice-roller'))).length).toBeGreaterThan(0)
    expect(existsSync(join(h.t.env.paths.pluginData, 'dice-roller'))).toBe(true)
  })

  it('refuses to uninstall builtins and unknown plugins', async () => {
    const h = await app({ builtins: getBuiltinPlugins({ mockProvider: false }) })
    await expect(h.t.deps.plugins.uninstall('core-tools', { keepData: false })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(h.t.deps.plugins.uninstall('missing', { keepData: false })).rejects.toMatchObject({ code: 'not_found' })
  })

  it('never deletes a linked folder on uninstall', async () => {
    const linked = join(tempDir(), 'linked-docs')
    writeFiles(linked, { 'plugin.json': manifest('linked-docs', { contributes: { commands: [{ name: 'linked', description: 'Linked', template: 'x {{input}}' }] } }) })
    const h = await app({ start: false })
    await h.t.deps.plugins.saveRecord({ id: 'linked-docs', source: 'link', sourceRef: realpathSync(linked), version: '1.0.0' })
    await h.t.deps.plugins.start()
    expect(h.t.deps.plugins.state('linked-docs')).toBe('active')
    expect(await h.t.deps.plugins.directory('linked-docs')).toBe(realpathSync(linked))
    await h.t.deps.plugins.uninstall('linked-docs', { keepData: false })
    expect(existsSync(join(linked, 'plugin.json'))).toBe(true)
  })

  it('requires a linked folder to be named after the plugin id and an absolute link path', async () => {
    const linked = join(tempDir(), 'some-folder')
    writeFiles(linked, { 'plugin.json': manifest('renamed-link') })
    const h = await app()
    await expect(h.t.deps.plugins.saveRecord({ id: 'renamed-link', source: 'link', sourceRef: 'relative/path', version: '1.0.0' })).rejects.toMatchObject({ code: 'validation_error' })
    await h.t.deps.plugins.saveRecord({ id: 'renamed-link', source: 'link', sourceRef: realpathSync(linked), version: '1.0.0' })
    const loaded = await h.t.deps.plugins.load('renamed-link')
    expect(loaded.state).toBe('error')
    expect(loaded.lastError?.message).toMatch(/must be named after the plugin id/)
  })

  it('install hooks: saveRecord + load, unload, forget', async () => {
    const h = await app()
    const host = h.t.deps.plugins
    await expect(host.load('acme-docs')).rejects.toMatchObject({ code: 'not_found' })
    const dir = await h.install({ fixture: 'acme-docs' })
    const inspection = await host.inspectDirectory(dir)
    expect(inspection).toMatchObject({ kind: 'declarative', requiresTrust: false, compatible: true, reserved: false })
    await host.saveRecord({ id: 'acme-docs', source: 'zip', sourceRef: 'acme-docs.zip', version: inspection.manifest.version })
    expect((await host.load('acme-docs')).state).toBe('active')
    await host.unload('acme-docs')
    expect(host.state('acme-docs')).toBe('loading')
    expect(h.t.deps.registry.providers.get('acme-docs')).toBeUndefined()
    await host.forget('acme-docs')
    expect(await host.record('acme-docs')).toBeNull()
    expect(host.state('acme-docs')).toBeNull()
    expect(existsSync(dir)).toBe(true)
    await expect(host.saveRecord({ id: 'core-tools', source: 'zip', version: '1.0.0' })).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('compiles code plugins on demand and reports diagnostics to the plugin log', async () => {
    const h = await app({ plugins: [{ fixture: 'word-count', trust: true }, { fixture: 'acme-docs' }] })
    const host = h.t.deps.plugins
    const ok = await host.compile('word-count')
    expect(ok).toMatchObject({ ok: true, diagnostics: [] })
    expect(ok.outputFile).toMatch(/[/\\]cache[/\\]plugins[/\\]word-count[/\\][\da-f]{64}\.mjs$/)
    writeFileSync(join(h.pluginDir('word-count'), 'src', 'index.ts'), 'export default {\n  setup(ctx) {\n    const a =\n  }\n}\n')
    const failed = await host.compile('word-count')
    expect(failed.ok).toBe(false)
    expect(failed.diagnostics[0]).toMatchObject({ severity: 'error', file: 'src/index.ts', line: 4 })
    expect((await host.logs('word-count')).at(-1)?.message).toBe('Build failed with 1 error.')
    await expect(host.compile('acme-docs')).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('keeps the running version when a reload cannot build the new code', async () => {
    const h = await app({ plugins: [{ fixture: 'word-count', trust: true }] })
    const host = h.t.deps.plugins
    const file = join(h.pluginDir('word-count'), 'src', 'index.ts')
    writeFileSync(file, `${readFileSync(file, 'utf8')}\nconst broken = \n`)
    // The files changed, so re-pin them first (as the editor does), then reload.
    const pinned = await host.inspectDirectory(h.pluginDir('word-count'))
    await host.saveRecord({ id: 'word-count', source: 'copy', version: '0.1.0', trustedHash: pinned.sha256 })
    const reloaded = await host.reload('word-count')
    expect(reloaded.state).toBe('active')
    expect(h.t.deps.registry.tools.get('word_count')).toBeDefined()
    expect((await host.logs('word-count')).map(entry => entry.message)).toContain('The previous version keeps running until the build succeeds.')
  })
})

describe('settings', () => {
  it('stores secret settings encrypted, returns them masked and passes them to the plugin', async () => {
    const h = await app({ plugins: [{ fixture: 'acme-docs' }] })
    const host = h.t.deps.plugins
    const initial = await host.getSettings('acme-docs')
    expect(initial.values).toEqual({ region: 'eu', limit: 10 })
    expect(initial.secrets).toEqual({ token: { set: false, hint: null, source: null } })

    const secret = 'tok-abcdefghijklmnop'
    const updated = await host.updateSettings('acme-docs', { token: secret, limit: 25, tags: ['a', 'b'] })
    expect(updated.values).toEqual({ region: 'eu', limit: 25, tags: ['a', 'b'] })
    expect(updated.secrets.token).toMatchObject({ set: true, source: 'stored' })
    expect(JSON.stringify(updated)).not.toContain(secret)
    expect(await h.secrets.get('plugin:acme-docs', 'settings.token')).toBe(secret)
    expect(await host.settingsValues('acme-docs')).toEqual({ region: 'eu', limit: 25, tags: ['a', 'b'], token: secret })

    await expect(host.updateSettings('acme-docs', { limit: 99 })).rejects.toMatchObject({ code: 'validation_error' })
    await expect(host.updateSettings('acme-docs', { nope: 1 })).rejects.toMatchObject({ code: 'validation_error' })
    await expect(host.updateSettings('acme-docs', { token: '' })).rejects.toMatchObject({ code: 'validation_error' })

    const cleared = await host.updateSettings('acme-docs', { tags: null, region: 'us' })
    expect(cleared.values).toEqual({ region: 'us', limit: 25 })
  })

  it('runs settings.onChange handlers and re-registers MCP servers that use settings', async () => {
    const h = await app({
      plugins: [{
        id: 'watcher-settings',
        trust: true,
        files: {
          'plugin.json': manifest('watcher-settings', {
            main: 'index.mjs',
            settings: { type: 'object', properties: { host: { type: 'string', title: 'Host' } } },
          }),
          'index.mjs': [
            'export default {',
            '  setup(ctx) {',
            // eslint-disable-next-line no-template-curly-in-string -- plugin source code
            '    ctx.settings.onChange(values => ctx.logger.info(`changed to ${values.host}`))',
            '    ctx.settings.onChange(() => { throw new Error(\'handler failed\') })',
            '    ctx.mcp.register({ id: \'watcher-settings\', name: \'Docs\', transport: { type: \'http\', url: \'https://{{settings.host}}/mcp\' } })',
            '  },',
            '}',
            '',
          ].join('\n'),
        },
      }],
    })
    const changes: string[] = []
    h.t.deps.registry.onChange(change => changes.push(`${change.kind}:${change.action}:${change.key}`))
    expect(h.t.deps.plugins.state('watcher-settings')).toBe('active')
    await h.t.deps.plugins.updateSettings('watcher-settings', { host: 'docs.example.com' })
    const messages = (await h.t.deps.plugins.logs('watcher-settings')).map(entry => entry.message)
    expect(messages).toContain('changed to docs.example.com')
    expect(messages.some(message => message.includes('handler failed'))).toBe(true)
    expect(changes).toEqual(['mcpServer:removed:watcher-settings', 'mcpServer:added:watcher-settings'])
  })

  it('rejects settings of plugins without a schema', async () => {
    const h = await app({ plugins: [{ fixture: 'dice-roller', trust: true }] })
    expect(await h.t.deps.plugins.getSettings('dice-roller')).toEqual({ schema: null, values: {}, secrets: {} })
    await expect(h.t.deps.plugins.updateSettings('dice-roller', {})).rejects.toMatchObject({ code: 'validation_error' })
  })
})

describe('logs, icons and events', () => {
  it('keeps a per-plugin log with sequence numbers and publishes plugin.log events', async () => {
    const h = await app({ plugins: [{ fixture: 'dice-roller', trust: true }] })
    const host = h.t.deps.plugins
    const entries = await host.logs('dice-roller')
    expect(entries.map(entry => entry.message)).toEqual(expect.arrayContaining(['dice roller ready']))
    expect(entries.find(entry => entry.message === 'dice roller ready')?.data).toEqual({ loads: 1 })
    const last = entries.at(-1)?.seq ?? 0
    host.log('dice-roller', 'warn', 'custom entry')
    expect(await host.logs('dice-roller', { after: last })).toEqual([expect.objectContaining({ seq: last + 1, level: 'warn', message: 'custom entry' })])
    expect(h.events.ofType('plugin.log').at(-1)?.data).toMatchObject({ pluginId: 'dice-roller', entry: { message: 'custom entry' } })
    await expect(host.logs('unknown')).rejects.toMatchObject({ code: 'not_found' })
  })

  it('serves file icons from inside the plugin directory and reports lobe icons', async () => {
    const h = await app({
      plugins: [{ fixture: 'acme-docs' }, { id: 'lobe-icon', files: { 'plugin.json': manifest('lobe-icon', { icon: 'lobe:together' }) } }],
    })
    const icon = await h.t.deps.plugins.icon('acme-docs')
    expect(icon).toMatchObject({ kind: 'file', contentType: 'image/svg+xml' })
    if (icon.kind === 'file')
      expect(new TextDecoder().decode(icon.body)).toContain('<svg')
    expect(await h.t.deps.plugins.icon('lobe-icon')).toEqual({ kind: 'lobe', slug: 'together' })
    expect((await h.t.deps.plugins.summary('lobe-icon')).icon).toEqual({ mono: '/api/icons/lobe/together?v=test' })
    await h.install({ id: 'no-icon', files: { 'plugin.json': manifest('no-icon') } })
    await h.t.deps.plugins.load('no-icon')
    await expect(h.t.deps.plugins.icon('no-icon')).rejects.toMatchObject({ code: 'not_found' })
  })

  it('emits plugin.changed on every transition', async () => {
    const h = await app({ plugins: [{ fixture: 'acme-docs' }, { fixture: 'dice-roller' }] })
    const states = (id: string): Array<string | undefined> => h.events.ofType('plugin.changed').filter(event => event.data.id === id).map(event => event.data.plugin?.state)
    expect(states('acme-docs')).toEqual(['loading', 'active'])
    expect(states('dice-roller')).toEqual(['loading', 'untrusted'])
    await h.t.deps.plugins.disable('acme-docs')
    await h.t.deps.plugins.enable('acme-docs')
    await h.t.deps.plugins.reload('acme-docs')
    expect(states('acme-docs')).toEqual(['loading', 'active', 'disabled', 'loading', 'active', 'loading', 'active'])
  })

  it('attributes an unhandled rejection of plugin code to the plugin log', async () => {
    const h = await app({ plugins: [{ fixture: 'dice-roller', trust: true }] })
    const file = realpathSync(join(h.pluginDir('dice-roller'), 'index.mjs'))
    const error = new Error('late failure')
    error.stack = `Error: late failure\n    at roll (file://${file}?v=abc:3:9)`
    process.emit('unhandledRejection', error, Promise.resolve())
    expect((await h.t.deps.plugins.logs('dice-roller')).at(-1)?.message).toBe('Unhandled promise rejection: late failure')
  })
})

describe('hot reload', () => {
  it('reloads a linked folder when its files change and serves the new version', async () => {
    const linked = join(tempDir(), 'live-plugin')
    const code = (description: string): string => [
      'export default {',
      '  setup(ctx) {',
      `    ctx.tools.register({ name: 'live_tool', description: ${JSON.stringify(description)}, inputSchema: ctx.ai.z.object({}), execute: async () => ${JSON.stringify(description)} })`,
      '  },',
      '}',
      '',
    ].join('\n')
    writeFiles(linked, { 'plugin.json': manifest('live-plugin', { main: 'index.mjs' }), 'index.mjs': code('first version') })
    const real = realpathSync(linked)
    const h = await app({ start: false })
    await h.t.deps.plugins.saveRecord({ id: 'live-plugin', source: 'link', sourceRef: real, version: '1.0.0', trustedHash: pathPin(real) })
    await h.t.deps.plugins.start()
    const { registry } = h.t.deps
    expect(registry.tools.get('live_tool')?.definition.description).toBe('first version')

    writeFileSync(join(linked, 'index.mjs'), code('second version'))
    await waitFor(() => registry.tools.get('live_tool')?.definition.description === 'second version', 10_000)
    expect(h.t.deps.plugins.state('live-plugin')).toBe('active')
    expect(await registry.tools.get('live_tool')?.definition.execute({}, {} as never)).toBe('second version')
  })

  it('watches data/plugins only with HF_PLUGIN_WATCH=1 (declarative plugins reload on manifest change)', async () => {
    const commands = (template: string): Record<string, unknown> => manifest('watched', { contributes: { commands: [{ name: 'watched', description: 'Watched', template }] } })
    const unwatched = await app({ plugins: [{ id: 'watched', files: { 'plugin.json': commands('one {{input}}') } }] })
    writeFileSync(join(unwatched.pluginDir('watched'), 'plugin.json'), JSON.stringify(commands('two {{input}}')))
    await new Promise(resolve => setTimeout(resolve, 800))
    expect(unwatched.t.deps.registry.commands.get('watched')?.definition.template).toBe('one {{input}}')

    const watched = await app({ env: { HF_PLUGIN_WATCH: '1' }, plugins: [{ id: 'watched', files: { 'plugin.json': commands('one {{input}}') } }] })
    writeFileSync(join(watched.pluginDir('watched'), 'plugin.json'), JSON.stringify(commands('two {{input}}')))
    await waitFor(() => watched.t.deps.registry.commands.get('watched')?.definition.template === 'two {{input}}', 10_000)
  })

  it('does not reload for writes made through withoutWatch', async () => {
    const linked = join(tempDir(), 'quiet-plugin')
    writeFiles(linked, { 'plugin.json': manifest('quiet-plugin', { contributes: { commands: [{ name: 'quiet', description: 'Quiet', template: 'one {{input}}' }] } }) })
    const real = realpathSync(linked)
    const h = await app({ start: false })
    await h.t.deps.plugins.saveRecord({ id: 'quiet-plugin', source: 'link', sourceRef: real, version: '1.0.0' })
    await h.t.deps.plugins.start()
    await h.t.deps.plugins.withoutWatch('quiet-plugin', async () => {
      writeFileSync(join(linked, 'plugin.json'), JSON.stringify(manifest('quiet-plugin', { contributes: { commands: [{ name: 'quiet', description: 'Quiet', template: 'two {{input}}' }] } })))
    })
    await new Promise(resolve => setTimeout(resolve, 800))
    expect(h.t.deps.registry.commands.get('quiet')?.definition.template).toBe('one {{input}}')
  })
})

describe('declarative provider API', () => {
  it('builds a provider definition for drafts without registering it', async () => {
    const h = await app()
    const definition = h.t.deps.plugins.declarativeProvider('draft', { id: 'draft', name: 'Draft', baseURL: 'https://api.example.com/v1', apiFormat: 'openai-chat' })
    expect(definition).toMatchObject({ id: 'draft', name: 'Draft', credentials: [{ key: 'apiKey', type: 'secret', required: true }] })
    expect(typeof definition.createLanguageModel).toBe('function')
    expect(h.t.deps.registry.providers.get('draft')).toBeUndefined()
    expect(() => h.t.deps.plugins.declarativeProvider('draft', { id: 'draft', name: 'Draft', baseURL: 'ftp://x', apiFormat: 'openai-chat' })).toThrow(/URL/)
  })
})
