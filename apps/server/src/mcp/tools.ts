// Tool list and preferences (W3.5-T3; API.md 5.12, PLUGINS.md 10). `GET /tools` lists the registry tools plus the
// tools of declared but disconnected MCP servers (`available: false`), sorted by name; `PATCH /tools/:name` upserts a
// `tool_prefs` row (`enabled`, `override`); `prefs()` feeds the chat pipeline (disabled tools are not sent, `override`
// is step 1 of the approval resolution). A pref equal to the defaults (`enabled: true`, no override) deletes its row.
// `workspace` (Phase 7, ADR-032) is the definition's workspace access (`read` / `write` / `execute`), null for MCP tools
// and tools without one.
import type { ToolDefinition } from '@harness-forge/plugin-sdk'
import type { ToolSummary, ToolUpdate } from '@harness-forge/shared'
import type { RegisteredTool } from '../registry/types.ts'
import type { AppDeps } from '../types.ts'
import type { ToolPref, ToolService } from './types.ts'
import { HarnessError } from '@harness-forge/shared'
import { asSchema } from 'ai'
import { eq } from 'drizzle-orm'
import { toolPrefs } from '../db/schema.ts'
import { mcpInternals } from './internal.ts'

const DEFAULT_PREF: ToolPref = Object.freeze({ enabled: true, override: null })

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function createToolService(deps: AppDeps): ToolService {
  /** JSON schemas per definition (zod conversion is not free; definitions are immutable once registered). */
  const schemaCache = new WeakMap<ToolDefinition, Record<string, unknown>>()

  async function inputSchemaOf(definition: ToolDefinition): Promise<Record<string, unknown>> {
    const cached = schemaCache.get(definition)
    if (cached)
      return cached
    let schema: Record<string, unknown> = {}
    try {
      const json: unknown = await asSchema(definition.inputSchema).jsonSchema
      if (isRecord(json))
        schema = JSON.parse(JSON.stringify(json)) as Record<string, unknown>
    }
    catch (error) {
      deps.logger.debug('tool input schema cannot be converted', { tool: definition.name, err: error })
    }
    schemaCache.set(definition, schema)
    return schema
  }

  function ownerActive(pluginId: string): boolean {
    return deps.plugins.state(pluginId) === null || deps.plugins.isActive(pluginId)
  }

  async function readPrefs(): Promise<Map<string, ToolPref>> {
    const rows = await deps.db.select().from(toolPrefs)
    return new Map(rows.map(row => [row.toolName, { enabled: row.enabled, override: row.override ?? null }]))
  }

  async function registeredSummary(tool: RegisteredTool, pref: ToolPref): Promise<ToolSummary> {
    const { definition } = tool
    const status = tool.mcpServerId === null ? null : mcpInternals(deps.mcp).serverStatus?.(tool.mcpServerId) ?? 'connected'
    return {
      name: definition.name,
      title: tool.title,
      description: definition.description,
      pluginId: tool.pluginId,
      mcpServerId: tool.mcpServerId,
      policy: typeof definition.policy === 'function' ? null : definition.policy ?? 'ask',
      enabled: pref.enabled,
      override: pref.override,
      available: ownerActive(tool.pluginId) && (status === null || status === 'connected'),
      // Plugin API 1.2.0 (ADR-032): the declared workspace access (validated at registration); MCP tools have none.
      workspace: tool.mcpServerId === null ? definition.workspace ?? null : null,
      inputSchema: await inputSchemaOf(definition),
    }
  }

  async function summaries(prefs: ReadonlyMap<string, ToolPref>): Promise<ToolSummary[]> {
    const items: ToolSummary[] = []
    const names = new Set<string>()
    for (const tool of deps.registry.tools.list()) {
      names.add(tool.definition.name)
      items.push(await registeredSummary(tool, prefs.get(tool.definition.name) ?? DEFAULT_PREF))
    }
    for (const tool of mcpInternals(deps.mcp).offlineTools?.() ?? []) {
      if (names.has(tool.name))
        continue
      names.add(tool.name)
      const pref = prefs.get(tool.name) ?? DEFAULT_PREF
      items.push({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        pluginId: tool.pluginId,
        mcpServerId: tool.mcpServerId,
        policy: tool.policy,
        enabled: pref.enabled,
        override: pref.override,
        available: false,
        workspace: null,
        inputSchema: tool.inputSchema,
      })
    }
    return items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  }

  async function announce(pluginId: string): Promise<void> {
    try {
      deps.events.emit('plugin.changed', { id: pluginId, plugin: await deps.plugins.summary(pluginId) })
    }
    catch {
      // Unknown to the host: nothing to announce.
    }
  }

  return {
    list: async () => summaries(await readPrefs()),

    update: async (name: string, patch: ToolUpdate) => {
      const prefs = await readPrefs()
      const current = (await summaries(prefs)).find(tool => tool.name === name)
      if (!current)
        throw new HarnessError({ code: 'not_found', message: `Unknown tool "${name}".` })
      const next: ToolPref = {
        enabled: patch.enabled ?? current.enabled,
        override: patch.override === undefined ? current.override : patch.override,
      }
      if (next.enabled && next.override === null) {
        await deps.db.delete(toolPrefs).where(eq(toolPrefs.toolName, name))
      }
      else {
        const updatedAt = Date.now()
        await deps.db
          .insert(toolPrefs)
          .values({ toolName: name, enabled: next.enabled, override: next.override, updatedAt })
          .onConflictDoUpdate({ target: toolPrefs.toolName, set: { enabled: next.enabled, override: next.override, updatedAt } })
      }
      // Other open tabs refetch their tool lists on `plugin.changed` of the owner.
      void announce(current.pluginId)
      return { ...current, enabled: next.enabled, override: next.override }
    },

    prefs: readPrefs,
  }
}
