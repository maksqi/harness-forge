// Plugin agents and skills through the real plugin host (plugin API 1.4.0, ADR-045; W10.7-T1 / T3 / T4): manifest and
// `ctx` registrations, `GET /plugins` contributions, a name taken by another plugin (skipped and logged, first wins),
// reserved names, disposal on disable / reload / uninstall, `HF_SAFE_MODE` (no plugin entries) and 1.3.0 plugins that
// load unchanged.
import type { PluginTestApp } from '../plugins/__fixtures__/harness.ts'
import type { RegistryChange } from './types.ts'
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

/** A declarative plugin with agents and skills (`engines ^1.4.0`). */
function declarative(id: string, agents: string[], skills: string[] = []): Record<string, object> {
  return {
    'plugin.json': manifest(id, {
      engines: { harness: '^1.4.0' },
      contributes: {
        agents: agents.map(name => ({ name, description: `Agent ${name} of ${id}.`, instructions: `You are ${name}.`, tools: ['read_file'] })),
        skills: skills.map(name => ({ name, description: `Skill ${name} of ${id}.`, content: `# ${name}` })),
      },
    }),
  }
}

/** A code plugin whose `setup` runs `body` (plain JavaScript with `ctx`). */
function code(id: string, body: string): Record<string, string | object> {
  return {
    'plugin.json': manifest(id, { engines: { harness: '^1.4.0' }, main: 'index.mjs' }),
    'index.mjs': `export default {\n  setup(ctx) {\n${body}\n  },\n}\n`,
  }
}

const CODE_PACK = `
    ctx.agents.register({ name: 'docs-writer', description: 'Writes docs.', instructions: 'Write docs.', model: 'inherit' })
    ctx.skills.register({ name: 'changelog-entry', description: 'Changelog entries.', content: '# Changelog' })
    try {
      ctx.agents.register({ name: 'reviewer', description: 'Mine.', instructions: 'x' })
    }
    catch (error) {
      ctx.logger.warn('reviewer refused: ' + error.code)
    }`

function names(h: PluginTestApp): { agents: string[], skills: string[] } {
  const { agents, skills } = h.t.deps.registry
  return {
    agents: agents.list().map(entry => `${entry.pluginId}:${entry.definition.name}`),
    skills: skills.list().map(entry => `${entry.pluginId}:${entry.definition.name}`),
  }
}

async function warnings(h: PluginTestApp, id: string): Promise<string[]> {
  return (await h.t.deps.plugins.logs(id)).filter(entry => entry.level === 'warn').map(entry => entry.message)
}

describe('plugin agents and skills in the plugin host', () => {
  it('registers manifest and ctx entries, lists them in GET /plugins and skips a name another plugin took', async () => {
    const h = await app({
      plugins: [
        { id: 'pack-a', files: declarative('pack-a', ['reviewer', 'planner'], ['notes']) },
        { id: 'pack-b', files: code('pack-b', CODE_PACK), trust: true },
        { id: 'pack-c', files: declarative('pack-c', ['reviewer', 'tester'], ['notes', 'style']) },
      ],
    })
    const states = Object.fromEntries((await h.t.deps.plugins.list()).map(plugin => [plugin.id, plugin.state]))
    expect(states).toEqual({ 'pack-a': 'active', 'pack-b': 'active', 'pack-c': 'active' })
    expect(names(h)).toEqual({
      agents: ['pack-b:docs-writer', 'pack-a:planner', 'pack-a:reviewer', 'pack-c:tester'],
      skills: ['pack-b:changelog-entry', 'pack-a:notes', 'pack-c:style'],
    })
    expect(h.t.deps.registry.agents.get('reviewer')?.definition.description).toBe('Agent reviewer of pack-a.')

    const listed = Object.fromEntries((await h.t.client.plugins.list()).items.map(plugin => [plugin.id, plugin.contributions]))
    expect(listed['pack-a']).toMatchObject({ agents: ['planner', 'reviewer'], skills: ['notes'] })
    expect(listed['pack-b']).toMatchObject({ agents: ['docs-writer'], skills: ['changelog-entry'] })
    expect(listed['pack-c']).toMatchObject({ agents: ['tester'], skills: ['style'] })
    expect((await h.t.client.plugins.get({ params: { id: 'pack-c' } })).contributions).toMatchObject({ agents: ['tester'], skills: ['style'] })

    // The second plugin stays active; the taken names are skipped and logged in its own log.
    expect(await warnings(h, 'pack-c')).toEqual([
      'The agent "reviewer" was skipped: The agent "reviewer" is already registered by the plugin "pack-a".',
      'The skill "notes" was skipped: The skill "notes" is already registered by the plugin "pack-a".',
    ])
    // A code plugin gets the conflict as a thrown HarnessError.
    expect(await warnings(h, 'pack-b')).toEqual(['reviewer refused: conflict'])
    expect(await warnings(h, 'pack-a')).toEqual([])
  })

  it('removes a plugin\'s agents and skills on disable, re-adds them on enable and reload, and drops them on uninstall', async () => {
    const h = await app({
      plugins: [
        { id: 'pack-a', files: declarative('pack-a', ['reviewer'], ['notes']) },
        { id: 'pack-b', files: code('pack-b', CODE_PACK), trust: true },
      ],
    })
    const { plugins: host, registry } = h.t.deps
    const changes: string[] = []
    registry.onChange((change: RegistryChange) => {
      if (change.kind === 'agent' || change.kind === 'skill')
        changes.push(`${change.kind}:${change.action}:${change.key}`)
    })
    const agentChanges: string[] = []
    registry.agents.onChange(change => agentChanges.push(`${change.action}:${change.key}`))

    await host.disable('pack-a')
    expect(host.state('pack-a')).toBe('disabled')
    expect(names(h)).toEqual({ agents: ['pack-b:docs-writer'], skills: ['pack-b:changelog-entry'] })
    expect((await host.summary('pack-a')).contributions).toMatchObject({ agents: ['reviewer'], skills: ['notes'] })
    expect(changes.sort()).toEqual(['agent:removed:reviewer', 'skill:removed:notes'])

    changes.length = 0
    await host.enable('pack-a')
    expect(names(h).agents).toEqual(['pack-b:docs-writer', 'pack-a:reviewer'])
    expect(changes.sort()).toEqual(['agent:added:reviewer', 'skill:added:notes'])

    changes.length = 0
    await host.reload('pack-b')
    expect(host.state('pack-b')).toBe('active')
    expect(names(h)).toEqual({ agents: ['pack-b:docs-writer', 'pack-a:reviewer'], skills: ['pack-b:changelog-entry', 'pack-a:notes'] })
    expect(changes.sort()).toEqual(['agent:added:docs-writer', 'agent:removed:docs-writer', 'skill:added:changelog-entry', 'skill:removed:changelog-entry'])

    await host.uninstall('pack-a', { keepData: false })
    await host.uninstall('pack-b', { keepData: false })
    expect(names(h)).toEqual({ agents: [], skills: [] })
    expect(agentChanges.filter(change => change.startsWith('removed:'))).toEqual(['removed:reviewer', 'removed:docs-writer', 'removed:reviewer', 'removed:docs-writer'])
  })

  it('a failing setup removes the agents and skills it registered before the failure', async () => {
    const h = await app({
      plugins: [{
        id: 'half-pack',
        files: {
          ...code('half-pack', `
    ctx.agents.register({ name: 'early', description: 'Early.', instructions: 'x' })
    ctx.skills.register({ name: 'early-skill', description: 'Early.', content: 'x' })
    throw new Error('boom after registering')`),
          'plugin.json': manifest('half-pack', { engines: { harness: '^1.4.0' }, main: 'index.mjs', contributes: { agents: [{ name: 'declared', description: 'D.', instructions: 'd' }] } }),
        },
        trust: true,
      }],
    })
    expect(h.t.deps.plugins.state('half-pack')).toBe('error')
    expect(names(h)).toEqual({ agents: [], skills: [] })
    expect((await h.t.deps.plugins.summary('half-pack')).contributions).toMatchObject({ agents: ['declared'], skills: [] })
  })

  it('refuses the reserved agent names: a manifest fails validation, a ctx registration fails setup', async () => {
    const h = await app({
      plugins: [
        { id: 'manifest-explore', files: declarative('manifest-explore', ['explore']) },
        { id: 'code-general', files: code('code-general', `    ctx.agents.register({ name: 'general-purpose', description: 'Mine.', instructions: 'x' })`), trust: true },
      ],
    })
    const manifestPlugin = await h.t.deps.plugins.get('manifest-explore')
    expect(manifestPlugin.state).toBe('error')
    expect(manifestPlugin.lastError?.message).toMatch(/contributes\.agents\.0\.name: Reserved agent type \(explore, general, general-purpose\)/)
    const codePlugin = await h.t.deps.plugins.get('code-general')
    expect(codePlugin.state).toBe('error')
    expect(codePlugin.lastError?.message).toMatch(/Reserved agent type/)
    expect(names(h)).toEqual({ agents: [], skills: [] })
  })

  it('a plugin of plugin API 1.3.0 loads unchanged next to agent packs', async () => {
    const h = await app({
      plugins: [
        { id: 'older', files: { 'plugin.json': manifest('older', { engines: { harness: '^1.3.0' }, contributes: { commands: [{ name: 'hello', description: 'Hello.', template: 'Hello {{input}}' }] } }) } },
        { id: 'older-code', files: { ...code('older-code', `    ctx.commands.register({ name: 'greet', description: 'Greets.', template: 'Greet {{input}}' })`), 'plugin.json': manifest('older-code', { engines: { harness: '^1.3.0' }, main: 'index.mjs' }) }, trust: true },
        { id: 'pack-a', files: declarative('pack-a', ['reviewer']) },
      ],
    })
    expect(Object.fromEntries((await h.t.deps.plugins.list()).map(plugin => [plugin.id, plugin.state]))).toEqual({ 'older': 'active', 'older-code': 'active', 'pack-a': 'active' })
    expect((await h.t.deps.plugins.summary('older')).contributions).toEqual({ providers: [], models: 0, tools: [], mcpServers: [], commands: ['hello'], hooks: [], agents: [], skills: [] })
    expect((await h.t.deps.plugins.summary('older-code')).contributions).toMatchObject({ commands: ['greet'], agents: [], skills: [] })
    expect(await warnings(h, 'older')).toEqual([])
  })

  it('hF_SAFE_MODE: no plugin agents or skills (user plugins stay disabled)', async () => {
    const h = await app({
      env: { HF_SAFE_MODE: '1' },
      plugins: [
        { id: 'pack-a', files: declarative('pack-a', ['reviewer'], ['notes']) },
        { id: 'pack-b', files: code('pack-b', CODE_PACK), trust: true },
      ],
    })
    expect(h.t.deps.plugins.state('pack-a')).toBe('disabled')
    expect(h.t.deps.plugins.state('pack-b')).toBe('disabled')
    expect(names(h)).toEqual({ agents: [], skills: [] })
    // The summaries still show what the manifests declare (code registrations are unknown while not loaded).
    expect((await h.t.deps.plugins.summary('pack-a')).contributions).toMatchObject({ agents: ['reviewer'], skills: ['notes'] })
    expect((await h.t.deps.plugins.summary('pack-b')).contributions).toMatchObject({ agents: [], skills: [] })
  })
})
