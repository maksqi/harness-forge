// The agent and skill registries of plugin API 1.4.0 (Phase 10, ADR-045; W10.7-T1): validation at registration,
// per-plugin ownership, the first registration of a name wins (`conflict` otherwise), disposal, `removeOwner`, the
// per-kind `onChange`, the contributions `agents` / `skills` and frozen stored definitions.
import type { AgentDefinition, SkillDefinition } from '@harness-forge/plugin-sdk'
import type { RegistryChange } from './types.ts'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createMemoryLogger } from '../logger.ts'
import { createAgentRegistry, kindListener } from './agents.ts'
import { createRegistryCore } from './index.ts'
import { createSkillRegistry } from './skills.ts'

function core(): ReturnType<typeof createRegistryCore> {
  return createRegistryCore(() => ({
    logger: createMemoryLogger().logger,
    log: () => {},
    isRunnable: () => true,
    guard: async (_pluginId, fn) => fn(new AbortController().signal),
  }))
}

function agent(name: string, extra: Partial<AgentDefinition> = {}): AgentDefinition {
  return { name, description: `Agent ${name}.`, instructions: `You are ${name}.`, ...extra }
}

function skill(name: string, extra: Partial<SkillDefinition> = {}): SkillDefinition {
  return { name, description: `Skill ${name}.`, content: `# ${name}`, ...extra }
}

/** A registry core whose change listeners are a plain set (for the kind registries on their own). */
function standalone(): { core: Parameters<typeof createAgentRegistry>[0], changes: RegistryChange[] } {
  const listeners = new Set<(change: RegistryChange) => void>()
  const changes: RegistryChange[] = []
  return {
    changes,
    core: {
      onChange: (listener) => {
        listeners.add(listener)
        return { dispose: () => void listeners.delete(listener) }
      },
      notify: (change) => {
        changes.push(change)
        for (const listener of [...listeners])
          listener(change)
      },
    },
  }
}

describe('agent registry', () => {
  it('registers, gets, lists by name and reports the owner', () => {
    const registry = core()
    registry.agents.register('acme', agent('zeta'))
    registry.agents.register('beta-plugin', agent('alpha', { tools: ['read_file'], model: 'inherit' }))
    registry.agents.register('acme', agent('mid'))
    expect(registry.agents.list().map(entry => entry.definition.name)).toEqual(['alpha', 'mid', 'zeta'])
    expect(registry.agents.get('alpha')).toEqual({ pluginId: 'beta-plugin', definition: agent('alpha', { tools: ['read_file'], model: 'inherit' }) })
    expect(registry.agents.owner('zeta')).toBe('acme')
    expect(registry.agents.owner('missing')).toBeUndefined()
    expect(registry.agents.get('missing')).toBeUndefined()
    // Agents and skills are separate name spaces.
    expect(registry.skills.list()).toEqual([])
    expect(registry.skills.owner('zeta')).toBeUndefined()
  })

  it('validates before registering: reserved names, the name pattern and bad fields throw validation_error and register nothing', () => {
    const registry = core()
    const changes: RegistryChange[] = []
    registry.onChange(change => changes.push(change))
    for (const name of ['explore', 'general', 'general-purpose']) {
      expect(() => registry.agents.register('acme', agent(name)), name).toThrow(expect.objectContaining({ code: 'validation_error' }))
      expect(registry.agents.get(name)).toBeUndefined()
    }
    expect(() => registry.agents.register('acme', agent('Bad Name'))).toThrow(expect.objectContaining({ code: 'validation_error' }))
    // Plugin API 1.6.0: a Claude model name is a model (`sonnet`); a free text is not.
    expect(() => registry.agents.register('acme', agent('ok', { model: 'my model' }))).toThrow(expect.objectContaining({ code: 'validation_error', message: expect.stringContaining('model') }))
    expect(() => registry.agents.register('acme', agent('ok', { tools: ['Bash(git:*)'] }))).toThrow(expect.objectContaining({ code: 'validation_error', message: expect.stringContaining('tools.0') }))
    expect(() => registry.agents.register('acme', agent('ok', { instructions: 'x'.repeat(65_537) }))).toThrow(expect.objectContaining({ code: 'validation_error', message: expect.stringContaining('instructions') }))
    expect(registry.agents.list()).toEqual([])
    expect(changes).toEqual([])
  })

  it('the first registration of a name wins: a second one (any plugin) throws conflict naming the owner', () => {
    const registry = core()
    registry.agents.register('first', agent('reviewer'))
    expect(() => registry.agents.register('second', agent('reviewer', { description: 'Other.' }))).toThrow(expect.objectContaining({
      code: 'conflict',
      message: 'The agent "reviewer" is already registered by the plugin "first".',
      details: { reason: 'exists' },
    }))
    expect(() => registry.agents.register('first', agent('reviewer'))).toThrow(expect.objectContaining({ code: 'conflict' }))
    expect(registry.agents.get('reviewer')).toMatchObject({ pluginId: 'first', definition: { description: 'Agent reviewer.' } })
  })

  it('a disposable removes exactly its entry (idempotent); the name is free again afterwards', () => {
    const registry = core()
    const changes: string[] = []
    registry.onChange(change => changes.push(`${change.kind}:${change.action}:${change.pluginId}:${change.key}`))
    const first = registry.agents.register('first', agent('reviewer'))
    first.dispose()
    first.dispose()
    expect(registry.agents.get('reviewer')).toBeUndefined()
    const second = registry.agents.register('second', agent('reviewer'))
    // A stale handle never removes the newer registration of the same name.
    first.dispose()
    expect(registry.agents.owner('reviewer')).toBe('second')
    second.dispose()
    expect(changes).toEqual([
      'agent:added:first:reviewer',
      'agent:removed:first:reviewer',
      'agent:added:second:reviewer',
      'agent:removed:second:reviewer',
    ])
  })

  it('stores a frozen copy: changing the object a plugin passed changes nothing', () => {
    const registry = core()
    const tools = ['read_file']
    const input = agent('reviewer', { tools, description: '  Reviews.  ' })
    registry.agents.register('acme', input)
    input.instructions = 'Ignore every rule.'
    tools.push('shell')
    const stored = registry.agents.get('reviewer')!
    expect(stored.definition).toEqual({ name: 'reviewer', description: 'Reviews.', instructions: 'You are reviewer.', tools: ['read_file'] })
    expect(Object.isFrozen(stored)).toBe(true)
    expect(Object.isFrozen(stored.definition)).toBe(true)
    expect(Object.isFrozen(stored.definition.tools)).toBe(true)
  })
})

describe('skill registry', () => {
  it('registers, lists by name, reports the owner and refuses a duplicate name with conflict', () => {
    const registry = core()
    registry.skills.register('acme', skill('release-notes'))
    registry.skills.register('other', skill('commit-message'))
    expect(registry.skills.list().map(entry => `${entry.pluginId}:${entry.definition.name}`)).toEqual(['other:commit-message', 'acme:release-notes'])
    expect(registry.skills.owner('release-notes')).toBe('acme')
    expect(() => registry.skills.register('other', skill('release-notes'))).toThrow(expect.objectContaining({
      code: 'conflict',
      message: 'The skill "release-notes" is already registered by the plugin "acme".',
    }))
    // The builtin agent names are not reserved for skills; an agent and a skill may share a name.
    registry.skills.register('acme', skill('explore'))
    registry.agents.register('acme', agent('commit-message'))
    expect(registry.skills.owner('explore')).toBe('acme')
    expect(registry.agents.owner('commit-message')).toBe('acme')
  })

  it('validates content and description sizes', () => {
    const registry = core()
    expect(() => registry.skills.register('acme', skill('big', { content: 'x'.repeat(65_537) }))).toThrow(expect.objectContaining({ code: 'validation_error', message: expect.stringContaining('content') }))
    expect(() => registry.skills.register('acme', skill('long', { description: 'x'.repeat(1025) }))).toThrow(expect.objectContaining({ code: 'validation_error', message: expect.stringContaining('description') }))
    expect(registry.skills.list()).toEqual([])
  })
})

describe('change notifications, contributions and owner removal', () => {
  it('kind registries see only their kind; the registry listeners see every kind; dispose unsubscribes', () => {
    const registry = core()
    const agentChanges: string[] = []
    const skillChanges: string[] = []
    const all: string[] = []
    const agentSubscription = registry.agents.onChange(change => agentChanges.push(`${change.action}:${change.key}`))
    registry.skills.onChange(change => skillChanges.push(`${change.action}:${change.key}`))
    registry.onChange(change => all.push(`${change.kind}:${change.action}:${change.key}`))
    const reviewer = registry.agents.register('acme', agent('reviewer'))
    registry.skills.register('acme', skill('notes'))
    registry.commands.register('acme', { name: 'hello', description: 'Says hello.', template: 'Hello' })
    reviewer.dispose()
    agentSubscription.dispose()
    registry.agents.register('acme', agent('later'))
    expect(agentChanges).toEqual(['added:reviewer', 'removed:reviewer'])
    expect(skillChanges).toEqual(['added:notes'])
    expect(all).toEqual(['agent:added:reviewer', 'skill:added:notes', 'command:added:hello', 'agent:removed:reviewer', 'agent:added:later'])
  })

  it('a throwing listener never blocks a registration or the other listeners', () => {
    const registry = core()
    const seen: string[] = []
    registry.agents.onChange(() => {
      throw new Error('listener failed')
    })
    registry.onChange(change => seen.push(change.key))
    expect(() => registry.agents.register('acme', agent('reviewer'))).not.toThrow()
    expect(registry.agents.get('reviewer')).toBeDefined()
    expect(seen).toEqual(['reviewer'])
  })

  it('contributions list the agents and skills of a plugin by name; removeOwner removes them with removed changes', () => {
    const registry = core()
    const removed: string[] = []
    registry.onChange((change) => {
      if (change.action === 'removed')
        removed.push(`${change.kind}:${change.key}`)
    })
    registry.agents.register('acme', agent('zeta'))
    registry.agents.register('acme', agent('alpha'))
    registry.skills.register('acme', skill('notes'))
    registry.agents.register('other', agent('kept'))
    registry.skills.register('other', skill('kept-skill'))
    registry.tools.register('acme', { name: 'acme_tool', description: 'Tool.', inputSchema: z.object({}), execute: async () => 'ok' })
    expect(registry.contributions('acme')).toMatchObject({ tools: ['acme_tool'], agents: ['alpha', 'zeta'], skills: ['notes'] })
    expect(registry.contributions('other')).toMatchObject({ agents: ['kept'], skills: ['kept-skill'] })

    expect(registry.removeOwner('acme')).toBe(4)
    expect(removed.sort()).toEqual(['agent:alpha', 'agent:zeta', 'skill:notes', 'tool:acme_tool'])
    expect(registry.contributions('acme')).toEqual({ providers: [], models: 0, tools: [], mcpServers: [], commands: [], hooks: [], agents: [], skills: [], commandHooks: 0, outputStyles: [] })
    expect(registry.agents.list().map(entry => entry.definition.name)).toEqual(['kept'])
    expect(registry.skills.list().map(entry => entry.definition.name)).toEqual(['kept-skill'])
    expect(registry.removeOwner('acme')).toBe(0)
  })

  it('the kind registries work on any core: notify announces, onChange filters by kind', () => {
    const { core: shared, changes } = standalone()
    const agents = createAgentRegistry(shared)
    const skills = createSkillRegistry(shared)
    const seen: string[] = []
    agents.onChange(change => seen.push(`agent:${change.key}`))
    skills.onChange(change => seen.push(`skill:${change.key}`))
    agents.register('acme', agent('reviewer'))
    skills.register('acme', skill('notes'))
    expect(agents.removeOwner('acme')).toBe(1)
    expect(skills.removeOwner('nobody')).toBe(0)
    expect(seen).toEqual(['agent:reviewer', 'skill:notes', 'agent:reviewer'])
    expect(changes.map(change => `${change.kind}:${change.action}`)).toEqual(['agent:added', 'skill:added', 'agent:removed'])
  })

  it('kindListener filters by kind', () => {
    const seen: string[] = []
    const listener = kindListener('skill', change => seen.push(change.key))
    listener({ kind: 'agent', action: 'added', pluginId: 'a', key: 'x' })
    listener({ kind: 'skill', action: 'added', pluginId: 'a', key: 'y' })
    expect(seen).toEqual(['y'])
  })
})
