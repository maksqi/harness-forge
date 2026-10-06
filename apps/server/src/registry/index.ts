// Contribution registry (ARCHITECTURE.md 3 `registry/`, PLUGINS.md 9 / 11 / 14). Owner: W1.3 (W1.3-T5).
//
// Every registration is tagged with its owner plugin id and returns a `Disposable` that removes it (idempotent). Lists
// use registry order (builtins first in load order, then user plugins by id, then registration order); tools, commands,
// agents and skills are sorted by name. Duplicate provider ids, tool names, command names, MCP server ids, agent names
// and skill names throw `conflict`; invalid shapes throw `validation_error`. Change listeners run synchronously; a
// throwing listener is logged.
// Phase 10 (plugin API 1.4.0, ADR-045; C30, W10.7): the agent and skill registries (`./agents.ts`, `./skills.ts`, on
// `./definitions.ts`) share the change listeners (kinds `agent`, `skill`), feed the contributions `agents` / `skills`
// (sorted by name) and are part of `removeOwner`.
// Phase 11 (plugin API 1.5.0, ADR-048 / ADR-051; C36, W11.7): the output style and command hook registries
// (`./styles.ts`, `./hook-commands.ts`; empty until W11.7) share the change listeners (kinds `style`, `hookCommands`),
// feed the contributions `outputStyles` (sorted by name) / `commandHooks` (the handler count) and are part of
// `removeOwner`.
import type {
  CommandDefinition,
  Disposable,
  HookHandler,
  HookMap,
  HookName,
  McpServerDecl,
  ModelInfo,
  ProviderDefinition,
  ToolDefinition,
} from '@harness-forge/plugin-sdk'
import type { LogLevel, PluginContributions } from '@harness-forge/shared'
import type { Logger } from '../logger.ts'
import type { GuardOptions } from '../plugins/types.ts'
import type { AppDeps } from '../types.ts'
import type { HookEntry } from './hooks.ts'
import type { Ordered } from './order.ts'
import type {
  RegisteredCommand,
  RegisteredHook,
  RegisteredMcpServer,
  RegisteredModels,
  RegisteredProvider,
  RegisteredTool,
  Registry,
  RegistryChange,
  RegistryKind,
  ToolRegisterOptions,
} from './types.ts'
import { isGuardTimeout } from '../plugins/guard.ts'
import { createAgentRegistry } from './agents.ts'
import { toDisposable } from './disposable.ts'
import { createHookCommandRegistry } from './hook-commands.ts'
import { runHookEntries } from './hooks.ts'
import { comparePluginIds, compareRegistrations } from './order.ts'
import { createSkillRegistry } from './skills.ts'
import { createStyleRegistry } from './styles.ts'
import {
  duplicate,
  HOOK_NAMES,
  validateCommandDefinition,
  validateHook,
  validateMcpServerDecl,
  validateModels,
  validateProviderDefinition,
  validateToolDefinition,
} from './validate.ts'

/** Services the registry needs at call time (hook guard, plugin log and state). */
export interface RegistryServices {
  readonly logger: Logger
  readonly guard: <T>(pluginId: string, fn: (signal: AbortSignal) => T | Promise<T>, options: GuardOptions) => Promise<T>
  readonly log: (pluginId: string, level: LogLevel, message: string, data?: unknown) => void
  /** False when the plugin is known and not active (its hook handlers are skipped). */
  readonly isRunnable: (pluginId: string) => boolean
}

/** The registry plus host-only helpers (not part of the frozen `Registry` interface). */
export interface PluginRegistry extends Registry {
  /**
   * Removes every registration of `pluginId` that is still present (a safety net after the plugin's own
   * `DisposableStore` ran); returns the number removed.
   */
  readonly removeOwner: (pluginId: string) => number
}

interface Entry<T> extends Ordered {
  readonly value: T
}

/** A registry whose runtime services are provided lazily (tests pass fakes). */
export function createRegistryCore(services: () => RegistryServices): PluginRegistry {
  let seq = 0
  const listeners = new Set<(change: RegistryChange) => void>()

  const providers = new Map<string, Entry<RegisteredProvider>>()
  const models = new Set<Entry<RegisteredModels>>()
  const tools = new Map<string, Entry<RegisteredTool>>()
  const commands = new Map<string, Entry<RegisteredCommand>>()
  const hooks = new Map<HookName, Set<HookEntry>>()
  const mcpServers = new Map<string, Entry<RegisteredMcpServer>>()

  function notify(kind: RegistryKind, action: RegistryChange['action'], pluginId: string, key: string): void {
    notifyChange({ kind, action, pluginId, key })
  }

  function notifyChange(change: RegistryChange): void {
    for (const listener of [...listeners]) {
      try {
        listener(change)
      }
      catch (error) {
        services().logger.error('registry change listener failed', { err: error, change })
      }
    }
  }

  function onChange(listener: (change: RegistryChange) => void): Disposable {
    listeners.add(listener)
    return toDisposable(() => {
      listeners.delete(listener)
    })
  }

  // Phase 10 (plugin API 1.4.0, ADR-045): agent types and skills of plugins.
  const agents = createAgentRegistry({ onChange, notify: notifyChange })
  const skills = createSkillRegistry({ onChange, notify: notifyChange })
  // Phase 11 (plugin API 1.5.0, ADR-048 / ADR-051): output styles and command hooks of plugins.
  const styles = createStyleRegistry({ onChange, notify: notifyChange })
  const hookCommands = createHookCommandRegistry({ onChange, notify: notifyChange })

  function sorted<T>(entries: Iterable<Entry<T>>): T[] {
    return [...entries].sort(compareRegistrations).map(entry => entry.value)
  }

  function byName<T>(entries: Iterable<Entry<T>>, nameOf: (value: T) => string): T[] {
    return [...entries].map(entry => entry.value).sort((a, b) => {
      const nameA = nameOf(a)
      const nameB = nameOf(b)
      return nameA < nameB ? -1 : nameA > nameB ? 1 : 0
    })
  }

  /** Adds `entry` to `map` under `key` and returns the disposable that removes exactly this entry. */
  function keyed<T>(map: Map<string, Entry<T>>, kind: RegistryKind, key: string, entry: Entry<T>): Disposable {
    map.set(key, entry)
    notify(kind, 'added', entry.pluginId, key)
    return toDisposable(() => {
      if (map.get(key) === entry) {
        map.delete(key)
        notify(kind, 'removed', entry.pluginId, key)
      }
    })
  }

  const registry: PluginRegistry = {
    providers: {
      register: (pluginId, definition: ProviderDefinition) => {
        validateProviderDefinition(pluginId, definition)
        const existing = providers.get(definition.id)
        if (existing)
          throw duplicate(`The provider "${definition.id}" is already registered by the plugin "${existing.pluginId}".`)
        return keyed(providers, 'provider', definition.id, { pluginId, seq: ++seq, value: Object.freeze({ pluginId, definition }) })
      },
      get: id => providers.get(id)?.value,
      list: () => sorted(providers.values()),
    },

    models: {
      register: (pluginId, providerId, list: readonly ModelInfo[]) => {
        validateModels(providerId, list)
        const value: RegisteredModels = Object.freeze({
          pluginId,
          providerId,
          models: Object.freeze(list.map(model => structuredClone(model))),
        })
        const entry: Entry<RegisteredModels> = { pluginId, seq: ++seq, value }
        models.add(entry)
        notify('models', 'added', pluginId, providerId)
        return toDisposable(() => {
          if (models.delete(entry))
            notify('models', 'removed', pluginId, providerId)
        })
      },
      // Registrations for a provider that is not registered yet are held (kept, not listed).
      list: providerId => providers.has(providerId)
        ? sorted([...models].filter(entry => entry.value.providerId === providerId))
        : [],
    },

    tools: {
      register: (pluginId, definition: ToolDefinition, options: ToolRegisterOptions = {}) => {
        validateToolDefinition(definition, options)
        const existing = tools.get(definition.name)
        if (existing)
          throw duplicate(`The tool "${definition.name}" is already registered by the plugin "${existing.pluginId}".`)
        const value: RegisteredTool = Object.freeze({
          pluginId,
          definition,
          mcpServerId: options.mcpServerId ?? null,
          title: options.title ?? null,
        })
        return keyed(tools, 'tool', definition.name, { pluginId, seq: ++seq, value })
      },
      get: name => tools.get(name)?.value,
      list: () => byName(tools.values(), tool => tool.definition.name),
    },

    commands: {
      register: (pluginId, definition: CommandDefinition) => {
        validateCommandDefinition(definition)
        const existing = commands.get(definition.name)
        if (existing)
          throw duplicate(`The command "/${definition.name}" is already registered by the plugin "${existing.pluginId}".`)
        return keyed(commands, 'command', definition.name, { pluginId, seq: ++seq, value: Object.freeze({ pluginId, definition }) })
      },
      get: name => commands.get(name)?.value,
      list: () => byName(commands.values(), command => command.definition.name),
    },

    hooks: {
      on: <K extends HookName>(pluginId: string, name: K, handler: HookHandler<K>, options: { priority?: number } = {}) => {
        validateHook(name, handler, options.priority)
        const entry: HookEntry = {
          pluginId,
          name,
          handler: handler as HookHandler<HookName>,
          priority: options.priority ?? 0,
          seq: ++seq,
          failures: 0,
          disabled: false,
          removed: false,
        }
        let set = hooks.get(name)
        if (!set) {
          set = new Set()
          hooks.set(name, set)
        }
        set.add(entry)
        notify('hook', 'added', pluginId, name)
        return toDisposable(() => {
          entry.removed = true
          if (hooks.get(name)?.delete(entry))
            notify('hook', 'removed', pluginId, name)
        })
      },
      list: <K extends HookName>(name: K) => callOrder(name).map(entry => Object.freeze({
        pluginId: entry.pluginId,
        name,
        handler: entry.handler as HookHandler<K>,
        priority: entry.priority,
      }) satisfies RegisteredHook<K>),
      run: async <K extends HookName>(name: K, ...args: HookMap[K]) => {
        const runtime = services()
        await runHookEntries(
          { guard: runtime.guard, log: runtime.log, isRunnable: runtime.isRunnable, isTimeout: isGuardTimeout },
          name,
          callOrder(name),
          args,
        )
      },
    },

    mcpServers: {
      register: (pluginId, decl: McpServerDecl) => {
        const parsed = validateMcpServerDecl(pluginId, decl)
        const existing = mcpServers.get(parsed.id)
        if (existing)
          throw duplicate(`The MCP server "${parsed.id}" is already declared by the plugin "${existing.pluginId}".`)
        return keyed(mcpServers, 'mcpServer', parsed.id, { pluginId, seq: ++seq, value: Object.freeze({ pluginId, decl: parsed }) })
      },
      get: id => mcpServers.get(id)?.value,
      list: () => sorted(mcpServers.values()),
    },

    agents,
    skills,
    styles,
    hookCommands,

    onChange,

    contributions: (pluginId) => {
      const owned = <T>(entries: Iterable<Entry<T>>): Entry<T>[] => [...entries].filter(entry => entry.pluginId === pluginId)
      const providerIds = owned(providers.values()).sort(compareRegistrations).map(entry => entry.value.definition.id)
      const modelCount = owned(models).reduce((sum, entry) => sum + entry.value.models.length, 0)
      const toolNames = owned(tools.values()).map(entry => entry.value.definition.name).sort()
      const serverIds = owned(mcpServers.values()).sort(compareRegistrations).map(entry => entry.value.decl.id)
      const commandNames = owned(commands.values()).map(entry => entry.value.definition.name).sort()
      const hookNames = HOOK_NAMES.filter(name => [...(hooks.get(name) ?? [])].some(entry => entry.pluginId === pluginId))
      const contributions: PluginContributions = {
        providers: providerIds,
        models: modelCount,
        tools: toolNames,
        mcpServers: serverIds,
        commands: commandNames,
        hooks: hookNames,
        // Plugin API 1.4.0 (ADR-045): sorted by name (the registries list by name).
        agents: agents.list().filter(agent => agent.pluginId === pluginId).map(agent => agent.definition.name),
        skills: skills.list().filter(skill => skill.pluginId === pluginId).map(skill => skill.definition.name),
        // Plugin API 1.5.0 (ADR-048, ADR-051): the registered command hook handlers and the style names (sorted by name).
        commandHooks: hookCommands.get(pluginId)?.hooks.length ?? 0,
        outputStyles: styles.list().filter(style => style.pluginId === pluginId).map(style => style.definition.name),
      }
      return contributions
    },

    removeOwner: (pluginId) => {
      let removed = 0
      const dropKeyed = <T>(map: Map<string, Entry<T>>, kind: RegistryKind): void => {
        for (const [key, entry] of [...map]) {
          if (entry.pluginId === pluginId) {
            map.delete(key)
            removed += 1
            notify(kind, 'removed', pluginId, key)
          }
        }
      }
      dropKeyed(providers, 'provider')
      dropKeyed(tools, 'tool')
      dropKeyed(commands, 'command')
      dropKeyed(mcpServers, 'mcpServer')
      removed += agents.removeOwner(pluginId) + skills.removeOwner(pluginId)
      removed += styles.removeOwner(pluginId) + hookCommands.removeOwner(pluginId)
      for (const entry of [...models]) {
        if (entry.pluginId === pluginId) {
          models.delete(entry)
          removed += 1
          notify('models', 'removed', pluginId, entry.value.providerId)
        }
      }
      for (const [name, set] of hooks) {
        for (const entry of [...set]) {
          if (entry.pluginId === pluginId) {
            entry.removed = true
            set.delete(entry)
            removed += 1
            notify('hook', 'removed', pluginId, name)
          }
        }
      }
      return removed
    },
  }

  /** Handlers of `name`: priority desc, then plugin load order, then registration order. */
  function callOrder(name: HookName): HookEntry[] {
    return [...(hooks.get(name) ?? [])].sort((a, b) => b.priority - a.priority || comparePluginIds(a.pluginId, b.pluginId) || a.seq - b.seq)
  }

  return registry
}

/** The app registry (`deps.registry`): hook guards, plugin logs and plugin states come from `deps.plugins`. */
export function createRegistry(deps: AppDeps): PluginRegistry {
  return createRegistryCore(() => ({
    logger: deps.logger,
    guard: (pluginId, fn, options) => deps.plugins.guard(pluginId, fn, options),
    log: (pluginId, level, message, data) => deps.plugins.log(pluginId, level, message, data),
    // Handlers of plugins unknown to the host run (direct registrations); a known plugin must be active and not stopping.
    isRunnable: pluginId => deps.plugins.state(pluginId) === null || deps.plugins.isActive(pluginId),
  }))
}
