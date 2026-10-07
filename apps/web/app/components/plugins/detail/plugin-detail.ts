// Rules of the plugin detail page (docs/UI.md 2.4, 8.7, 8.8, 8.11): which tabs a plugin has, the header actions it
// offers, permission and policy wording, MCP status dots, and the log view helpers. Pure functions.
// Phase 12 (ADR-053, docs/UI.md 8.13; W12.9): a Claude Code plugin (`format: 'claude'`) has no Source tab and no Edit in
// wizard (its files are not editable in v1.8; the server also answers `editable: false`).
import type {
  LogLevel,
  McpServer,
  McpStatus,
  PluginDetail,
  PluginFormat,
  PluginLogEntry,
  PluginPermission,
  ToolOverride,
  ToolPolicy,
} from '@harness-forge/shared'
import type { StatusDotStatus } from '~/components/common/status'

// ---------- tabs ----------

export const PLUGIN_TABS = ['overview', 'configuration', 'source', 'logs'] as const
export type PluginTab = (typeof PLUGIN_TABS)[number]

export const PLUGIN_TAB_LABELS: Record<PluginTab, string> = {
  overview: 'Overview',
  configuration: 'Configuration',
  source: 'Source',
  logs: 'Logs',
}

type TabSubject = Pick<PluginDetail, 'builtin' | 'kind' | 'editable' | 'hasSettings'> & { format?: PluginFormat }

/**
 * The Source tab: code plugins (read-only unless the plugin is editable) and editable declarative plugins, whose
 * `plugin.json` can be edited there. Builtins have no files; Claude Code plugins (Phase 12) have no editor.
 */
export function hasSourceTab(plugin: TabSubject): boolean {
  return !plugin.builtin && plugin.format !== 'claude' && (plugin.kind === 'code' || plugin.editable)
}

/** Tabs of a plugin in display order: Overview, Configuration (with a settings schema), Source, Logs. */
export function pluginTabs(plugin: TabSubject): PluginTab[] {
  return PLUGIN_TABS.filter((tab) => {
    if (tab === 'configuration')
      return plugin.hasSettings
    if (tab === 'source')
      return hasSourceTab(plugin)
    return true
  })
}

/** The tab of a `?tab=` value: a missing, unknown or hidden tab falls back to Overview. */
export function resolvePluginTab(value: unknown, tabs: readonly PluginTab[]): PluginTab {
  const raw = Array.isArray(value) ? value[0] : value
  return typeof raw === 'string' && (tabs as readonly string[]).includes(raw) ? raw as PluginTab : 'overview'
}

// ---------- header actions ----------

/** "Edit in wizard": declarative plugins created with the provider wizard (never a Claude Code plugin). */
export function canEditInWizard(plugin: Pick<PluginDetail, 'source' | 'kind'> & { format?: PluginFormat }): boolean {
  return plugin.source === 'created' && plugin.kind === 'declarative' && plugin.format !== 'claude'
}

/** Builtins are part of the server: they cannot be exported or uninstalled. */
export function canExport(plugin: Pick<PluginDetail, 'builtin'>): boolean {
  return !plugin.builtin
}

export function canUninstall(plugin: Pick<PluginDetail, 'builtin' | 'removable'>): boolean {
  return !plugin.builtin && plugin.removable
}

// ---------- overview ----------

/** Trust dialog wording of the advisory permissions (docs/PLUGINS.md section 3). */
export const PERMISSION_LABELS: Record<PluginPermission, string> = {
  network: 'Connects to the network',
  secrets: 'Stores secrets',
  storage: 'Stores data',
  hooks: 'Reads and changes conversations',
  process: 'Starts programs',
}

export function permissionLabel(permission: string): string {
  return (PERMISSION_LABELS as Record<string, string>)[permission] ?? permission
}

export const TOOL_POLICY_LABELS: Record<ToolPolicy, string> = {
  safe: 'Safe',
  ask: 'Ask',
  always: 'Always ask',
}

export const TOOL_POLICY_HINTS: Record<ToolPolicy | 'dynamic', string> = {
  safe: 'Runs without asking.',
  ask: 'Asks before it runs, unless the chat allows tools automatically.',
  always: 'Always asks before it runs.',
  dynamic: 'The tool decides for each call.',
}

/** The approval select of a tool: Default clears the override. */
export type ToolApproval = 'default' | ToolOverride

export const TOOL_APPROVAL_OPTIONS: ReadonlyArray<{ value: ToolApproval, label: string }> = [
  { value: 'default', label: 'Default' },
  { value: 'allow', label: 'Allow' },
  { value: 'ask', label: 'Ask' },
  { value: 'deny', label: 'Deny' },
]

export function isToolApproval(value: unknown): value is ToolApproval {
  return typeof value === 'string' && TOOL_APPROVAL_OPTIONS.some(option => option.value === value)
}

export function mcpStatusDot(status: McpStatus): StatusDotStatus {
  switch (status) {
    case 'connected':
      return 'ok'
    case 'connecting':
      return 'running'
    case 'error':
      return 'error'
    case 'disabled':
      return 'off'
  }
}

/** "Connected · 12 tools", "Connecting…", "Error: {message}", "Disabled". */
export function mcpStatusText(server: Pick<McpServer, 'status' | 'tools' | 'error'>): string {
  switch (server.status) {
    case 'connected':
      return `Connected · ${server.tools.length === 1 ? '1 tool' : `${server.tools.length} tools`}`
    case 'connecting':
      return 'Connecting…'
    case 'error':
      return `Error: ${server.error?.message ?? 'the server did not answer'}`
    case 'disabled':
      return 'Disabled'
  }
}

export const MCP_TRANSPORT_LABELS: Record<McpServer['transport']['type'], string> = {
  stdio: 'stdio',
  http: 'HTTP',
  sse: 'SSE',
}

// ---------- logs ----------

export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error']

/** The level filter of the Logs tab: every entry, or entries at this level and above. */
export type LogLevelFilter = 'all' | 'info' | 'warn' | 'error'

export const LOG_LEVEL_FILTERS: ReadonlyArray<{ value: LogLevelFilter, label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'info', label: 'Info' },
  { value: 'warn', label: 'Warn' },
  { value: 'error', label: 'Error' },
]

export function isLogLevelFilter(value: unknown): value is LogLevelFilter {
  return typeof value === 'string' && LOG_LEVEL_FILTERS.some(option => option.value === value)
}

/** True when `entry` passes the filter ("Warn" shows warnings and errors). */
export function logMatchesLevel(entry: Pick<PluginLogEntry, 'level'>, filter: LogLevelFilter): boolean {
  if (filter === 'all')
    return true
  return LOG_LEVELS.indexOf(entry.level) >= LOG_LEVELS.indexOf(filter)
}

/** Local time with seconds ("14:03:27"). */
export function formatLogTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

function dataText(data: unknown): string {
  if (data === undefined)
    return ''
  try {
    return ` ${JSON.stringify(data)}`
  }
  catch {
    return ''
  }
}

/** Plain-text lines for "Copy": ISO time, level, message and the structured data. */
export function logsAsText(entries: readonly PluginLogEntry[]): string {
  return entries
    .map(entry => `${new Date(entry.at).toISOString()} ${entry.level.toUpperCase().padEnd(5)} ${entry.message}${dataText(entry.data)}`)
    .join('\n')
}
