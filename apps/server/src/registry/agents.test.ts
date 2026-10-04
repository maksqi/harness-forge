// The agent and skill registries of plugin API 1.4.0 (Phase 10, C30-T4): empty until W10.7 (nothing registered,
// `register` answers `not_implemented`), subscribable per kind, wired into the registry and its contributions.
import type { RegistryChange } from './types.ts'
import { describe, expect, it } from 'vitest'
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

describe('agent and skill registries (empty until W10.7)', () => {
  it('the registry has agents and skills: nothing listed, register answers not_implemented', () => {
    const registry = core()
    for (const definitions of [registry.agents, registry.skills]) {
      expect(definitions.list()).toEqual([])
      expect(definitions.get('reviewer')).toBeUndefined()
      expect(definitions.owner('reviewer')).toBeUndefined()
    }
    expect(() => registry.agents.register('acme', { name: 'reviewer', description: 'Reviews.', instructions: 'Review.' })).toThrow(expect.objectContaining({ code: 'not_implemented' }))
    expect(() => registry.skills.register('acme', { name: 'notes', description: 'Notes.', content: '# Notes' })).toThrow(expect.objectContaining({ code: 'not_implemented' }))
    expect(registry.contributions('acme')).toMatchObject({ agents: [], skills: [] })
  })

  it('onChange of a kind registry receives only its kind; disposing unsubscribes; the registry listeners see every kind', () => {
    const listeners = new Set<(change: RegistryChange) => void>()
    const shared = {
      onChange: (listener: (change: RegistryChange) => void) => {
        listeners.add(listener)
        return { dispose: () => void listeners.delete(listener) }
      },
    }
    const agents = createAgentRegistry(shared)
    const skills = createSkillRegistry(shared)
    const seen: string[] = []
    const agentSub = agents.onChange(change => seen.push(`agent:${change.key}`))
    skills.onChange(change => seen.push(`skill:${change.key}`))
    const emit = (change: RegistryChange): void => {
      for (const listener of [...listeners])
        listener(change)
    }
    emit({ kind: 'agent', action: 'added', pluginId: 'acme', key: 'reviewer' })
    emit({ kind: 'skill', action: 'added', pluginId: 'acme', key: 'notes' })
    emit({ kind: 'tool', action: 'added', pluginId: 'acme', key: 'echo' })
    agentSub.dispose()
    emit({ kind: 'agent', action: 'removed', pluginId: 'acme', key: 'reviewer' })
    expect(seen).toEqual(['agent:reviewer', 'skill:notes'])
  })

  it('kind registries subscribe through the registry: a registry change of another kind never reaches them', () => {
    const registry = core()
    const seen: RegistryChange[] = []
    const all: RegistryChange[] = []
    registry.agents.onChange(change => seen.push(change))
    registry.skills.onChange(change => seen.push(change))
    registry.onChange(change => all.push(change))
    const disposable = registry.commands.register('acme', { name: 'hello', description: 'Says hello.', template: 'Hello' })
    disposable.dispose()
    expect(all.map(change => `${change.kind}:${change.action}`)).toEqual(['command:added', 'command:removed'])
    expect(seen).toEqual([])
  })

  it('kindListener filters by kind', () => {
    const seen: string[] = []
    const listener = kindListener('skill', change => seen.push(change.key))
    listener({ kind: 'agent', action: 'added', pluginId: 'a', key: 'x' })
    listener({ kind: 'skill', action: 'added', pluginId: 'a', key: 'y' })
    expect(seen).toEqual(['y'])
  })
})
