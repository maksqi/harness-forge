// The shared implementation of the definition registries of plugin API 1.4.0 (ADR-045, PLUGINS.md 9 "Agents and
// skills"): `Registry.agents` (./agents.ts) and `Registry.skills` (./skills.ts). Owner: W10.7. Plugin API 1.5.0
// (ADR-051, W11.7): `Registry.styles` (./styles.ts), with a per-plugin cap (`LIMITS.pluginOutputStylesMax`).
//
// A registration is validated first (`validation_error` naming the field), then keyed by its name: a name that any plugin
// (the same one included) already registered throws `conflict` (`reason: 'exists'`), so the first registration wins.
// Every registration is tagged with its owner plugin id and returns a `Disposable` that removes exactly that entry
// (idempotent); the plugin's `DisposableStore` disposes it on disable / reload / uninstall, and `removeOwner` is the
// host's safety net. Adds and removals are announced through the registry's change listeners with the registry's kind
// (`agent` / `skill` / `style`), so `Registry.onChange` sees them and `agents.onChange` / `skills.onChange` /
// `styles.onChange` see only their own. A registry with `perPluginMax` refuses (`validation_error`) a registration that
// would give one plugin more entries than that. Definitions are stored as the frozen copies the validators return;
// lists are sorted by name. Plugin API 1.6.0 (ADR-053; W12.1): the validators get the owner, so a qualified name
// `<pluginId>:<name>` is accepted only from that plugin.
import type { Disposable } from '@harness-forge/plugin-sdk'
import type { RegistryChange } from './types.ts'
import { toDisposable } from './disposable.ts'
import { duplicate, invalid } from './validate.ts'

/** What a definition registry needs from the registry core. */
export interface DefinitionRegistryCore {
  /** The registry's change listeners (`Registry.onChange`). */
  readonly onChange: (listener: (change: RegistryChange) => void) => Disposable
  /** Announces a change to the registry's listeners (each listener is guarded by the core). */
  readonly notify: (change: RegistryChange) => void
}

/** `listener` for the changes of one kind only. */
export function kindListener(kind: RegistryChange['kind'], listener: (change: RegistryChange) => void): (change: RegistryChange) => void {
  return (change) => {
    if (change.kind === kind)
      listener(change)
  }
}

/** A registered definition: its owner and the validated definition. */
export interface RegisteredDefinition<D extends { name: string }> {
  readonly pluginId: string
  readonly definition: D
}

/** `AgentRegistry` / `SkillRegistry` plus the host-only `removeOwner`. */
export interface DefinitionRegistry<D extends { name: string }> {
  readonly register: (pluginId: string, definition: D) => Disposable
  readonly get: (name: string) => RegisteredDefinition<D> | undefined
  /** Sorted by name. */
  readonly list: () => RegisteredDefinition<D>[]
  readonly owner: (name: string) => string | undefined
  /** Changes of this kind only; listeners run synchronously. */
  readonly onChange: (listener: (change: RegistryChange) => void) => Disposable
  /** Removes every entry of `pluginId` that is still present (with a `removed` change each); returns the number removed. */
  readonly removeOwner: (pluginId: string) => number
}

export interface DefinitionRegistrySpec<D extends { name: string }> {
  readonly kind: Extract<RegistryChange['kind'], 'agent' | 'skill' | 'style'>
  /** Shown in conflict messages ("The agent "x" is already registered ..."). */
  readonly label: string
  /**
   * Throws `validation_error`; returns the (frozen) definition to store. Plugin API 1.6.0: `pluginId` is the owner a
   * qualified name must start with.
   */
  readonly validate: (definition: D, pluginId: string) => D
  /** At most this many entries per plugin (`validation_error` on `['name']` beyond it); default unlimited. */
  readonly perPluginMax?: number
}

export function createDefinitionRegistry<D extends { name: string }>(core: DefinitionRegistryCore, spec: DefinitionRegistrySpec<D>): DefinitionRegistry<D> {
  const entries = new Map<string, RegisteredDefinition<D>>()
  const countOwned = (pluginId: string): number => {
    let count = 0
    for (const entry of entries.values()) {
      if (entry.pluginId === pluginId)
        count += 1
    }
    return count
  }

  return {
    register: (pluginId, definition) => {
      const validated = spec.validate(definition, pluginId)
      const name = validated.name
      const existing = entries.get(name)
      if (existing)
        throw duplicate(`The ${spec.label} "${name}" is already registered by the plugin "${existing.pluginId}".`)
      if (spec.perPluginMax !== undefined && countOwned(pluginId) >= spec.perPluginMax)
        throw invalid(`The plugin "${pluginId}" cannot register more than ${spec.perPluginMax} ${spec.label}s.`, ['name'])
      const entry: RegisteredDefinition<D> = Object.freeze({ pluginId, definition: validated })
      entries.set(name, entry)
      core.notify({ kind: spec.kind, action: 'added', pluginId, key: name })
      return toDisposable(() => {
        if (entries.get(name) !== entry)
          return
        entries.delete(name)
        core.notify({ kind: spec.kind, action: 'removed', pluginId, key: name })
      })
    },
    get: name => entries.get(name),
    list: () => [...entries.values()].sort((a, b) => a.definition.name < b.definition.name ? -1 : a.definition.name > b.definition.name ? 1 : 0),
    owner: name => entries.get(name)?.pluginId,
    onChange: listener => core.onChange(kindListener(spec.kind, listener)),
    removeOwner: (pluginId) => {
      let removed = 0
      for (const [name, entry] of [...entries]) {
        if (entry.pluginId !== pluginId)
          continue
        entries.delete(name)
        removed += 1
        core.notify({ kind: spec.kind, action: 'removed', pluginId, key: name })
      }
      return removed
    },
  }
}
