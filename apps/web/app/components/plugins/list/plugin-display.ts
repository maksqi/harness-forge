// Display rules of the Plugins tab (docs/UI.md 5.4, 8.1, 8.7): source badge labels, state labels and dots, the
// contributions summary, browse filters and the order of the installed list. Pure functions, shared by the sidebar
// (PluginsNav), the list page and the detail page.
import type { PluginContributions, PluginKind, PluginSource, PluginState, PluginSummary } from '@harness-forge/shared'
import type { Component } from 'vue'
import type { StatusDotStatus } from '~/components/common/status'
import type { PluginFilter } from '~/stores/plugins'
import {
  BoxesIcon,
  CircleOffIcon,
  LayoutGridIcon,
  PlugZapIcon,
  ServerIcon,
  SquareSlashIcon,
  WrenchIcon,
} from '@lucide/vue'

// ---------- browse filters ----------

export interface PluginFilterOption {
  value: PluginFilter
  label: string
  icon: Component
}

/** The Browse filters of the sidebar and the filter select of the list page, in display order. */
export const PLUGIN_FILTER_OPTIONS: readonly PluginFilterOption[] = [
  { value: 'all', label: 'All', icon: LayoutGridIcon },
  { value: 'providers', label: 'Providers', icon: PlugZapIcon },
  { value: 'tools', label: 'Tools', icon: WrenchIcon },
  { value: 'mcp', label: 'MCP servers', icon: ServerIcon },
  { value: 'commands', label: 'Commands', icon: SquareSlashIcon },
  { value: 'disabled', label: 'Disabled', icon: CircleOffIcon },
]

/** Label of a filter value ("MCP servers"). */
export function pluginFilterLabel(filter: PluginFilter): string {
  return PLUGIN_FILTER_OPTIONS.find(option => option.value === filter)?.label ?? 'All'
}

/** Route of a browse filter: `/plugins` for `all`, else `/plugins?filter=<value>` (docs/DECISIONS.md). */
export function pluginFilterRoute(filter: PluginFilter): string | { path: string, query: { filter: PluginFilter } } {
  return filter === 'all' ? '/plugins' : { path: '/plugins', query: { filter } }
}

// ---------- source and state ----------

/**
 * Source badge label: builtin -> Core, created -> Declarative / Code by kind, zip, npm, URL, and Local for linked or
 * copied folders.
 */
export function pluginSourceLabel(plugin: { source: PluginSource, kind: PluginKind }): string {
  switch (plugin.source) {
    case 'builtin':
      return 'Core'
    case 'created':
      return plugin.kind === 'code' ? 'Code' : 'Declarative'
    case 'zip':
      return 'zip'
    case 'npm':
      return 'npm'
    case 'url':
      return 'URL'
    case 'link':
    case 'copy':
      return 'Local'
  }
}

/** Longer wording of the source for tooltips and read-only notes ("Installed from npm"). */
export function pluginSourceDescription(plugin: Pick<PluginSummary, 'source' | 'kind' | 'sourceRef'>): string {
  const ref = plugin.sourceRef ? ` (${plugin.sourceRef})` : ''
  switch (plugin.source) {
    case 'builtin':
      return 'Built into harness-forge'
    case 'created':
      return plugin.kind === 'code' ? 'Created in harness-forge from a code template' : 'Created in harness-forge with the provider wizard'
    case 'zip':
      return `Installed from a zip file${ref}`
    case 'npm':
      return `Installed from npm${ref}`
    case 'url':
      return `Installed from a URL${ref}`
    case 'link':
      return `Linked local folder${ref}`
    case 'copy':
      return `Copied from a local folder${ref}`
  }
}

export const PLUGIN_STATE_LABELS: Record<PluginState, string> = {
  active: 'Active',
  disabled: 'Disabled',
  loading: 'Loading',
  untrusted: 'Untrusted',
  incompatible: 'Incompatible',
  error: 'Error',
}

/** Status dot of a plugin state (docs/UI.md 5.4): active ok, disabled off, loading running, untrusted/incompatible warning, error. */
export function pluginStateDot(state: PluginState): StatusDotStatus {
  switch (state) {
    case 'active':
      return 'ok'
    case 'disabled':
      return 'off'
    case 'loading':
      return 'running'
    case 'untrusted':
    case 'incompatible':
      return 'warning'
    case 'error':
      return 'error'
  }
}

// ---------- contributions ----------

/** "1 provider" / "3 tools": the count with the singular or plural noun. */
export function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

/**
 * One-line summary of what a plugin adds: "2 providers · 3 tools · 1 MCP server · 2 commands". Models are listed
 * only for plugins that add models without providers of their own; hooks are listed last. Empty when nothing is
 * registered.
 */
export function contributionsSummary(contributions: PluginContributions): string {
  const parts: string[] = []
  if (contributions.providers.length > 0)
    parts.push(countLabel(contributions.providers.length, 'provider'))
  else if (contributions.models > 0)
    parts.push(countLabel(contributions.models, 'model'))
  if (contributions.tools.length > 0)
    parts.push(countLabel(contributions.tools.length, 'tool'))
  if (contributions.mcpServers.length > 0)
    parts.push(countLabel(contributions.mcpServers.length, 'MCP server'))
  if (contributions.commands.length > 0)
    parts.push(countLabel(contributions.commands.length, 'command'))
  if (contributions.hooks.length > 0)
    parts.push(countLabel(contributions.hooks.length, 'hook'))
  return parts.join(' · ')
}

// ---------- ordering ----------

/** Builtins first (in server order), then everything else by name (case-insensitive), then by id. */
export function sortPluginsByName(items: readonly PluginSummary[]): PluginSummary[] {
  const builtins = items.filter(plugin => plugin.builtin)
  const others = items
    .filter(plugin => !plugin.builtin)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) || a.id.localeCompare(b.id))
  return [...builtins, ...others]
}

// ---------- links ----------

/** The detail page of a plugin, optionally on a tab. */
export function pluginDetailRoute(id: string, tab?: 'overview' | 'configuration' | 'source' | 'logs'): string {
  const path = `/plugins/${encodeURIComponent(id)}`
  return tab && tab !== 'overview' ? `${path}?tab=${tab}` : path
}

/** Glyph of a builtin plugin without an icon of its own (drawn instead of a monogram). */
export const BUILTIN_PLUGIN_GLYPHS: Readonly<Record<string, Component>> = {
  'core-providers': BoxesIcon,
  'core-tools': WrenchIcon,
  'core-commands': SquareSlashIcon,
  'core-mcp': ServerIcon,
}
