// Plugin command hooks and output styles through the real plugin host (plugin API 1.5.0, ADR-048 / ADR-051 / ADR-052;
// W11.7-T1 – T3): manifest `contributes.hooks` (registered with the plugin folder as the root, only while the plugin is
// active and trusted) and `contributes.outputStyles` / `ctx.outputStyles.register` (first wins across plugins, the
// second skipped and logged), the 1.5.0 code events received by a code plugin, trust (a manifest with hooks or a `!`
// span stays `untrusted` until pinned; the pin covers `plugin.json` only), disposal on disable / reload / uninstall,
// `HF_SAFE_MODE`, and `^1.4.0` plugins that load unchanged.
import type { HookMap } from '@harness-forge/plugin-sdk'
import type { PluginTestApp } from '../plugins/__fixtures__/harness.ts'
import type { RegistryChange } from './types.ts'
import { realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPluginTestApp, manifest, removeTempDirs } from '../plugins/__fixtures__/harness.ts'

const apps: PluginTestApp[] = []

afterEach(async () => {
  for (const created of apps.splice(0))
    await created.close()
  removeTempDirs()
})

async function app(options: Parameters<typeof createPluginTestApp>[0] = {}): Promise<PluginTestApp> {
  const created = await createPluginTestApp(options)
  apps.push(created)
  return created
}

const AFTER_EDIT = 'sh "$HARNESS_PLUGIN_ROOT/scripts/after-edit.sh"'

/** A declarative plugin (`engines ^1.5.0`) with one PostToolUse command hook and the given output styles. */
function hookPack(id: string, styles: string[] = [], command = AFTER_EDIT): Record<string, string | object> {
  return {
    'plugin.json': manifest(id, {
      engines: { harness: '^1.5.0' },
      contributes: {
        hooks: { PostToolUse: [{ matcher: 'Write|Edit', hooks: [{ type: 'command', command, timeout: 10 }] }] },
        ...(styles.length === 0 ? {} : { outputStyles: styles.map(name => ({ name, description: `Style ${name} of ${id}.`, content: `Write the ${name} way.` })) }),
      },
    }),
    'scripts/after-edit.sh': '#!/bin/sh\ncat > /dev/null\necho \'{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"Run the tests."}}\'\n',
  }
}

/** A declarative plugin with output styles only (runs nothing, needs no trust). */
function stylePack(id: string, styles: string[]): Record<string, object> {
  return {
    'plugin.json': manifest(id, {
      engines: { harness: '^1.5.0' },
      contributes: { outputStyles: styles.map(name => ({ name, description: `Style ${name} of ${id}.`, content: `Write the ${name} way.`, keepCodingInstructions: true })) },
    }),
  }
}

/** A code plugin that registers a style and a handler for every 1.5.0 code event (each logs what it received). */
const CODE_EVENTS = `
    ctx.outputStyles.register({ name: 'coded', description: 'A style from code.', content: 'Answer in haiku.' })
    try {
      ctx.outputStyles.register({ name: 'default', description: 'Mine.', content: 'x' })
    }
    catch (error) {
      ctx.logger.warn('default refused: ' + error.code)
    }
    ctx.hooks.on('prompt.submit', (input, output) => {
      ctx.logger.info('prompt.submit ' + input.prompt + ' ' + input.projectId)
      output.context = 'coded context'
    })
    ctx.hooks.on('session.start', (input, output) => {
      ctx.logger.info('session.start ' + input.source)
      output.context = 'coded session'
    })
    ctx.hooks.on('run.stop', (input, output) => {
      ctx.logger.info('run.stop ' + input.origin + ' ' + input.hookActive)
      output.continue = 'keep going'
    })
    ctx.hooks.on('subagent.stop', (input, output) => {
      ctx.logger.info('subagent.stop ' + input.type)
      output.continue = 'one more round'
    })
    ctx.hooks.on('compact.before', input => ctx.logger.info('compact.before ' + input.trigger))
    ctx.hooks.on('notification', input => ctx.logger.info('notification ' + input.type))
    ctx.hooks.on('tool.after', (input, output) => {
      ctx.logger.info('tool.after ' + input.tool)
      output.context = 'coded tool context'
    })`

function codePlugin(id: string, body: string): Record<string, string | object> {
  return {
    'plugin.json': manifest(id, { engines: { harness: '^1.5.0' }, main: 'index.mjs', permissions: ['hooks'] }),
    'index.mjs': `export default {\n  setup(ctx) {\n${body}\n  },\n}\n`,
  }
}

function registered(h: PluginTestApp): { hooks: string[], styles: string[] } {
  const { hookCommands, styles } = h.t.deps.registry
  return {
    hooks: hookCommands.list().map(entry => `${entry.pluginId}:${entry.hooks.length}`),
    styles: styles.list().map(entry => `${entry.pluginId}:${entry.definition.name}`),
  }
}

/** True when the hook service's snapshot of a chat without a project has a PostToolUse hook (W11.1's service). */
async function snapshotHasPostToolUse(h: PluginTestApp): Promise<boolean> {
  const snapshot = await h.t.deps.hooks.snapshot({ chatId: 'chat-1', projectId: null, workspace: null, toolMode: 'ask', origin: 'request', modelRef: 'mock:hooks' })
  return snapshot.has('PostToolUse')
}

async function logsOf(h: PluginTestApp, id: string, level: 'info' | 'warn'): Promise<string[]> {
  return (await h.t.deps.plugins.logs(id)).filter(entry => entry.level === level).map(entry => entry.message)
}

describe('plugin command hooks and output styles in the plugin host', () => {
  it('a manifest with command hooks stays untrusted (nothing registered) until pinned; then hooks and styles register', async () => {
    const h = await app({ plugins: [{ id: 'hooky', files: hookPack('hooky', ['reviewer']) }] })
    const host = h.t.deps.plugins
    expect(host.state('hooky')).toBe('untrusted')
    const untrusted = await host.get('hooky')
    expect(untrusted).toMatchObject({ kind: 'declarative', runsCode: true, trust: { required: true, trusted: false } })
    // The summary shows what the manifest declares; the registries hold nothing.
    expect(untrusted.contributions).toMatchObject({ commandHooks: 1, outputStyles: ['reviewer'] })
    expect(registered(h)).toEqual({ hooks: [], styles: [] })
    expect(await logsOf(h, 'hooky', 'warn')).toEqual([expect.stringContaining('runs code (or starts a program or shell commands)')])
    // Untrusted: no hook of the plugin is in the hook service's snapshot, so none can run.
    expect(await snapshotHasPostToolUse(h)).toBe(false)

    await h.install({ id: 'hooky', trust: true })
    await host.load('hooky')
    expect(host.state('hooky')).toBe('active')
    expect(registered(h)).toEqual({ hooks: ['hooky:1'], styles: ['hooky:reviewer'] })
    // Trusted and active: its hook is in the snapshot, its style in the customization catalog (W11.6's).
    expect(await snapshotHasPostToolUse(h)).toBe(true)
    const catalog = await h.t.deps.customizations.catalog(null)
    expect(catalog.style('reviewer')).toMatchObject({ name: 'reviewer', source: 'plugin' })
    expect(h.t.deps.registry.hookCommands.get('hooky')).toEqual({
      pluginId: 'hooky',
      root: realpathSync(h.pluginDir('hooky')),
      hooks: [{ event: 'PostToolUse', matcher: 'Write|Edit', command: AFTER_EDIT, timeoutSec: 10, position: [0, 0] }],
      diagnostics: [],
      // Phase 12 (C43): no extra environment, no prompt handlers.
      env: {},
      prompts: [],
    })
    expect((await host.get('hooky')).contributions).toMatchObject({ commandHooks: 1, outputStyles: ['reviewer'] })
    const listed = (await h.t.client.plugins.list()).items.find(plugin => plugin.id === 'hooky')
    expect(listed).toMatchObject({ state: 'active', runsCode: true, contributions: { commandHooks: 1, outputStyles: ['reviewer'] } })
  })

  it('the pin covers plugin.json only: a changed command re-pends the plugin, a changed script does not', async () => {
    const h = await app({ plugins: [{ id: 'hooky', files: hookPack('hooky'), trust: true }] })
    const host = h.t.deps.plugins
    expect(host.state('hooky')).toBe('active')

    writeFileSync(join(h.pluginDir('hooky'), 'scripts', 'after-edit.sh'), '#!/bin/sh\necho changed\n')
    await host.reload('hooky')
    expect(host.state('hooky')).toBe('active')
    expect(registered(h).hooks).toEqual(['hooky:1'])

    writeFileSync(join(h.pluginDir('hooky'), 'plugin.json'), JSON.stringify(hookPack('hooky', [], 'sh other.sh')['plugin.json']))
    await host.reload('hooky')
    expect(host.state('hooky')).toBe('untrusted')
    expect(registered(h)).toEqual({ hooks: [], styles: [] })
  })

  it('a `!` span in a command template requires trust too; a template without one does not', async () => {
    const h = await app({
      plugins: [
        { id: 'spans', files: { 'plugin.json': manifest('spans', { engines: { harness: '^1.5.0' }, contributes: { commands: [{ name: 'status', description: 'Status.', template: 'Status: !`git status --short` {{input}}' }] } }) } },
        { id: 'plain', files: { 'plugin.json': manifest('plain', { engines: { harness: '^1.5.0' }, contributes: { commands: [{ name: 'hello', description: 'Hello.', template: 'Say hello to {{input}}!' }] } }) } },
      ],
    })
    expect(await h.t.deps.plugins.get('spans')).toMatchObject({ state: 'untrusted', runsCode: true, trust: { required: true, trusted: false } })
    expect(await h.t.deps.plugins.get('plain')).toMatchObject({ state: 'active', runsCode: false, trust: { required: false } })
    expect(h.t.deps.registry.commands.get('status')).toBeUndefined()
  })

  it('removes the hooks and styles on disable, re-adds them on enable and drops them on uninstall', async () => {
    const h = await app({ plugins: [{ id: 'hooky', files: hookPack('hooky', ['reviewer', 'terse']), trust: true }] })
    const { plugins: host, registry } = h.t.deps
    const changes: string[] = []
    registry.onChange((change: RegistryChange) => {
      if (change.kind === 'style' || change.kind === 'hookCommands')
        changes.push(`${change.kind}:${change.action}:${change.key}`)
    })

    await host.disable('hooky')
    expect(host.state('hooky')).toBe('disabled')
    expect(registered(h)).toEqual({ hooks: [], styles: [] })
    expect(changes.sort()).toEqual(['hookCommands:removed:hooky', 'style:removed:reviewer', 'style:removed:terse'])
    expect(await snapshotHasPostToolUse(h)).toBe(false)

    changes.length = 0
    await host.enable('hooky')
    expect(registered(h)).toEqual({ hooks: ['hooky:1'], styles: ['hooky:reviewer', 'hooky:terse'] })
    expect(changes.sort()).toEqual(['hookCommands:added:hooky', 'style:added:reviewer', 'style:added:terse'])

    await host.uninstall('hooky', { keepData: false })
    expect(registered(h)).toEqual({ hooks: [], styles: [] })
  })

  it('a style name another plugin registered is skipped and logged in the second plugin\'s log (first wins)', async () => {
    const h = await app({
      plugins: [
        { id: 'pack-a', files: stylePack('pack-a', ['reviewer', 'terse']) },
        { id: 'pack-b', files: stylePack('pack-b', ['reviewer', 'teacher']) },
      ],
    })
    expect(Object.fromEntries((await h.t.deps.plugins.list()).map(plugin => [plugin.id, plugin.state]))).toEqual({ 'pack-a': 'active', 'pack-b': 'active' })
    expect(registered(h).styles).toEqual(['pack-a:reviewer', 'pack-b:teacher', 'pack-a:terse'])
    expect(h.t.deps.registry.styles.get('teacher')?.definition).toEqual({ name: 'teacher', description: 'Style teacher of pack-b.', content: 'Write the teacher way.', keepCodingInstructions: true })
    expect(await logsOf(h, 'pack-b', 'warn')).toEqual(['The output style "reviewer" was skipped: The output style "reviewer" is already registered by the plugin "pack-a".'])
    expect(await logsOf(h, 'pack-a', 'warn')).toEqual([])
    expect((await h.t.deps.plugins.summary('pack-b')).contributions.outputStyles).toEqual(['teacher'])
    // A style-only plugin runs nothing and needs no trust.
    expect(await h.t.deps.plugins.get('pack-a')).toMatchObject({ runsCode: false, trust: { required: false } })
  })

  it('a manifest with a builtin style name fails validation', async () => {
    const h = await app({ plugins: [{ id: 'builtin-name', files: stylePack('builtin-name', ['learning']) }] })
    const detail = await h.t.deps.plugins.get('builtin-name')
    expect(detail.state).toBe('error')
    expect(detail.lastError?.message).toMatch(/contributes\.outputStyles\.0\.name: Reserved output style/)
    expect(registered(h).styles).toEqual([])
  })

  it('a code plugin registers a style with ctx.outputStyles and receives each 1.5.0 code event', async () => {
    const h = await app({ plugins: [{ id: 'coder', files: codePlugin('coder', CODE_EVENTS), trust: true }] })
    const { plugins: host, registry } = h.t.deps
    expect(host.state('coder')).toBe('active')
    expect(registry.styles.get('coded')).toEqual({ pluginId: 'coder', definition: { name: 'coded', description: 'A style from code.', content: 'Answer in haiku.', keepCodingInstructions: false } })
    expect(await logsOf(h, 'coder', 'warn')).toEqual(['default refused: validation_error'])

    const context = { chatId: 'chat-1', modelRef: 'mock:hooks' }
    const prompt: HookMap['prompt.submit'][1] = {}
    await registry.hooks.run('prompt.submit', { ...context, prompt: 'hello', projectId: null }, prompt)
    const session: HookMap['session.start'][1] = {}
    await registry.hooks.run('session.start', { ...context, source: 'startup', projectId: null }, session)
    const stop: HookMap['run.stop'][1] = {}
    await registry.hooks.run('run.stop', { ...context, origin: 'request', hookActive: false, projectId: null }, stop)
    const child: HookMap['subagent.stop'][1] = {}
    await registry.hooks.run('subagent.stop', { ...context, type: 'general', toolCallId: 'call_1', report: 'done', hookActive: false }, child)
    await registry.hooks.run('compact.before', { ...context, trigger: 'auto', focus: null }, undefined)
    await registry.hooks.run('notification', { ...context, type: 'permission_prompt', message: 'The agent needs your permission to use Bash.' }, undefined)
    const after: HookMap['tool.after'][1] = { output: 'ok' }
    await registry.hooks.run('tool.after', { ...context, tool: 'write_file', toolCallId: 'call_2', input: {} }, after)

    expect({ prompt, session, stop, child, after }).toEqual({
      prompt: { context: 'coded context' },
      session: { context: 'coded session' },
      stop: { continue: 'keep going' },
      child: { continue: 'one more round' },
      after: { output: 'ok', context: 'coded tool context' },
    })
    expect((await logsOf(h, 'coder', 'info')).filter(message => !message.startsWith('Loaded'))).toEqual([
      'prompt.submit hello null',
      'session.start startup',
      'run.stop request false',
      'subagent.stop general',
      'compact.before auto',
      'notification permission_prompt',
      'tool.after write_file',
    ])
    expect((await host.summary('coder')).contributions).toMatchObject({
      hooks: ['tool.after', 'prompt.submit', 'session.start', 'run.stop', 'subagent.stop', 'compact.before', 'notification'],
      outputStyles: ['coded'],
      commandHooks: 0,
    })

    // Disabling the plugin removes its style and its handlers.
    await host.disable('coder')
    expect(registry.styles.get('coded')).toBeUndefined()
    const later: HookMap['prompt.submit'][1] = {}
    await registry.hooks.run('prompt.submit', { ...context, prompt: 'again', projectId: null }, later)
    expect(later).toEqual({})
  })

  it('a code plugin gets the conflict of a taken style name as a thrown HarnessError', async () => {
    const h = await app({
      plugins: [
        { id: 'pack-a', files: stylePack('pack-a', ['reviewer']) },
        {
          id: 'pack-z',
          files: codePlugin('pack-z', `
    try {
      ctx.outputStyles.register({ name: 'reviewer', description: 'Mine.', content: 'x' })
    }
    catch (error) {
      ctx.logger.warn('reviewer refused: ' + error.code)
    }`),
          trust: true,
        },
      ],
    })
    expect(h.t.deps.plugins.state('pack-z')).toBe('active')
    expect(await logsOf(h, 'pack-z', 'warn')).toEqual(['reviewer refused: conflict'])
    expect(h.t.deps.registry.styles.owner('reviewer')).toBe('pack-a')
  })

  it('hF_SAFE_MODE: no plugin hooks or styles (user plugins stay disabled)', async () => {
    const h = await app({
      env: { HF_SAFE_MODE: '1' },
      plugins: [
        { id: 'hooky', files: hookPack('hooky', ['reviewer']), trust: true },
        { id: 'pack-a', files: stylePack('pack-a', ['terse']) },
      ],
    })
    expect(h.t.deps.plugins.state('hooky')).toBe('disabled')
    expect(h.t.deps.plugins.state('pack-a')).toBe('disabled')
    expect(registered(h)).toEqual({ hooks: [], styles: [] })
  })

  it('plugins written for plugin API 1.4.0 load unchanged next to hook packs', async () => {
    const h = await app({
      plugins: [
        { id: 'older', files: { 'plugin.json': manifest('older', { engines: { harness: '^1.4.0' }, contributes: { skills: [{ name: 'pdf', description: 'PDFs.', content: 'Read PDFs.' }], commands: [{ name: 'tldr', description: 'Summarize.', template: 'Summarize: {{input}}' }] } }) } },
        { id: 'hooky', files: hookPack('hooky', ['reviewer']), trust: true },
      ],
    })
    expect(Object.fromEntries((await h.t.deps.plugins.list()).map(plugin => [plugin.id, plugin.state]))).toEqual({ hooky: 'active', older: 'active' })
    expect(await h.t.deps.plugins.get('older')).toMatchObject({ runsCode: false, trust: { required: false } })
    expect((await h.t.deps.plugins.summary('older')).contributions).toEqual({ providers: [], models: 0, tools: [], mcpServers: [], commands: ['tldr'], hooks: [], agents: [], skills: ['pdf'], commandHooks: 0, outputStyles: [] })
    expect(await logsOf(h, 'older', 'warn')).toEqual([])
  })
})
