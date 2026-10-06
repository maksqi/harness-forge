// Plugin entries of the catalog (Phase 10, plugin API 1.4.0, ADR-044 / ADR-045). Owner: W10.1; Phase 11: W11.6.
//
// The plugin source of the catalog is live: the agents and skills of `registry.agents` / `registry.skills` (manifest
// `contributes.agents` / `contributes.skills`, `ctx.agents.register` / `ctx.skills.register`; W10.7 validates them),
// the commands of `registry.commands` (so a project or personal command that wins a plugin command's name shows it as
// shadowed) and, Phase 11 (plugin API 1.5.0, ADR-051), the output styles of `registry.styles` (manifest
// `contributes.outputStyles`, `ctx.outputStyles.register`; W11.7 validates them; a plugin style's label is its name).
// Only active plugins have registrations (a disabled plugin is disposed); in `HF_SAFE_MODE` only the builtin plugins
// load, and the catalog lists no other plugin's entries either. Bodies come from the registry: `load` and `source` turn
// a registration into a `ParsedDefinition` (`formatDefinition` writes the markdown of `source`). A plugin style with a
// builtin style name (refused by the registry already) is listed `invalid` (`reserved-name`), never as a winner.
import type { CustomizationEntry, CustomizationKind, DefinitionDiagnostic, ParsedDefinition } from '@harness-forge/shared'
import type { Registry } from '../../registry/types.ts'
import { BUILTIN_PLUGIN_IDS, DEFINITION_LIMITS, isBuiltinOutputStyle } from '@harness-forge/shared'
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
  if (typeof registration !== 'object' || registration === null)
    return null
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
    case 'style':
      // Plugin output styles (plugin API 1.5.0): no label of their own (the name is shown).
      return { kind, fields: { name, label: name, description, keepCodingInstructions: record.keepCodingInstructions === true, content: text('content') } }
  }
}

/** The `reserved-name` error of a plugin style named like a builtin style. */
function reservedStyle(name: string): DefinitionDiagnostic {
  return { level: 'error', code: 'reserved-name', message: `${name} is a built-in name.`, kind: 'style', name }
}

/**
 * The plugin entries of the catalog: agents, skills, commands and (Phase 11) output styles of the registry (`active`;
 * the precedence is applied later).
 */
export function pluginCatalogEntries(registry: Registry, safeMode: boolean): CustomizationEntry[] {
  const entries: CustomizationEntry[] = []
  const add = (kind: CustomizationKind, pluginId: string, registration: unknown): void => {
    if (!pluginListed(pluginId, safeMode))
      return
    const definition = definitionOf(kind, registration)
    if (definition === null || definition.fields.name === '')
      return
    const name = definition.fields.name
    const result = kind === 'style' && isBuiltinOutputStyle(name)
      ? { definition: null, diagnostics: [reservedStyle(name)] }
      : { definition, diagnostics: [] }
    entries.push(entryFromParse(kind, 'plugin', result, { pluginId, fallbackName: name }))
  }
  for (const { pluginId, definition } of registry.agents.list())
    add('agent', pluginId, definition)
  for (const { pluginId, definition } of registry.skills.list())
    add('skill', pluginId, definition)
  for (const { pluginId, definition } of registry.commands.list())
    add('command', pluginId, definition)
  for (const { pluginId, definition } of registry.styles.list())
    add('style', pluginId, definition)
  return entries
}

/** The registration of `name` in the registry of `kind`. */
function registrationOf(registry: Registry, kind: CustomizationKind, name: string): { pluginId: string, definition: unknown } | undefined {
  switch (kind) {
    case 'agent':
      return registry.agents.get(name)
    case 'skill':
      return registry.skills.get(name)
    case 'command':
      return registry.commands.get(name)
    case 'style':
      return registry.styles.get(name)
  }
}

/**
 * The definition of a plugin entry from the live registry (`load`, `source`): null when the name is no longer
 * registered, now belongs to another plugin, the plugin is not listed (safe mode), or (a style) it is a builtin name.
 */
export function pluginDefinition(registry: Registry, kind: CustomizationKind, name: string, pluginId: string | undefined, safeMode: boolean): { pluginId: string, definition: ParsedDefinition } | null {
  if (kind === 'style' && isBuiltinOutputStyle(name))
    return null
  const registration = registrationOf(registry, kind, name)
  if (registration === undefined || (pluginId !== undefined && registration.pluginId !== pluginId) || !pluginListed(registration.pluginId, safeMode))
    return null
  const definition = definitionOf(kind, registration.definition)
  return definition === null ? null : { pluginId: registration.pluginId, definition }
}
