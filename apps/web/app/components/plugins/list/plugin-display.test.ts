import { BUILTIN_PLUGIN_IDS, MOCK_PROVIDER_ID } from '@harness-forge/shared'
import { BotIcon, FolderCodeIcon } from '@lucide/vue'
import { describe, expect, it } from 'vitest'
import { commitSha, customizationEntry, pluginOrigin, pluginSummary } from '~/utils/testing/fixtures'
import {
  BUILTIN_PLUGIN_GLYPHS,
  contributionsSummary,
  countLabel,
  customizationMeta,
  customizeRoute,
  marketplaceNameOf,
  PLUGIN_FILTER_OPTIONS,
  pluginDetailRoute,
  pluginFilterLabel,
  pluginFilterRoute,
  pluginFormatLabel,
  pluginOriginText,
  pluginSourceDescription,
  pluginSourceLabel,
  pluginStateDot,
  shadowedNote,
  sortPluginsByName,
} from './plugin-display'

const none = { providers: [], models: 0, tools: [], mcpServers: [], commands: [], hooks: [], agents: [], skills: [], commandHooks: 0, outputStyles: [] }

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

  it('adds agents and skills after commands and before hooks (Phase 10)', () => {
    expect(contributionsSummary({ ...none, agents: ['a', 'b'], skills: ['s'] })).toBe('2 agents · 1 skill')
    expect(contributionsSummary({ ...none, agents: ['a'] })).toBe('1 agent')
    expect(contributionsSummary({ ...none, skills: ['s', 't'] })).toBe('2 skills')
    expect(contributionsSummary({ ...none, tools: ['x'], commands: ['c', 'd'], agents: ['a', 'b'], skills: ['s'], hooks: ['chat.before'] }))
      .toBe('1 tool · 2 commands · 2 agents · 1 skill · 1 hook')
  })

  it('adds output styles and counts command hooks with the code hooks (Phase 11)', () => {
    expect(contributionsSummary({ ...none, commandHooks: 1, hooks: ['prompt.submit'], outputStyles: ['terse'] })).toBe('1 output style · 2 hooks')
    expect(contributionsSummary({ ...none, commandHooks: 1 })).toBe('1 hook')
    expect(contributionsSummary({ ...none, skills: ['s'], outputStyles: ['a', 'b'] })).toBe('1 skill · 2 output styles')
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

  it('offers the "Agents and skills" filter with the agent glyph (Phase 10)', () => {
    expect(PLUGIN_FILTER_OPTIONS.map(option => option.value)).toEqual(['all', 'providers', 'tools', 'mcp', 'commands', 'agents', 'disabled'])
    expect(pluginFilterLabel('agents')).toBe('Agents and skills')
    expect(PLUGIN_FILTER_OPTIONS.find(option => option.value === 'agents')?.icon).toBe(BotIcon)
    expect(pluginFilterRoute('agents')).toEqual({ path: '/plugins', query: { filter: 'agents' } })
  })

  it('describes a plugin agent by its model and tools; skills have no meta line (Phase 10)', () => {
    const agent = { kind: 'agent' as const, modelRef: undefined, tools: undefined }
    expect(customizationMeta(agent)).toEqual(['Default model', 'All tools'])
    expect(customizationMeta({ ...agent, modelRef: 'inherit', tools: ['read_file'] })).toEqual(['Same as the chat', '1 tool'])
    expect(customizationMeta({ ...agent, modelRef: 'anthropic:claude-haiku-5', tools: ['read_file', 'search_files'] }))
      .toEqual(['anthropic:claude-haiku-5', '2 tools'])
    expect(customizationMeta({ ...agent, tools: [] })).toEqual(['Default model', 'No tools'])
    expect(customizationMeta({ kind: 'skill', modelRef: undefined, tools: undefined })).toEqual([])
  })

  it('names the winner of a shadowed agent or skill (Phase 10)', () => {
    const pluginName = (id: string) => (id === 'db-tools' ? 'Database tools' : id)
    const entry = customizationEntry({ source: 'plugin', pluginId: 'agent-pack', path: undefined })
    expect(shadowedNote(entry, pluginName)).toBeNull()
    const shadowed = { ...entry, state: 'shadowed' as const }
    expect(shadowedNote({ ...shadowed, shadowedBy: { source: 'user' } }, pluginName)).toBe('Not used: your personal agent wins.')
    expect(shadowedNote({ ...shadowed, kind: 'skill', shadowedBy: { source: 'user' } }, pluginName)).toBe('Not used: your personal skill wins.')
    expect(shadowedNote({ ...shadowed, shadowedBy: { source: 'project', path: '.harness/agents/reviewer.md' } }, pluginName))
      .toBe('Not used: the project\'s .harness/agents/reviewer.md wins.')
    expect(shadowedNote({ ...shadowed, shadowedBy: { source: 'plugin', pluginId: 'db-tools' } }, pluginName))
      .toBe('Not used: the agent from Database tools wins.')
    expect(shadowedNote({ ...shadowed, shadowedBy: { source: 'builtin' } }, pluginName)).toBe('Not used: the built-in agent wins.')
    expect(shadowedNote({ ...shadowed, shadowedBy: undefined }, pluginName)).toBe('Not used: another agent of the same name wins.')
  })

  it('names a shadowed style an "output style", never by its raw kind (Phase 11)', () => {
    const pluginName = (id: string) => (id === 'db-tools' ? 'Database tools' : id)
    const style = { ...customizationEntry({ source: 'plugin', pluginId: 'style-pack', path: undefined }), kind: 'style' as const, state: 'shadowed' as const }
    expect(shadowedNote({ ...style, shadowedBy: { source: 'user' } }, pluginName)).toBe('Not used: your personal output style wins.')
    expect(shadowedNote({ ...style, shadowedBy: { source: 'project' } }, pluginName)).toBe('Not used: the project\'s output style wins.')
    expect(shadowedNote({ ...style, shadowedBy: { source: 'project', path: '.harness/output-styles/terse.md' } }, pluginName))
      .toBe('Not used: the project\'s .harness/output-styles/terse.md wins.')
    expect(shadowedNote({ ...style, shadowedBy: { source: 'plugin', pluginId: 'db-tools' } }, pluginName))
      .toBe('Not used: the output style from Database tools wins.')
    expect(shadowedNote({ ...style, shadowedBy: { source: 'plugin' } }, pluginName)).toBe('Not used: a plugin\'s output style wins.')
    expect(shadowedNote({ ...style, shadowedBy: { source: 'builtin' } }, pluginName)).toBe('Not used: the built-in output style wins.')
    expect(shadowedNote({ ...style, shadowedBy: undefined }, pluginName)).toBe('Not used: another output style of the same name wins.')
  })

  it('links agents and skills to their Customize tab (Phase 10)', () => {
    expect(customizeRoute('agent')).toEqual({ path: '/settings/customize', query: { tab: 'agents' } })
    expect(customizeRoute('skill')).toEqual({ path: '/settings/customize', query: { tab: 'skills' } })
    // Phase 11: output styles and hooks.
    expect(customizeRoute('style')).toEqual({ path: '/settings/customize', query: { tab: 'output-styles' } })
    expect(customizeRoute('hook')).toEqual({ path: '/settings/customize', query: { tab: 'hooks' } })
  })

  it('draws a glyph for every core plugin, the agent tools included (Phase 9)', () => {
    for (const id of BUILTIN_PLUGIN_IDS.filter(id => id !== MOCK_PROVIDER_ID))
      expect(BUILTIN_PLUGIN_GLYPHS[id], id).toBeDefined()
    expect(BUILTIN_PLUGIN_GLYPHS['core-workspace']).toBe(FolderCodeIcon)
    expect(BUILTIN_PLUGIN_GLYPHS['core-agent']).toBe(BotIcon)
    expect(new Set(Object.values(BUILTIN_PLUGIN_GLYPHS)).size).toBe(Object.keys(BUILTIN_PLUGIN_GLYPHS).length)
  })

  it('labels GitHub and marketplace sources: a marketplace plugin by its marketplace name (Phase 12)', () => {
    expect(pluginSourceLabel({ source: 'github', kind: 'declarative', sourceRef: 'anthropics/review-kit@0123456789ab' })).toBe('GitHub')
    // A detail names its marketplace through its origin, a summary through `sourceRef` `<plugin>@<marketplace>`.
    expect(pluginSourceLabel({ source: 'marketplace', kind: 'declarative', sourceRef: null, origin: pluginOrigin({ marketplace: 'team-tools' }) })).toBe('team-tools')
    expect(pluginSourceLabel({ source: 'marketplace', kind: 'declarative', sourceRef: 'review-kit@claude-plugins-official' })).toBe('claude-plugins-official')
    expect(pluginSourceLabel({ source: 'marketplace', kind: 'declarative', sourceRef: 'acme/tools@0123456789ab/plugins/x' })).toBe('Marketplace')
    expect(pluginSourceLabel({ source: 'marketplace', kind: 'declarative' })).toBe('Marketplace')
    expect(marketplaceNameOf({ source: 'github', sourceRef: 'a@b' })).toBeNull()
    expect(marketplaceNameOf({ source: 'marketplace', sourceRef: '@acme' })).toBeNull()
    expect(marketplaceNameOf({ source: 'marketplace', sourceRef: 'x@bad name' })).toBeNull()
    expect(pluginSourceDescription({ source: 'github', kind: 'declarative', sourceRef: 'anthropics/review-kit@0123456789ab' }))
      .toBe('Installed from GitHub (anthropics/review-kit@0123456789ab)')
    expect(pluginSourceDescription({ source: 'marketplace', kind: 'declarative', sourceRef: 'review-kit@acme' })).toBe('Installed from the marketplace acme (review-kit@acme)')
    expect(pluginSourceDescription({ source: 'marketplace', kind: 'declarative', sourceRef: null })).toBe('Installed from a marketplace')
  })

  it('names the Claude Code format and the origin of GitHub and marketplace installs (Phase 12)', () => {
    expect(pluginFormatLabel('claude')).toBe('Claude Code')
    expect(pluginFormatLabel('harness')).toBeNull()
    expect(pluginFormatLabel(undefined)).toBeNull()
    expect(pluginOriginText(null)).toBeNull()
    expect(pluginOriginText(pluginOrigin({ marketplace: 'claude-plugins-official', commit: commitSha(3) })))
      .toEqual({ text: 'From claude-plugins-official · 3333333', commit: commitSha(3) })
    expect(pluginOriginText(pluginOrigin({ sourceKind: 'npm', commit: undefined, npmVersion: '1.0.0' })))
      .toEqual({ text: 'From claude-plugins-official', commit: null })
    const commit = '3f2a9c1d0e4b5a6978877665544332211aabbccd'
    expect(pluginOriginText({ kind: 'github', repo: 'anthropics/review-kit', ref: 'main', commit, path: null }))
      .toEqual({ text: 'GitHub · anthropics/review-kit@3f2a9c1', commit })
    expect(pluginOriginText({ kind: 'github', repo: 'anthropics/plugins', ref: null, commit, path: 'plugins/review-kit' })?.text)
      .toBe('GitHub · anthropics/plugins@3f2a9c1 · plugins/review-kit')
  })
})
