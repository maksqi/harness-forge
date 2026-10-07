// Command hooks of plugins (Phase 11, plugin API 1.5.0, ADR-048; PLUGINS.md 6 "Declarative hooks" and 9 "Command hooks
// (1.5.0)"): `Registry.hookCommands`. Owner: W11.7 (C36 landed the empty registry).
//
// One registration per plugin: the plugin host registers the manifest's `contributes.hooks` (through the plugin's
// runtime, so its `DisposableStore` removes it on disable / reload / uninstall) with the plugin folder as the root, and
// only while the plugin loads, i.e. while it is enabled and, since a manifest with command hooks requires trust,
// pinned (an `untrusted` plugin never registers anything). `validateHookCommands` checks the root and the handler count
// (at most `LIMITS.pluginHooksMax`) and reads the hooks with the shared `readHooksConfig(…, { source: 'plugin' })`: the
// valid handlers are listed in declaration order, the reader's diagnostics are kept for `GET /hooks`. A second
// registration of the same plugin throws `conflict`. Adds and removals are announced as `hookCommands` changes (key =
// the plugin id). The hook service reads the registrations for its snapshots and checks the owner's state there (W11.1);
// the contributions count the handlers (`commandHooks`). Commands are never logged.
//
// Phase 12 (plugin API 1.6.0, ADR-053 / ADR-057; W12.1): the hooks are read with prompts on (a `prompt` handler of a
// harness manifest or a Claude Code plugin is a `PromptHookSpec`, no trust needed), the registration's `prompts` are
// added after them (counted with the command handlers against `LIMITS.pluginHooksMax`), and its `env` (a Claude Code
// plugin's `CLAUDE_PLUGIN_DATA` and `CLAUDE_PLUGIN_OPTION_<KEY>`; never a variable the runner sets) is kept for the
// hook service, which also substitutes the exec-form `${user_config.KEY}` references from it at spawn (W12.16: the
// registered hooks never hold an option value). Prompts and environment values are never logged.
import type { DefinitionRegistryCore } from './definitions.ts'
import type { HookCommandRegistry, HookCommandsRegistration, RegisteredHookCommands } from './types.ts'
import { kindListener } from './definitions.ts'
import { toDisposable } from './disposable.ts'
import { comparePluginIds } from './order.ts'
import { duplicate, validateHookCommands } from './validate.ts'

/** `HookCommandRegistry` plus the host-only `removeOwner`. */
export interface PluginHookCommandRegistry extends HookCommandRegistry {
  /** Removes the registration of `pluginId` when it is still present (with a `removed` change); returns 1 or 0. */
  readonly removeOwner: (pluginId: string) => number
}

export function createHookCommandRegistry(core: DefinitionRegistryCore): PluginHookCommandRegistry {
  const entries = new Map<string, RegisteredHookCommands>()
  return {
    register: (pluginId: string, registration: HookCommandsRegistration) => {
      const validated = validateHookCommands(registration)
      if (entries.has(pluginId))
        throw duplicate(`The plugin "${pluginId}" already registered its command hooks.`)
      const entry: RegisteredHookCommands = Object.freeze({
        pluginId,
        root: validated.root,
        hooks: validated.hooks,
        diagnostics: validated.diagnostics,
        env: validated.env,
        prompts: validated.prompts,
      })
      entries.set(pluginId, entry)
      core.notify({ kind: 'hookCommands', action: 'added', pluginId, key: pluginId })
      return toDisposable(() => {
        if (entries.get(pluginId) !== entry)
          return
        entries.delete(pluginId)
        core.notify({ kind: 'hookCommands', action: 'removed', pluginId, key: pluginId })
      })
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
