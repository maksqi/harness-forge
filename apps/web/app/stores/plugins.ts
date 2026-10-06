// Plugins store (docs/UI.md 5.4, 8, 11; docs/API.md 5.12-5.15): plugin list and details, lifecycle actions, plugin
// settings and logs, tools and their preferences, MCP servers and server commands. One-shot calls (inspect /
// install, drafts, scaffold, files, build, export) stay in components through useApi(). Signatures are frozen
// after Phase 0.
import type {
  CommandSummary,
  McpServer,
  McpServerInput,
  McpServerUpdate,
  PluginDetail,
  PluginLogEntry,
  PluginSettingsView,
  PluginSummary,
  ServerEvent,
  ToolSummary,
  ToolUpdate,
} from '@harness-forge/shared'
import { HarnessError } from '@harness-forge/shared'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useApi } from '~/composables/useApi'
import { createCoalescedTask } from '~/utils/coalesce'
import { withHarnessErrors } from '~/utils/errors'
import { omitKey } from '~/utils/records'

/** The `/plugins?filter=` values (docs/DECISIONS.md "UI query parameters"; Phase 10: `agents` = "Agents and skills"). */
export const PLUGIN_FILTERS = ['all', 'providers', 'tools', 'mcp', 'commands', 'agents', 'disabled'] as const
export type PluginFilter = (typeof PLUGIN_FILTERS)[number]

export type PluginCounts = Record<PluginFilter, number>

/** An update of an existing MCP server for `saveMcp()`. */
export interface McpServerPatch {
  id: string
  patch: McpServerUpdate
}

/** Log entries kept per plugin (docs/UI.md 8.11). */
export const PLUGIN_LOG_LIMIT = 500

export function isPluginFilter(value: unknown): value is PluginFilter {
  return typeof value === 'string' && (PLUGIN_FILTERS as readonly string[]).includes(value)
}

/** The filter of a `?filter=` query value; anything unknown (or missing) is `all`. */
export function parsePluginFilter(value: unknown): PluginFilter {
  const raw = Array.isArray(value) ? value[0] : value
  return isPluginFilter(raw) ? raw : 'all'
}

/**
 * True when the plugin belongs to the filter: contributes that type (`agents`: agents or skills, plugin API 1.4.0), or is
 * disabled for `disabled`.
 */
export function pluginMatchesFilter(plugin: PluginSummary, filter: PluginFilter): boolean {
  switch (filter) {
    case 'providers':
      return plugin.contributions.providers.length > 0
    case 'tools':
      return plugin.contributions.tools.length > 0
    case 'mcp':
      return plugin.contributions.mcpServers.length > 0
    case 'commands':
      return plugin.contributions.commands.length > 0
    case 'agents':
      return plugin.contributions.agents.length > 0 || plugin.contributions.skills.length > 0
    case 'disabled':
      return !plugin.enabled
    default:
      return true
  }
}

function summaryOf(detail: PluginDetail): PluginSummary {
  return {
    id: detail.id,
    name: detail.name,
    version: detail.version,
    description: detail.description,
    icon: detail.icon,
    kind: detail.kind,
    format: detail.format,
    source: detail.source,
    sourceRef: detail.sourceRef,
    builtin: detail.builtin,
    removable: detail.removable,
    enabled: detail.enabled,
    state: detail.state,
    runsCode: detail.runsCode,
    contributions: detail.contributions,
    lastError: detail.lastError,
    installedAt: detail.installedAt,
    updatedAt: detail.updatedAt,
  }
}

/** `current` plus the entries of `added` newer than its last sequence number, keeping the newest `PLUGIN_LOG_LIMIT`. */
function appendLogs(current: readonly PluginLogEntry[], added: readonly PluginLogEntry[]): PluginLogEntry[] {
  const lastSeq = current.at(-1)?.seq ?? -1
  const fresh = added.filter(entry => entry.seq > lastSeq)
  return fresh.length === 0 ? [...current] : [...current, ...fresh].slice(-PLUGIN_LOG_LIMIT)
}

export const usePluginsStore = defineStore('plugins', () => {
  const api = useApi()

  // ---------- state ----------

  /** Installed plugins: builtins first, then by id. */
  const items = ref<PluginSummary[]>([])
  /** Details of the plugins opened so far (detail page, trust dialog). */
  const details = ref<Record<string, PluginDetail>>({})
  /** Logs of the plugins whose logs were fetched, oldest first (live `plugin.log` events append). */
  const logs = ref<Record<string, PluginLogEntry[]>>({})
  const tools = ref<ToolSummary[]>([])
  const mcp = ref<McpServer[]>([])
  /** Server-side slash commands (client-only commands are not listed). */
  const commands = ref<CommandSummary[]>([])
  /** The plugin list arrived. */
  const loaded = ref(false)
  const toolsLoaded = ref(false)
  const mcpLoaded = ref(false)
  const commandsLoaded = ref(false)

  // ---------- getters ----------

  const index = computed(() => new Map(items.value.map(plugin => [plugin.id, plugin])))
  /** `byId(id)`: the plugin summary, or undefined. */
  const byId = computed(() => (id: string): PluginSummary | undefined => index.value.get(id))
  /** Count badges of the Browse filters. */
  const counts = computed<PluginCounts>(() => {
    const result: PluginCounts = { all: 0, providers: 0, tools: 0, mcp: 0, commands: 0, agents: 0, disabled: 0 }
    for (const plugin of items.value) {
      for (const filter of PLUGIN_FILTERS) {
        if (pluginMatchesFilter(plugin, filter))
          result[filter] += 1
      }
    }
    return result
  })
  /** `filtered(filter, q)`: plugins of a filter whose name, id or description contains `q` (case-insensitive). */
  const filtered = computed(() => (filter: PluginFilter = 'all', q = ''): PluginSummary[] => {
    const needle = q.trim().toLowerCase()
    return items.value.filter(plugin => pluginMatchesFilter(plugin, filter)
      && (needle === '' || [plugin.name, plugin.id, plugin.description ?? ''].some(text => text.toLowerCase().includes(needle))))
  })
  /** At least one enabled and available tool (the permission menu shows only then). */
  const hasTools = computed(() => tools.value.some(tool => tool.enabled && tool.available))

  // ---------- helpers ----------

  let changeSeq = 0
  let pendingList: Promise<PluginSummary[]> | null = null
  let pendingTools: Promise<ToolSummary[]> | null = null
  let pendingMcp: Promise<McpServer[]> | null = null
  let pendingCommands: Promise<CommandSummary[]> | null = null

  function upsertSummary(plugin: PluginSummary, insert = true) {
    changeSeq += 1
    if (index.value.has(plugin.id))
      items.value = items.value.map(item => (item.id === plugin.id ? plugin : item))
    else if (insert)
      items.value = [...items.value, plugin]
  }

  function setDetail(detail: PluginDetail): PluginDetail {
    details.value = { ...details.value, [detail.id]: detail }
    upsertSummary(summaryOf(detail), loaded.value)
    return detail
  }

  function forgetPlugin(id: string) {
    changeSeq += 1
    items.value = items.value.filter(item => item.id !== id)
    if (id in details.value)
      details.value = omitKey(details.value, id)
    if (id in logs.value)
      logs.value = omitKey(logs.value, id)
  }

  function patchEnabled(id: string, enabled: boolean) {
    changeSeq += 1
    items.value = items.value.map(item => (item.id === id ? { ...item, enabled } : item))
    const detail = details.value[id]
    if (detail)
      details.value = { ...details.value, [id]: { ...detail, enabled } }
  }

  function replaceTool(tool: ToolSummary) {
    tools.value = tools.value.some(item => item.name === tool.name)
      ? tools.value.map(item => (item.name === tool.name ? tool : item))
      : [...tools.value, tool].sort((a, b) => a.name.localeCompare(b.name))
  }

  function replaceMcp(server: McpServer) {
    mcp.value = mcp.value.some(item => item.id === server.id)
      ? mcp.value.map(item => (item.id === server.id ? server : item))
      : [...mcp.value, server]
  }

  async function afterPending(pending: Promise<unknown> | null) {
    await pending?.catch(() => {})
  }

  const refetchList = createCoalescedTask(async () => {
    await afterPending(pendingList)
    return fetchAll()
  })
  const refetchTools = createCoalescedTask(async () => {
    await afterPending(pendingTools)
    return fetchTools()
  })
  const refetchMcp = createCoalescedTask(async () => {
    await afterPending(pendingMcp)
    return fetchMcp()
  })
  const refetchCommands = createCoalescedTask(async () => {
    await afterPending(pendingCommands)
    return fetchCommands()
  })
  const detailRefetches = new Map<string, ReturnType<typeof createCoalescedTask>>()
  function refetchDetail(id: string) {
    let task = detailRefetches.get(id)
    if (!task) {
      task = createCoalescedTask(() => fetchOne(id))
      detailRefetches.set(id, task)
    }
    task.schedule()
  }

  // ---------- actions: plugins ----------

  /** `GET /plugins`. Concurrent calls share one request. Throws `HarnessError`. */
  function fetchAll(): Promise<PluginSummary[]> {
    if (pendingList)
      return pendingList
    const startedAt = changeSeq
    const request = withHarnessErrors(api.plugins.list())
      .then(({ items: next }) => {
        items.value = next
        loaded.value = true
        if (changeSeq !== startedAt)
          refetchList.schedule()
        return next
      })
      .finally(() => {
        pendingList = null
      })
    pendingList = request
    return request
  }

  /** `GET /plugins/:id` into `details[id]` (and its row). */
  async function fetchOne(id: string): Promise<PluginDetail> {
    return setDetail(await withHarnessErrors(api.plugins.get({ params: { id } })))
  }

  /** `POST /plugins/:id/enable`: optimistic switch; a load failure comes back as the plugin `state`. */
  async function enable(id: string): Promise<PluginDetail> {
    const previous = index.value.get(id)?.enabled
    patchEnabled(id, true)
    try {
      return setDetail(await withHarnessErrors(api.plugins.enable({ params: { id } })))
    }
    catch (error) {
      if (previous !== undefined)
        patchEnabled(id, previous)
      throw error
    }
  }

  /** `POST /plugins/:id/disable`: optimistic switch. */
  async function disable(id: string): Promise<PluginDetail> {
    const previous = index.value.get(id)?.enabled
    patchEnabled(id, false)
    try {
      return setDetail(await withHarnessErrors(api.plugins.disable({ params: { id } })))
    }
    catch (error) {
      if (previous !== undefined)
        patchEnabled(id, previous)
      throw error
    }
  }

  /** `POST /plugins/:id/reload` (fresh auth for code plugins: 403 `forbidden` + action `login`). */
  async function reload(id: string): Promise<PluginDetail> {
    return setDetail(await withHarnessErrors(api.plugins.reload({ params: { id } })))
  }

  /** `DELETE /plugins/:id?keepData=` (builtins answer 403). */
  async function uninstall(id: string, { keepData = false }: { keepData?: boolean } = {}): Promise<void> {
    await withHarnessErrors(api.plugins.remove({ params: { id }, query: { keepData } }))
    forgetPlugin(id)
  }

  /**
   * `POST /plugins/:id/trust` pinning `sha256` (default: the current `trust.hash` of the plugin detail, fetched when
   * missing). A fresh-auth route: 403 `forbidden` + action `login` when the session is not fresh.
   */
  async function trust(id: string, sha256?: string): Promise<PluginDetail> {
    const hash = sha256 ?? (details.value[id] ?? await fetchOne(id)).trust.hash
    if (!hash)
      throw new HarnessError({ code: 'validation_error', message: 'This plugin has nothing to trust.' })
    return setDetail(await withHarnessErrors(api.pluginInstall.trust({ params: { id }, body: { sha256: hash } })))
  }

  /** `GET /plugins/:id/settings` (`schema: null` without settings). */
  function fetchSettings(id: string): Promise<PluginSettingsView> {
    return withHarnessErrors(api.plugins.getSettings({ params: { id } }))
  }

  /** `PUT /plugins/:id/settings`: secret properties take a string (`''` clears); omitted keys are unchanged. */
  function saveSettings(id: string, values: Record<string, unknown>): Promise<PluginSettingsView> {
    return withHarnessErrors(api.plugins.updateSettings({ params: { id }, body: { values } }))
  }

  /** `GET /plugins/:id/logs` into `logs[id]`; afterwards `plugin.log` events append live entries. */
  async function fetchLogs(id: string): Promise<PluginLogEntry[]> {
    // From now on live `plugin.log` events of this plugin are recorded, also while the request is in flight.
    if (!logs.value[id])
      logs.value = { ...logs.value, [id]: [] }
    const before = new Set(logs.value[id])
    const { items: entries } = await withHarnessErrors(api.plugins.logs({ params: { id }, query: { limit: PLUGIN_LOG_LIMIT } }))
    // Live entries that arrived while the request was in flight are kept.
    const arrived = (logs.value[id] ?? []).filter(entry => !before.has(entry))
    const merged = appendLogs(entries.slice(-PLUGIN_LOG_LIMIT), arrived)
    logs.value = { ...logs.value, [id]: merged }
    return merged
  }

  // ---------- actions: tools, MCP, commands ----------

  /** `GET /tools`. */
  function fetchTools(): Promise<ToolSummary[]> {
    pendingTools ??= withHarnessErrors(api.tools.list())
      .then(({ items: next }) => {
        tools.value = next
        toolsLoaded.value = true
        return next
      })
      .finally(() => {
        pendingTools = null
      })
    return pendingTools
  }

  /** `PATCH /tools/:name` (`enabled`, `override`; `override: null` clears it). Optimistic. */
  async function setToolPref(name: string, patch: ToolUpdate): Promise<ToolSummary> {
    const previous = tools.value.find(tool => tool.name === name)
    if (previous)
      replaceTool({ ...previous, ...patch })
    try {
      const tool = await withHarnessErrors(api.tools.update({ params: { name }, body: patch }))
      replaceTool(tool)
      return tool
    }
    catch (error) {
      if (previous)
        replaceTool(previous)
      throw error
    }
  }

  /** `GET /mcp`. */
  function fetchMcp(): Promise<McpServer[]> {
    pendingMcp ??= withHarnessErrors(api.mcp.list())
      .then(({ items: next }) => {
        mcp.value = next
        mcpLoaded.value = true
        return next
      })
      .finally(() => {
        pendingMcp = null
      })
    return pendingMcp
  }

  /**
   * Creates an MCP server (`POST /mcp` with a `McpServerInput`) or updates one (`PATCH /mcp/:id` with
   * `{ id, patch }`). Creating a stdio server, or switching one to stdio, is a fresh-auth request.
   */
  async function saveMcp(input: McpServerInput | McpServerPatch): Promise<McpServer> {
    const server = 'patch' in input
      ? await withHarnessErrors(api.mcp.update({ params: { id: input.id }, body: input.patch }))
      : await withHarnessErrors(api.mcp.create({ body: input }))
    replaceMcp(server)
    return server
  }

  /** `DELETE /mcp/:id` (user-configured servers only). */
  async function removeMcp(id: string): Promise<void> {
    await withHarnessErrors(api.mcp.remove({ params: { id } }))
    mcp.value = mcp.value.filter(server => server.id !== id)
  }

  /** `POST /mcp/:id/reconnect` (waits up to 10 s for the attempt). */
  async function reconnectMcp(id: string): Promise<McpServer> {
    const server = await withHarnessErrors(api.mcp.reconnect({ params: { id } }))
    replaceMcp(server)
    return server
  }

  /** `GET /commands` (server-side slash commands for the slash menu). */
  function fetchCommands(): Promise<CommandSummary[]> {
    pendingCommands ??= withHarnessErrors(api.commands.list())
      .then(({ items: next }) => {
        commands.value = next
        commandsLoaded.value = true
        return next
      })
      .finally(() => {
        pendingCommands = null
      })
    return pendingCommands
  }

  // ---------- events and reconnects ----------

  /**
   * `plugin.changed` patches or removes the row, refetches an opened detail, and refetches the loaded tool, MCP and
   * command lists (contributions and MCP connection states change with it). `plugin.log` appends to fetched logs.
   */
  function applyEvent(event: ServerEvent): void {
    if (event.type === 'plugin.changed') {
      const { id, plugin } = event.data
      if (plugin) {
        upsertSummary(plugin, loaded.value)
        const detail = details.value[id]
        if (detail) {
          details.value = { ...details.value, [id]: { ...detail, ...plugin } }
          refetchDetail(id)
        }
      }
      else {
        forgetPlugin(id)
      }
      if (toolsLoaded.value)
        refetchTools.schedule()
      if (mcpLoaded.value)
        refetchMcp.schedule()
      if (commandsLoaded.value)
        refetchCommands.schedule()
    }
    else if (event.type === 'plugin.log') {
      const { pluginId, entry } = event.data
      const current = logs.value[pluginId]
      if (current)
        logs.value = { ...logs.value, [pluginId]: appendLogs(current, [entry]) }
    }
  }

  /** Refetches everything already loaded (after the event stream reconnects: missed events are not replayed). */
  async function refreshLoaded(): Promise<void> {
    const tasks: Array<Promise<unknown>> = []
    if (loaded.value)
      tasks.push(fetchAll())
    for (const id of Object.keys(details.value))
      tasks.push(fetchOne(id))
    for (const id of Object.keys(logs.value))
      tasks.push(fetchLogs(id))
    if (toolsLoaded.value)
      tasks.push(fetchTools())
    if (mcpLoaded.value)
      tasks.push(fetchMcp())
    if (commandsLoaded.value)
      tasks.push(fetchCommands())
    await Promise.allSettled(tasks)
  }

  return {
    items,
    details,
    logs,
    tools,
    mcp,
    commands,
    loaded,
    toolsLoaded,
    mcpLoaded,
    commandsLoaded,
    byId,
    counts,
    filtered,
    hasTools,
    fetchAll,
    fetchOne,
    enable,
    disable,
    reload,
    uninstall,
    trust,
    fetchSettings,
    saveSettings,
    fetchLogs,
    fetchTools,
    setToolPref,
    fetchMcp,
    saveMcp,
    removeMcp,
    reconnectMcp,
    fetchCommands,
    applyEvent,
    refreshLoaded,
  }
})
