// Output styles of plugins (Phase 11, plugin API 1.5.0, ADR-051; PLUGINS.md 6 "Declarative output styles" and 9):
// `Registry.styles`. Owner: W11.7 (C36 landed the empty registry).
//
// C36 stub (P11-0b): nothing is registered; `register` throws `not_implemented`; `get` / `owner` answer undefined,
// `list` answers `[]`; `onChange` subscribes to the registry's `style` changes (none are announced yet). W11.7 implements
// the registration through the manifest (`contributes.outputStyles`) and `ctx.outputStyles.register`, validated like
// `declarativeOutputStyleSchema` (the builtin names `default`, `explanatory` and `learning` reserved; a name another
// plugin registered throws `conflict`). The customization catalog lists them as `source: 'plugin'` style entries (W11.6).
import type { OutputStyleDefinition } from '@harness-forge/plugin-sdk'
import type { DefinitionRegistryCore } from './definitions.ts'
import type { RegisteredStyle, StyleRegistry } from './types.ts'
import { notImplementedError } from '../not-implemented.ts'
import { kindListener } from './definitions.ts'

/** `StyleRegistry` plus the host-only `removeOwner`. */
export interface PluginStyleRegistry extends StyleRegistry {
  /** Removes every style of `pluginId` that is still present (with a `removed` change each); returns the number removed. */
  readonly removeOwner: (pluginId: string) => number
}

export function createStyleRegistry(core: DefinitionRegistryCore): PluginStyleRegistry {
  const entries = new Map<string, RegisteredStyle>()
  return {
    register: (_pluginId: string, _definition: OutputStyleDefinition) => {
      throw notImplementedError('Registering a plugin output style')
    },
    get: name => entries.get(name),
    list: () => [...entries.values()].sort((a, b) => a.definition.name < b.definition.name ? -1 : a.definition.name > b.definition.name ? 1 : 0),
    owner: name => entries.get(name)?.pluginId,
    onChange: listener => core.onChange(kindListener('style', listener)),
    removeOwner: (pluginId) => {
      let removed = 0
      for (const [name, entry] of [...entries]) {
        if (entry.pluginId !== pluginId)
          continue
        entries.delete(name)
        removed += 1
        core.notify({ kind: 'style', action: 'removed', pluginId, key: name })
      }
      return removed
    },
  }
}
