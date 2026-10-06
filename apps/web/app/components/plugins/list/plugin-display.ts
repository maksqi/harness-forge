// Display rules of the Plugins tab (docs/UI.md 5.4, 8.1, 8.7, 8.8): source badge labels, state labels and dots, the
// contributions summary, browse filters, the order of the installed list and (Phase 10) the rows of a plugin's agents
// and skills (Phase 11: and output styles). Pure functions, shared by the sidebar (PluginsNav), the list page and the
// detail page.
import type {
  CustomizationEntry,
  CustomizationShadowedBy,
  PluginContributions,
  PluginKind,
  PluginSource,
  PluginState,
  PluginSummary,
} from '@harness-forge/shared'
import type { Component } from 'vue'
import type { StatusDotStatus } from '~/components/common/status'
import type { PluginFilter } from '~/stores/plugins'
import {
  BotIcon,
  BoxesIcon,
  CircleOffIcon,
  FolderCodeIcon,
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
  { value: 'agents', label: 'Agents and skills', icon: BotIcon },
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
 * One-line summary of what a plugin adds: "2 providers · 3 tools · 1 MCP server · 2 commands · 2 agents · 1 skill ·
 * 1 output style · 2 hooks" (agents and skills since plugin API 1.4.0; output styles and command hooks since 1.5.0, in
 * the order of the Customize tabs). Models are listed only for plugins that add models without providers of their own;
 * hooks (code hooks and command hook handlers together) are listed last. Empty when nothing is registered.
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
  if (contributions.agents.length > 0)
    parts.push(countLabel(contributions.agents.length, 'agent'))
  if (contributions.skills.length > 0)
    parts.push(countLabel(contributions.skills.length, 'skill'))
  if (contributions.outputStyles.length > 0)
    parts.push(countLabel(contributions.outputStyles.length, 'output style'))
  const hooks = contributions.hooks.length + contributions.commandHooks
  if (hooks > 0)
    parts.push(countLabel(hooks, 'hook'))
  return parts.join(' · ')
}

// ---------- agents and skills (Phase 10, plugin API 1.4.0) ----------

/** The kinds a plugin contributes to the customization catalog (docs/UI.md 8.8; Phase 11: output styles). */
export type PluginCustomizationKind = 'agent' | 'skill' | 'style'

const CUSTOMIZE_TAB_OF: Readonly<Record<PluginCustomizationKind | 'hook', 'agents' | 'skills' | 'output-styles' | 'hooks'>> = {
  agent: 'agents',
  skill: 'skills',
  style: 'output-styles',
  hook: 'hooks',
}

/**
 * "Open in Customize": Settings -> Customize on the tab of the kind (`?tab=agents` / `?tab=skills`; Phase 11:
 * `?tab=output-styles`, and `?tab=hooks` for the plugin's hooks).
 */
export function customizeRoute(kind: PluginCustomizationKind | 'hook'): { path: string, query: { tab: 'agents' | 'skills' | 'output-styles' | 'hooks' } } {
  return { path: '/settings/customize', query: { tab: CUSTOMIZE_TAB_OF[kind] } }
}

/**
 * The meta line of a plugin agent (docs/UI.md 8.8): the model ("Default model" when unset, "Same as the chat" for
 * `inherit`, else the model id) and the tools ("All tools" without a list, "No tools" for an empty one, else "{n}
 * tools"). Skills have no meta line.
 */
export function customizationMeta(entry: Pick<CustomizationEntry, 'kind' | 'modelRef' | 'tools'>): string[] {
  if (entry.kind !== 'agent')
    return []
  const model = entry.modelRef === undefined
    ? 'Default model'
    : entry.modelRef === 'inherit' ? 'Same as the chat' : entry.modelRef
  const tools = entry.tools === undefined
    ? 'All tools'
    : entry.tools.length === 0 ? 'No tools' : countLabel(entry.tools.length, 'tool')
  return [model, tools]
}

/** The kind as a word in UI copy (docs/UI.md 15): a `style` entry is an "output style". */
const KIND_NOUN: Readonly<Record<CustomizationEntry['kind'], string>> = {
  agent: 'agent',
  command: 'command',
  skill: 'skill',
  style: 'output style',
}

/**
 * The tooltip of a "Shadowed" row (docs/UI.md 8.8, 9.12): "Not used: {winner} wins.", where the winner is "your
 * personal agent", "the project's .harness/agents/x.md", "the agent from {plugin}" or "the built-in agent" ("your
 * personal output style", … for a style). Null for an entry that is not shadowed.
 */
export function shadowedNote(
  entry: Pick<CustomizationEntry, 'kind' | 'state' | 'shadowedBy'>,
  pluginName: (id: string) => string,
): string | null {
  if (entry.state !== 'shadowed')
    return null
  return `Not used: ${shadowWinner(entry.kind, entry.shadowedBy, pluginName)} wins.`
}

function shadowWinner(
  entryKind: CustomizationEntry['kind'],
  winner: CustomizationShadowedBy | undefined,
  pluginName: (id: string) => string,
): string {
  const kind = KIND_NOUN[entryKind]
  switch (winner?.source) {
    case 'user':
      return `your personal ${kind}`
    case 'project':
      return winner.path ? `the project's ${winner.path}` : `the project's ${kind}`
    case 'plugin':
      return winner.pluginId ? `the ${kind} from ${pluginName(winner.pluginId)}` : `a plugin's ${kind}`
    case 'builtin':
      return `the built-in ${kind}`
    default:
      return `another ${kind} of the same name`
  }
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
  'core-workspace': FolderCodeIcon,
  // Phase 9: the agent tools (todo_write, exit_plan_mode, task).
  'core-agent': BotIcon,
}
