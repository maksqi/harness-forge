// Code plugin templates (W3.4-T1, docs/PLUGINS.md 8 and 15, UI.md 8.6): Tool, Provider, MCP bridge and Command pack.
// Each renders `plugin.json`, a single-file entry that uses only `ctx` (no runtime imports: JavaScript with JSDoc types
// in `index.mjs`, or TypeScript in `index.ts` compiled by the host), the vendored API types `harness-forge.d.ts` for
// editors, and a README. `renderPluginTemplate()` is pure; the scaffold service writes the files and loads the plugin.
import type { PluginManifest } from '@harness-forge/plugin-sdk'
import type { PluginTemplateId } from '@harness-forge/shared'
import type { TemplateContext, TemplateDefinition } from './definition.ts'
import type { NameRegistry } from './names.ts'
import type { TemplateLanguage } from './source.ts'
import { PLUGIN_API_VERSION } from '@harness-forge/plugin-sdk'
import { commandPackTemplate } from './command-pack.ts'
import { mcpBridgeTemplate } from './mcp-bridge.ts'
import { pickTemplateNames } from './names.ts'
import { providerTemplate } from './provider.ts'
import { SDK_TYPES_SOURCE } from './sdk-types.ts'
import { entryFileName, SDK_TYPES_FILE } from './source.ts'
import { toolTemplate } from './tool.ts'

export type { TemplateContext, TemplateDefinition } from './definition.ts'
export { EMPTY_NAME_REGISTRY, pickTemplateNames } from './names.ts'
export type { NameRegistry, TemplateNames } from './names.ts'
export { entryFileName, SDK_TYPES_FILE } from './source.ts'
export type { TemplateLanguage } from './source.ts'

/** Every template, in the order of the web form. */
export const PLUGIN_TEMPLATES: Readonly<Record<PluginTemplateId, TemplateDefinition>> = {
  'tool': toolTemplate,
  'provider': providerTemplate,
  'mcp-bridge': mcpBridgeTemplate,
  'command-pack': commandPackTemplate,
}

/** Version of a scaffolded plugin. */
export const TEMPLATE_PLUGIN_VERSION = '0.1.0'
/** `engines.harness` of a scaffolded plugin: the running API major. */
export const TEMPLATE_ENGINES_RANGE = `^${PLUGIN_API_VERSION.split('.')[0]}.0.0`

export interface RenderTemplateInput {
  template: PluginTemplateId
  id: string
  /** Trimmed display name. */
  name: string
  language?: TemplateLanguage
  /** Contribution names that are already registered (default: none). */
  registry?: NameRegistry
}

export interface RenderedTemplate {
  manifest: PluginManifest
  /** Entry file name (`manifest.main`). */
  entry: string
  /** Relative POSIX path -> UTF-8 content, `plugin.json` included. */
  files: Record<string, string>
}

function readme(definition: TemplateDefinition, context: TemplateContext, entry: string): string {
  const language = context.language === 'ts' ? 'TypeScript, compiled by the host' : 'a JavaScript module with JSDoc types'
  const lines = [
    `# ${context.name}`,
    '',
    `${definition.description} Created from the **${definition.label}** template of harness-forge.`,
    '',
    '## Try it',
    '',
    ...definition.readme(context),
    '',
    '## Files',
    '',
    '- `plugin.json`: the manifest (id, name, version, permissions and the entry file in `main`).',
    `- \`${entry}\`: the plugin code (${language}).`,
    `- \`${SDK_TYPES_FILE}\`: plugin API types for your editor. The host ignores this file.`,
    '- `README.md`: this file.',
    '',
    '## Develop',
    '',
    `1. Edit \`${entry}\` in the Source tab of the plugin and save with Mod+S.`,
    '2. Press **Build & reload**: the host checks the code and reloads the plugin. Problems show up in the editor and',
    '   in the build panel, and `ctx.logger` entries in the Logs tab.',
    '3. A code plugin is a single file: import only Node built-ins (for example `node:crypto`). zod and the AI SDK',
    '   come from `ctx.ai`; no packages are installed.',
    '4. Everything registered through `ctx` is removed when the plugin is disabled or reloaded.',
    '',
    'The full plugin API is described in docs/PLUGINS.md.',
  ]
  return `${lines.join('\n')}\n`
}

/** Renders the files of a new plugin. Throws `validation_error` / `conflict` when the names cannot be picked. */
export function renderPluginTemplate(input: RenderTemplateInput): RenderedTemplate {
  const definition = PLUGIN_TEMPLATES[input.template]
  const language = input.language ?? 'js'
  const names = pickTemplateNames(input.id, input.template, input.registry)
  const context: TemplateContext = { id: input.id, name: input.name, language, names }
  const entry = entryFileName(language)
  const manifest: PluginManifest = {
    manifestVersion: 1,
    id: input.id,
    name: input.name,
    version: TEMPLATE_PLUGIN_VERSION,
    description: definition.description,
    engines: { harness: TEMPLATE_ENGINES_RANGE },
    main: entry,
    permissions: [...definition.permissions],
    ...(definition.settings ? { settings: structuredClone(definition.settings) } : {}),
  }
  return {
    manifest,
    entry,
    files: {
      'plugin.json': `${JSON.stringify(manifest, null, 2)}\n`,
      [entry]: definition.entry(context),
      [SDK_TYPES_FILE]: SDK_TYPES_SOURCE,
      'README.md': readme(definition, context, entry),
    },
  }
}
