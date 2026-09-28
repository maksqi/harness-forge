import { describe, expect, it } from 'vitest'
import { pluginSummary } from '~/utils/testing/fixtures'
import {
  contributionsSummary,
  countLabel,
  pluginDetailRoute,
  pluginFilterLabel,
  pluginFilterRoute,
  pluginSourceDescription,
  pluginSourceLabel,
  pluginStateDot,
  sortPluginsByName,
} from './plugin-display'

const none = { providers: [], models: 0, tools: [], mcpServers: [], commands: [], hooks: [] }

describe('plugin display rules', () => {
  it('labels every source like the source badge of docs/UI.md 8.1', () => {
    expect(pluginSourceLabel({ source: 'builtin', kind: 'code' })).toBe('Core')
    expect(pluginSourceLabel({ source: 'created', kind: 'declarative' })).toBe('Declarative')
    expect(pluginSourceLabel({ source: 'created', kind: 'code' })).toBe('Code')
    expect(pluginSourceLabel({ source: 'zip', kind: 'code' })).toBe('zip')
    expect(pluginSourceLabel({ source: 'npm', kind: 'declarative' })).toBe('npm')
    expect(pluginSourceLabel({ source: 'url', kind: 'declarative' })).toBe('URL')
    expect(pluginSourceLabel({ source: 'link', kind: 'code' })).toBe('Local')
    expect(pluginSourceLabel({ source: 'copy', kind: 'code' })).toBe('Local')
    expect(pluginSourceDescription({ source: 'npm', kind: 'code', sourceRef: 'pkg@1.0.0' })).toBe('Installed from npm (pkg@1.0.0)')
    expect(pluginSourceDescription({ source: 'link', kind: 'code', sourceRef: null })).toBe('Linked local folder')
  })

  it('maps states to sidebar dots', () => {
    expect(['active', 'disabled', 'loading', 'untrusted', 'incompatible', 'error'].map(state => pluginStateDot(state as never)))
      .toEqual(['ok', 'off', 'running', 'warning', 'warning', 'error'])
  })

  it('summarizes contributions with singular and plural nouns', () => {
    expect(contributionsSummary({ ...none, providers: ['a', 'b'], tools: ['x', 'y', 'z'], mcpServers: ['m'], commands: ['c', 'd'] }))
      .toBe('2 providers · 3 tools · 1 MCP server · 2 commands')
    expect(contributionsSummary({ ...none, providers: ['a'], models: 12 })).toBe('1 provider')
    expect(contributionsSummary({ ...none, models: 12 })).toBe('12 models')
    expect(contributionsSummary({ ...none, hooks: ['chat.before'] })).toBe('1 hook')
    expect(contributionsSummary(none)).toBe('')
    expect(countLabel(1, 'MCP server')).toBe('1 MCP server')
  })

  it('orders builtins first, then by name without case, then by id', () => {
    const sorted = sortPluginsByName([
      pluginSummary({ id: 'b', name: 'beta' }),
      pluginSummary({ id: 'core-tools', name: 'Core tools', builtin: true }),
      pluginSummary({ id: 'a2', name: 'Alpha' }),
      pluginSummary({ id: 'a1', name: 'alpha' }),
      pluginSummary({ id: 'core-providers', name: 'Core providers', builtin: true }),
    ])
    expect(sorted.map(plugin => plugin.id)).toEqual(['core-tools', 'core-providers', 'a1', 'a2', 'b'])
  })

  it('builds filter and detail routes', () => {
    expect(pluginFilterRoute('all')).toBe('/plugins')
    expect(pluginFilterRoute('mcp')).toEqual({ path: '/plugins', query: { filter: 'mcp' } })
    expect(pluginFilterLabel('mcp')).toBe('MCP servers')
    expect(pluginDetailRoute('dice-roller')).toBe('/plugins/dice-roller')
    expect(pluginDetailRoute('dice-roller', 'logs')).toBe('/plugins/dice-roller?tab=logs')
    expect(pluginDetailRoute('dice-roller', 'overview')).toBe('/plugins/dice-roller')
  })
})
