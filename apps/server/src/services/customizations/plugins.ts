// Plugin entries of the catalog (Phase 10, plugin API 1.4.0, ADR-044 / ADR-045). Owner: W10.1.
//
// The plugin source of the catalog is live: the agents and skills of `registry.agents` / `registry.skills` (manifest
// `contributes.agents` / `contributes.skills`, `ctx.agents.register` / `ctx.skills.register`; W10.7 validates them) and
// the commands of `registry.commands` (so a project or personal command that wins a plugin command's name shows it as
// shadowed). Only active plugins have registrations (a disabled plugin is disposed); in `HF_SAFE_MODE` only the builtin
// plugins load, and the catalog lists no other plugin's entries either. Bodies come from the registry: `load` and
// `source` turn a registration into a `ParsedDefinition` (`formatDefinition` writes the markdown of `source`).
import type { CustomizationEntry, CustomizationKind, ParsedDefinition } from '@harness-forge/shared'
import type { Registry } from '../../registry/types.ts'
import { BUILTIN_PLUGIN_IDS, DEFINITION_LIMITS } from '@harness-forge/shared'
import { entryFromParse } from './entries.ts'

const BUILTIN_PLUGINS: ReadonlySet<string> = new Set(BUILTIN_PLUGIN_IDS)

/** True when a plugin's entries are listed: always, except in safe mode for a plugin that is not builtin. */
export function pluginListed(pluginId: string, safeMode: boolean): boolean {
  return !safeMode || BUILTIN_PLUGINS.has(pluginId)
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max)
}

/** A registration as the definition the catalog lists and `load` returns (null for an unknown kind). */
function definitionOf(kind: CustomizationKind, registration: unknown): ParsedDefinition | null {
  const record = registration as Record<string, unknown>
  const text = (key: string): string => (typeof record[key] === 'string' ? record[key] : '')
  const name = text('name')
  const description = cut(text('description'), DEFINITION_LIMITS.descriptionMaxChars)
  switch (kind) {
    case 'agent': {
      const tools = Array.isArray(record.tools) ? record.tools.filter((tool): tool is string => typeof tool === 'string') : null
      const model = typeof record.model === 'string' ? record.model : null
      return { kind, fields: { name, description, tools, model, instructions: text('instructions') } }
    }
    case 'skill':
      return { kind, fields: { name, description, content: text('content') } }
    case 'command':
      return { kind, fields: { name, description, argumentHint: null, model: null, allowedTools: null, body: text('template') } }
  }
}

/** The plugin entries of the catalog: agents, skills and commands of the registry (`active`; precedence later). */
export function pluginCatalogEntries(registry: Registry, safeMode: boolean): CustomizationEntry[] {
  const entries: CustomizationEntry[] = []
  const add = (kind: CustomizationKind, pluginId: string, registration: unknown): void => {
    if (!pluginListed(pluginId, safeMode))
      return
    const definition = definitionOf(kind, registration)
    if (definition === null || definition.fields.name === '')
      return
    entries.push(entryFromParse(kind, 'plugin', { definition, diagnostics: [] }, { pluginId, fallbackName: definition.fields.name }))
  }
  for (const { pluginId, definition } of registry.agents.list())
    add('agent', pluginId, definition)
  for (const { pluginId, definition } of registry.skills.list())
    add('skill', pluginId, definition)
  for (const { pluginId, definition } of registry.commands.list())
    add('command', pluginId, definition)
  return entries
}

/**
 * The definition of a plugin entry from the live registry (`load`, `source`): null when the name is no longer
 * registered, now belongs to another plugin, or the plugin is not listed (safe mode).
 */
export function pluginDefinition(registry: Registry, kind: CustomizationKind, name: string, pluginId: string | undefined, safeMode: boolean): { pluginId: string, definition: ParsedDefinition } | null {
  const registration = kind === 'agent' ? registry.agents.get(name) : kind === 'skill' ? registry.skills.get(name) : registry.commands.get(name)
  if (registration === undefined || (pluginId !== undefined && registration.pluginId !== pluginId) || !pluginListed(registration.pluginId, safeMode))
    return null
  const definition = definitionOf(kind, registration.definition)
  return definition === null ? null : { pluginId: registration.pluginId, definition }
}
