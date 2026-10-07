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
//
// Phase 12 (plugin API 1.6.0, ADR-053 / ADR-058; W12.1-T8): the registrations carry the 1.6.0 fields and the catalog
// keeps them: commands their `argumentHint`, `model` and `allowedTools` (no longer null; a Claude model name becomes
// `modelAlias`), skills `argumentHint` / `userInvocable` / `modelInvocable` / `allowedTools` / `model` (their `baseDir`
// stays on the registration: `pluginSkillFolder`), both the ADR-058 keys `disallowedTools`, `arguments`, `whenToUse`,
// `context` and `agent`, agents `disallowedTools`, `maxTurns`, `color`, `skills` and a Claude model name as
// `modelAlias`. Entry names are the registered names: qualified `<pluginId>:<name>` for Claude Code plugins.
import type { CustomizationEntry, CustomizationKind, DefinitionDiagnostic, ParsedDefinition } from '@harness-forge/shared'
import type { Registry } from '../../registry/types.ts'
import { AGENT_COLORS, BUILTIN_PLUGIN_IDS, claudeModelAlias, DEFINITION_LIMITS, isBuiltinOutputStyle } from '@harness-forge/shared'
import { entryFromParse } from './entries.ts'

const BUILTIN_PLUGINS: ReadonlySet<string> = new Set(BUILTIN_PLUGIN_IDS)

/** True when a plugin's entries are listed: always, except in safe mode for a plugin that is not builtin. */
export function pluginListed(pluginId: string, safeMode: boolean): boolean {
  return !safeMode || BUILTIN_PLUGINS.has(pluginId)
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max)
}

/** A model of a registration: a model ref or `inherit` stays `model`, a Claude model name becomes `modelAlias`. */
function modelOf(value: unknown, allowInherit: boolean): { model: string | null, modelAlias?: string } {
  if (typeof value !== 'string' || value === '')
    return { model: null }
  if (value === 'inherit')
    return allowInherit ? { model: value } : { model: null }
  if (value.includes(':'))
    return { model: value }
  const alias = claudeModelAlias(value)
  return alias === null ? { model: null } : { model: null, modelAlias: alias }
}

/** A list of strings of a registration, else null. */
function stringList(value: unknown): string[] | null {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : null
}

/** The ADR-058 fields of a command or skill registration (`disallowedTools`, `arguments`, `whenToUse`, `context`, `agent`). */
function definitionExtras(record: Record<string, unknown>): { disallowedTools?: string[], arguments?: string[], whenToUse?: string, context?: 'fork', agent?: string } {
  const disallowedTools = stringList(record.disallowedTools)
  const names = stringList(record.arguments)
  return {
    ...(disallowedTools === null ? {} : { disallowedTools }),
    ...(names === null ? {} : { arguments: names }),
    ...(typeof record.whenToUse === 'string' && record.whenToUse !== '' ? { whenToUse: record.whenToUse } : {}),
    ...(record.context === 'fork' ? { context: 'fork' as const } : {}),
    ...(typeof record.agent === 'string' && record.agent !== '' ? { agent: record.agent } : {}),
  }
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
      const tools = stringList(record.tools)
      const { model, modelAlias } = modelOf(record.model, true)
      const disallowedTools = stringList(record.disallowedTools)
      const skills = stringList(record.skills)
      const color = AGENT_COLORS.find(entry => entry === record.color)
      return {
        kind,
        fields: {
          name,
          description,
          tools,
          model,
          instructions: text('instructions'),
          ...(disallowedTools === null ? {} : { disallowedTools }),
          ...(typeof record.maxTurns === 'number' ? { maxTurns: record.maxTurns } : {}),
          ...(color === undefined ? {} : { color }),
          ...(skills === null ? {} : { skills }),
          ...(modelAlias === undefined ? {} : { modelAlias }),
        },
      }
    }
    case 'skill': {
      const { model, modelAlias } = modelOf(record.model, false)
      const allowedTools = stringList(record.allowedTools)
      return {
        kind,
        fields: {
          name,
          description,
          content: text('content'),
          ...(record.userInvocable === false ? { userInvocable: false } : {}),
          ...(record.modelInvocable === false ? { modelInvocable: false } : {}),
          ...(typeof record.argumentHint === 'string' && record.argumentHint !== '' ? { argumentHint: record.argumentHint } : {}),
          ...(allowedTools === null ? {} : { allowedTools }),
          ...(model === null ? {} : { model }),
          ...(modelAlias === undefined ? {} : { modelAlias }),
          ...definitionExtras(record),
        },
      }
    }
    case 'command': {
      const { model, modelAlias } = modelOf(record.model, false)
      return {
        kind,
        fields: {
          name,
          description,
          argumentHint: typeof record.argumentHint === 'string' && record.argumentHint !== '' ? record.argumentHint : null,
          model,
          allowedTools: stringList(record.allowedTools),
          body: text('template'),
          ...(modelAlias === undefined ? {} : { modelAlias }),
          ...definitionExtras(record),
        },
      }
    }
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

/**
 * The folder of a plugin skill's supporting files (plugin API 1.6.0, ADR-053; for the `skill` tool's `file` input and
 * `${CLAUDE_SKILL_DIR}`, W12.7): the owner and the plugin-relative `baseDir` of the registered skill `name`; null when
 * the skill is not registered, has no `baseDir`, is not listed (safe mode) or belongs to another plugin than `pluginId`.
 * The caller resolves the plugin folder (`PluginHost.directory`) and reads through `plugins/claude/skill-files.ts`.
 */
export function pluginSkillFolder(registry: Registry, name: string, pluginId: string | undefined, safeMode: boolean): { pluginId: string, baseDir: string } | null {
  const registration = registry.skills.get(name)
  if (registration === undefined || (pluginId !== undefined && registration.pluginId !== pluginId) || !pluginListed(registration.pluginId, safeMode))
    return null
  const baseDir = registration.definition.baseDir
  return typeof baseDir === 'string' && baseDir !== '' ? { pluginId: registration.pluginId, baseDir } : null
}
