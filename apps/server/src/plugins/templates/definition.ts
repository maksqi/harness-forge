// Shape of a code plugin template (W3.4-T1): manifest additions, the entry source per language and a README section.
import type { PluginPermission, SettingsSchema } from '@harness-forge/plugin-sdk'
import type { PluginTemplateId } from '@harness-forge/shared'
import type { TemplateNames } from './names.ts'
import type { TemplateLanguage } from './source.ts'

/** Input of a template: the new plugin and the contribution names picked for it. */
export interface TemplateContext {
  /** Plugin id (also the directory name). */
  id: string
  /** Display name (trimmed, 1-64 characters, no control characters). */
  name: string
  language: TemplateLanguage
  names: TemplateNames
}

export interface TemplateDefinition {
  id: PluginTemplateId
  /** Card title of the web form. */
  label: string
  /** One sentence; also the manifest `description`. */
  description: string
  /** Advisory permissions declared in `plugin.json`. */
  permissions: PluginPermission[]
  /** Settings form of the plugin (Configuration tab). */
  settings?: SettingsSchema
  /** Source of the entry file (`index.mjs` or `index.ts`). */
  entry: (context: TemplateContext) => string
  /** README paragraph lines explaining how to try the plugin. */
  readme: (context: TemplateContext) => string[]
}
