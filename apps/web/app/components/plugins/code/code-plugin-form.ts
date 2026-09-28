// Rules of the code plugin form (docs/UI.md 8.6, docs/API.md 4.13): the template cards, the id derived from the name,
// and the field checks the server applies (plugin id pattern, reserved and existing ids, 64-character names, MCP server
// ids of at most 32 characters).
import type { PluginTemplateId } from '@harness-forge/shared'
import { isReservedPluginId, MCP_SERVER_ID_PATTERN, PLUGIN_ID_PATTERN } from '@harness-forge/shared'

export interface CodeTemplateOption {
  id: PluginTemplateId
  label: string
  description: string
}

/** Template cards, in display order. */
export const CODE_TEMPLATES: readonly CodeTemplateOption[] = [
  { id: 'tool', label: 'Tool', description: 'Adds a tool the model can call' },
  { id: 'provider', label: 'Provider', description: 'Adds an LLM provider written in code' },
  { id: 'mcp-bridge', label: 'MCP bridge', description: 'Connects an MCP server' },
  { id: 'command-pack', label: 'Command pack', description: 'Adds slash commands' },
]

/** Longest plugin name (`PluginManifest.name`). */
export const PLUGIN_NAME_MAX = 64
/** Longest plugin id. */
export const PLUGIN_ID_MAX = 40

/** "My Weather Tools!" -> "my-weather-tools" (letters without accents, digits and "-", at most 40 characters). */
export function slugifyPluginId(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, PLUGIN_ID_MAX)
    .replace(/-+$/, '')
}

/** The problem with a name, or null. */
export function pluginNameProblem(name: string): string | null {
  const trimmed = name.trim()
  if (trimmed === '')
    return 'Enter a name.'
  if (trimmed.length > PLUGIN_NAME_MAX)
    return `Use at most ${PLUGIN_NAME_MAX} characters.`
  // eslint-disable-next-line no-control-regex -- control characters are what is rejected
  if (/[\u0000-\u001F\u007F]/.test(trimmed))
    return 'Names cannot contain line breaks or control characters.'
  return null
}

/** The problem with an id for `template`, or null. `exists` answers whether a plugin already uses the id. */
export function pluginIdProblem(id: string, template: PluginTemplateId | null, exists: (id: string) => boolean): string | null {
  if (id === '')
    return 'Enter an id.'
  if (!PLUGIN_ID_PATTERN.test(id))
    return 'Use 1-40 characters of a-z, 0-9 and "-", starting and ending with a letter or digit.'
  if (isReservedPluginId(id))
    return 'This id is reserved (core-*, mock and the builtin provider ids).'
  if (exists(id))
    return 'A plugin with this id already exists.'
  if (template === 'mcp-bridge' && !MCP_SERVER_ID_PATTERN.test(id))
    return 'An MCP bridge needs an id of at most 32 characters.'
  return null
}
