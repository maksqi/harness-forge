// Command hooks of plugins (Phase 11, plugin API 1.5.0, ADR-048; PLUGINS.md 6 "Declarative hooks" and 9 "Command hooks
// (1.5.0)"): `Registry.hookCommands`. Owner: W11.7 (C36 landed the empty registry).
//
// C36 stub (P11-0b): nothing is registered; `register` throws `not_implemented`; `get` answers undefined, `list`
// answers `[]`; `onChange` subscribes to the registry's `hookCommands` changes (none are announced yet). W11.7
// implements the registration from the manifest `contributes.hooks` (read with the shared `readHooksConfig`, `source:
// 'plugin'`; one registration per plugin, a second one throws `conflict`) with the plugin folder as the root. The hook
// service reads it for its snapshots (W11.1); the contributions count the handlers (`commandHooks`).
import type { Disposable } from '@harness-forge/plugin-sdk'
import type { DefinitionRegistryCore } from './definitions.ts'
import type { HookCommandRegistry, HookCommandsRegistration, RegisteredHookCommands } from './types.ts'
import { notImplementedError } from '../not-implemented.ts'
import { kindListener } from './definitions.ts'
import { comparePluginIds } from './order.ts'

/** `HookCommandRegistry` plus the host-only `removeOwner`. */
export interface PluginHookCommandRegistry extends HookCommandRegistry {
  /** Removes the registration of `pluginId` when it is still present (with a `removed` change); returns 1 or 0. */
  readonly removeOwner: (pluginId: string) => number
}

export function createHookCommandRegistry(core: DefinitionRegistryCore): PluginHookCommandRegistry {
  const entries = new Map<string, RegisteredHookCommands>()
  return {
    register: (_pluginId: string, _registration: HookCommandsRegistration): Disposable => {
      throw notImplementedError('Registering plugin command hooks')
    },
    get: pluginId => entries.get(pluginId),
    list: () => [...entries.values()].sort((a, b) => comparePluginIds(a.pluginId, b.pluginId)),
    onChange: listener => core.onChange(kindListener('hookCommands', listener)),
    removeOwner: (pluginId) => {
      if (!entries.delete(pluginId))
        return 0
      core.notify({ kind: 'hookCommands', action: 'removed', pluginId, key: pluginId })
      return 1
    },
  }
}
