// Plugin manifest (`plugin.json`, PLUGINS.md section 3).
import { z } from 'zod'
import { pluginPermissionSchema } from '../enums.ts'
import { isPluginNamespacedId, isReservedPluginId, pluginIdSchema, providerIdSchema } from '../ids.ts'
import { isSafeRelativePath } from '../util/paths.ts'
import { isSemver, isSemverRange } from '../util/semver.ts'
import { duplicates, isUnique } from '../util/text.ts'
import {
  declarativeAgentSchema,
  declarativeCommandSchema,
  declarativeProviderSchema,
  declarativeSkillSchema,
  httpUrlSchema,
  LOBE_ICON_PATTERN,
  mcpServerDeclSchema,
  mcpServerDeclSettingsKeys,
  modelInfoListSchema,
} from './plugin-data.ts'
import { settingsSchemaSchema } from './plugin-settings.ts'

/** Valid SemVer 2.0.0 version (`1.2.0`, `2.0.0-beta.1`). */
export const semverSchema = z.string().refine(isSemver, 'Expected a semver version such as "1.2.0".')

/** Valid semver range (`^1.0.0`, `>=1.2.0 <2`, `1.x || 2.x`). */
export const semverRangeSchema = z.string().refine(isSemverRange, 'Expected a semver range such as "^1.0.0".')

/** Manifest `icon`: `lobe:<slug>` or a relative path to a `.svg` / `.png` file inside the plugin directory. */
export const manifestIconSchema = z
  .string()
  .max(256)
  .refine(
    value => LOBE_ICON_PATTERN.test(value) || (isSafeRelativePath(value) && /\.(?:svg|png)$/i.test(value)),
    'Use "lobe:<slug>" or a relative path to a .svg or .png file inside the plugin.',
  )

/** Manifest `main`: relative POSIX path of the entry file (`.mjs`, `.js` or `.ts`). */
export const manifestEntrySchema = z
  .string()
  .max(256)
  .refine(
    value => isSafeRelativePath(value) && /\.(?:mjs|js|ts)$/.test(value),
    'Use a relative path (segments of A-Z, a-z, 0-9, ".", "_", "-") ending in .mjs, .js or .ts.',
  )

/** Models contributed to any provider, including builtins (held until that provider is registered). */
export const contributedModelsSchema = z.strictObject({
  providerId: providerIdSchema,
  models: modelInfoListSchema,
})
export type ContributedModels = z.infer<typeof contributedModelsSchema>

export const pluginContributesSchema = z.strictObject({
  providers: z.array(declarativeProviderSchema).max(32).optional(),
  models: z.array(contributedModelsSchema).max(64).optional(),
  mcpServers: z.array(mcpServerDeclSchema).max(32).optional(),
  commands: z.array(declarativeCommandSchema).max(100).optional(),
  /** Plugin API 1.4.0 (ADR-045): agent types for `task` (at most 50). */
  agents: z.array(declarativeAgentSchema).max(50).optional(),
  /** Plugin API 1.4.0 (ADR-045): skills for the `skill` tool (at most 50). */
  skills: z.array(declarativeSkillSchema).max(50).optional(),
})
export type PluginContributes = z.infer<typeof pluginContributesSchema>

const manifestObjectSchema = z.strictObject({
  /** Ignored (lets editors attach a JSON schema). */
  $schema: z.string().optional(),
  manifestVersion: z.literal(1),
  /** Equals the directory name. */
  id: pluginIdSchema,
  name: z.string().trim().min(1).max(64),
  version: semverSchema,
  description: z.string().max(280).optional(),
  author: z.string().max(100).optional(),
  homepage: httpUrlSchema.optional(),
  icon: manifestIconSchema.optional(),
  /** `harness`: semver range checked against `PLUGIN_API_VERSION`. */
  engines: z.strictObject({ harness: semverRangeSchema }),
  /** Presence makes the plugin a code plugin. */
  main: manifestEntrySchema.optional(),
  /** Advisory (shown in the trust dialog). */
  permissions: z.array(pluginPermissionSchema).refine(isUnique, 'Permissions must be unique.').optional(),
  settings: settingsSchemaSchema.optional(),
  contributes: pluginContributesSchema.optional(),
})

/**
 * Every manifest rule except the reserved-id check: provider and MCP server ids namespaced by the plugin id, unique
 * provider / MCP server / command / agent / skill names, `{{settings.<key>}}` references to defined settings. Used by DTOs, which also
 * carry builtin manifests, and by endpoints that answer a reserved id with 403 instead of 400.
 */
export const pluginManifestBaseSchema = manifestObjectSchema.superRefine((manifest, ctx) => {
  const contributes = manifest.contributes
  if (!contributes)
    return

  const providerIds = (contributes.providers ?? []).map(provider => provider.id)
  providerIds.forEach((id, index) => {
    if (!isPluginNamespacedId(manifest.id, id))
      ctx.addIssue({ code: 'custom', path: ['contributes', 'providers', index, 'id'], message: `Provider id "${id}" must be "${manifest.id}" or start with "${manifest.id}-".` })
  })
  for (const id of duplicates(providerIds))
    ctx.addIssue({ code: 'custom', path: ['contributes', 'providers', providerIds.lastIndexOf(id), 'id'], message: `Duplicate provider id "${id}".` })

  const settingsKeys = new Set(Object.keys(manifest.settings?.properties ?? {}))
  const servers = contributes.mcpServers ?? []
  const serverIds = servers.map(server => server.id)
  for (const [index, server] of servers.entries()) {
    if (!isPluginNamespacedId(manifest.id, server.id))
      ctx.addIssue({ code: 'custom', path: ['contributes', 'mcpServers', index, 'id'], message: `MCP server id "${server.id}" must be "${manifest.id}" or start with "${manifest.id}-".` })
    for (const key of mcpServerDeclSettingsKeys(server)) {
      if (!settingsKeys.has(key))
        ctx.addIssue({ code: 'custom', path: ['contributes', 'mcpServers', index, 'transport'], message: `"{{settings.${key}}}" refers to an undefined setting.` })
    }
  }
  for (const id of duplicates(serverIds))
    ctx.addIssue({ code: 'custom', path: ['contributes', 'mcpServers', serverIds.lastIndexOf(id), 'id'], message: `Duplicate MCP server id "${id}".` })

  const commandNames = (contributes.commands ?? []).map(command => command.name)
  for (const name of duplicates(commandNames))
    ctx.addIssue({ code: 'custom', path: ['contributes', 'commands', commandNames.lastIndexOf(name), 'name'], message: `Duplicate command "${name}".` })

  const agentNames = (contributes.agents ?? []).map(agent => agent.name)
  for (const name of duplicates(agentNames))
    ctx.addIssue({ code: 'custom', path: ['contributes', 'agents', agentNames.lastIndexOf(name), 'name'], message: `Duplicate agent "${name}".` })

  const skillNames = (contributes.skills ?? []).map(skill => skill.name)
  for (const name of duplicates(skillNames))
    ctx.addIssue({ code: 'custom', path: ['contributes', 'skills', skillNames.lastIndexOf(name), 'name'], message: `Duplicate skill "${name}".` })
})

/** A user plugin manifest: every rule of `pluginManifestBaseSchema` plus "the id is not reserved". */
export const pluginManifestSchema = pluginManifestBaseSchema.superRefine((manifest, ctx) => {
  if (isReservedPluginId(manifest.id))
    ctx.addIssue({ code: 'custom', path: ['id'], message: `The plugin id "${manifest.id}" is reserved (core-*, mock and builtin provider ids).` })
})
export type PluginManifest = z.infer<typeof pluginManifestSchema>

/** True when the manifest declares a code entry (`main`). */
export function isCodePluginManifest(manifest: Pick<PluginManifest, 'main'>): boolean {
  return manifest.main !== undefined
}

/** True when the manifest declares a stdio MCP server (the plugin then requires trust). */
export function declaresStdioMcpServer(manifest: Pick<PluginManifest, 'contributes'>): boolean {
  return (manifest.contributes?.mcpServers ?? []).some(server => server.transport.type === 'stdio')
}

/** Code plugins and plugins with a stdio MCP server require trust (sha256 pinning). */
export function manifestRequiresTrust(manifest: Pick<PluginManifest, 'main' | 'contributes'>): boolean {
  return isCodePluginManifest(manifest) || declaresStdioMcpServer(manifest)
}
