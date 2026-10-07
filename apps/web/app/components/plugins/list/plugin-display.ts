// Display rules of the Plugins tab (docs/UI.md 5.4, 8.1, 8.7, 8.8): source badge labels, state labels and dots, the
// contributions summary, browse filters, the order of the installed list and (Phase 10) the rows of a plugin's agents
// and skills (Phase 11: and output styles). Pure functions, shared by the sidebar (PluginsNav), the list page and the
// detail page.
// Phase 12 (ADR-053 / ADR-054, docs/UI.md 8.1, 8.13; W12.9): the source labels `github` -> "GitHub" and `marketplace` ->
// the marketplace's name (`marketplaceNameOf`: the detail's `origin`, else the `<plugin>@<marketplace>` of `sourceRef`,
// else "Marketplace"), the "Claude Code" format badge (`pluginFormatLabel`) and the origin line of the detail page
// (`pluginOriginText`).
import type {
  CustomizationEntry,
  CustomizationShadowedBy,
  PluginContributions,
  PluginFormat,
  PluginKind,
  PluginOrigin,
  PluginSource,
  PluginState,
  PluginSummary,
} from '@harness-forge/shared'
import type { Component } from 'vue'
import type { StatusDotStatus } from '~/components/common/status'
import type { PluginFilter } from '~/stores/plugins'
import { MARKETPLACE_NAME_PATTERN } from '@harness-forge/shared'
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

/** What the source labels read of a plugin: a summary, or a detail with its `origin` (Phase 12). */
export interface PluginSourceSubject {
  source: PluginSource
  kind: PluginKind
  sourceRef?: string | null
  origin?: PluginOrigin | null
}

/**
 * The marketplace a `marketplace` plugin came from (Phase 12, ADR-054): the name in the detail's `origin` (the name at
 * install time), else the `<marketplace>` of a `sourceRef` `<plugin>@<marketplace>` (a summary has no origin); null when
 * neither names one (another source, or a `sourceRef` of another shape).
 */
export function marketplaceNameOf(plugin: Pick<PluginSourceSubject, 'source' | 'sourceRef' | 'origin'>): string | null {
  if (plugin.source !== 'marketplace')
    return null
  if (plugin.origin?.kind === 'marketplace')
    return plugin.origin.marketplace
  const ref = plugin.sourceRef ?? ''
  const at = ref.lastIndexOf('@')
  if (at <= 0)
    return null
  const entry = ref.slice(0, at)
  const name = ref.slice(at + 1)
  // `owner/repo@<sha>[/path]` names a repository and a commit, not a marketplace.
  return !entry.includes('/') && MARKETPLACE_NAME_PATTERN.test(name) ? name : null
}

/**
 * Source badge label: builtin -> Core, created -> Declarative / Code by kind, zip, npm, URL, and Local for linked or
 * copied folders; Phase 12: github -> GitHub, marketplace -> the marketplace's name ("Marketplace" when unknown).
 */
export function pluginSourceLabel(plugin: PluginSourceSubject): string {
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
    // Phase 12 (ADR-054).
    case 'github':
      return 'GitHub'
    case 'marketplace':
      return marketplaceNameOf(plugin) ?? 'Marketplace'
  }
}

/** Longer wording of the source for tooltips and read-only notes ("Installed from npm"). */
export function pluginSourceDescription(plugin: Pick<PluginSummary, 'source' | 'kind' | 'sourceRef'> & { origin?: PluginOrigin | null }): string {
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
    // Phase 12 (ADR-054).
    case 'github':
      return `Installed from GitHub${ref}`
    case 'marketplace': {
      const name = marketplaceNameOf(plugin)
      return name ? `Installed from the marketplace ${name}${ref}` : `Installed from a marketplace${ref}`
    }
  }
}

/** The format badge of a plugin (Phase 12, ADR-053, docs/UI.md 8.1): "Claude Code" for a Claude Code plugin, else null. */
export function pluginFormatLabel(format: PluginFormat | undefined): string | null {
  return format === 'claude' ? 'Claude Code' : null
}

/** The first 7 characters of a commit. */
export function shortCommit(commit: string): string {
  return commit.slice(0, 7)
}

/**
 * The origin line of the detail page (Phase 12, ADR-054, docs/UI.md 8.13): "From {marketplace}" (+ " · {sha7}" for an
 * entry fetched at a commit) or "GitHub · {repo}@{sha7}" (+ " · {path}" for a folder of the repository), with the full
 * commit for a title; null without an origin.
 */
export function pluginOriginText(origin: PluginOrigin | null | undefined): { text: string, commit: string | null } | null {
  if (!origin)
    return null
  if (origin.kind === 'marketplace') {
    const commit = origin.commit ?? null
    return { text: `From ${origin.marketplace}${commit ? ` · ${shortCommit(commit)}` : ''}`, commit }
  }
  return {
    text: `GitHub · ${origin.repo}@${shortCommit(origin.commit)}${origin.path ? ` · ${origin.path}` : ''}`,
    commit: origin.commit,
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
