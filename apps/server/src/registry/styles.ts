// Output styles of plugins (Phase 11, plugin API 1.5.0, ADR-051; PLUGINS.md 6 "Declarative output styles" and 9):
// `Registry.styles`. Owner: W11.7 (C36 landed the empty registry).
//
// Registered through the manifest (`contributes.outputStyles`, `registerDeclaredContributions`) and
// `ctx.outputStyles.register`; validated by `validateOutputStyleDefinition` (the name pattern, the reserved builtin names
// `default`, `explanatory` and `learning`, the description, `content` <= 64 KiB, `keepCodingInstructions`), at most
// `LIMITS.pluginOutputStylesMax` (20) per plugin. A name another plugin registered throws `conflict` (first wins; the
// declarative adapter logs the skipped one in the plugin's log). Every registration is owned by its plugin and removed
// on disable / reload / uninstall (the plugin's `DisposableStore`, `removeOwner` as the safety net). The customization
// catalog lists them as `source: 'plugin'` style entries (W11.6) and drops its caches on their `style` changes.
// Style bodies are never logged.
import type { OutputStyleDefinition } from '@harness-forge/plugin-sdk'
import type { DefinitionRegistry, DefinitionRegistryCore } from './definitions.ts'
import type { StyleRegistry } from './types.ts'
import { LIMITS } from '@harness-forge/shared'
import { createDefinitionRegistry } from './definitions.ts'
import { validateOutputStyleDefinition } from './validate.ts'

/** `StyleRegistry` plus the host-only `removeOwner`. */
export type PluginStyleRegistry = StyleRegistry & Pick<DefinitionRegistry<OutputStyleDefinition>, 'removeOwner'>

export function createStyleRegistry(core: DefinitionRegistryCore): PluginStyleRegistry {
  return createDefinitionRegistry<OutputStyleDefinition>(core, {
    kind: 'style',
    label: 'output style',
    validate: validateOutputStyleDefinition,
    perPluginMax: LIMITS.pluginOutputStylesMax,
  })
}
