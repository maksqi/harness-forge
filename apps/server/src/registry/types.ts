// Frozen interface of the contribution registry (ARCHITECTURE.md section 3 `registry/`, PLUGINS.md 9 / 11).
// Implementation: `createRegistry(deps)` in `registry/index.ts` (W1.3). Consumers: the plugin host / `ctx` (W1.3),
// credentials (W1.2), providers + catalog (W1.4), chat pipeline (W2.1), MCP manager and tools (W3.5).
//
// Every registration is tagged with its owner plugin id and returns a `Disposable`; disposing it (or the owner's
// `DisposableStore` on disable / reload / uninstall) removes it. Order everywhere is "registry order": builtins first in
// load order (`BUILTIN_PLUGIN_IDS`), then user plugins by id, then registration order within a plugin.
//
// Phase 10 (plugin API 1.4.0, ADR-045; C30): the kinds `agent` and `skill`, the registries `agents` and `skills` (agent
// types and skills contributed by plugins through the manifest `contributes.agents` / `contributes.skills` and
// `ctx.agents.register` / `ctx.skills.register`) and the contributions `agents` / `skills`. C30 lands them empty
// (`registry/{agents,skills}.ts`: nothing registered, `register` answers `not_implemented`); W10.7 implements the
// registration and its validation. The customization catalog reads them (`source: 'plugin'`, ADR-044).
import type {
  AgentDefinition,
  CommandDefinition,
  Disposable,
  HookHandler,
  HookMap,
  HookName,
  McpServerDecl,
  ModelInfo,
  ProviderDefinition,
  SkillDefinition,
  ToolDefinition,
} from '@harness-forge/plugin-sdk'
import type { PluginContributions } from '@harness-forge/shared'

export interface RegisteredProvider {
  readonly pluginId: string
  readonly definition: ProviderDefinition
}

/** Models contributed to a provider by one registration (manifest `contributes.models` or `ctx.models.register`). */
export interface RegisteredModels {
  readonly pluginId: string
  readonly providerId: string
  readonly models: readonly ModelInfo[]
}

export interface RegisteredTool {
  readonly pluginId: string
  readonly definition: ToolDefinition
  /** Set for MCP tools (registered by the MCP manager, sent to the model as AI SDK dynamic tools). */
  readonly mcpServerId: string | null
  /** Display title (MCP `annotations.title`), else null. */
  readonly title: string | null
}

export interface ToolRegisterOptions {
  /** MCP manager only: marks an `mcp__<serverId>__<tool>` tool (the `mcp__` prefix is reserved otherwise). */
  mcpServerId?: string
  title?: string
}

export interface RegisteredCommand {
  readonly pluginId: string
  readonly definition: CommandDefinition
}

export interface RegisteredHook<K extends HookName = HookName> {
  readonly pluginId: string
  readonly name: K
  readonly handler: HookHandler<K>
  /** Higher runs first (default 0). */
  readonly priority: number
}

/** An MCP server declaration (manifest `contributes.mcpServers`, `ctx.mcp.register`, `core-mcp` user servers). */
export interface RegisteredMcpServer {
  readonly pluginId: string
  readonly decl: McpServerDecl
}

/** An agent type contributed by a plugin (manifest `contributes.agents` or `ctx.agents.register`; plugin API 1.4.0). */
export interface RegisteredAgent {
  readonly pluginId: string
  readonly definition: AgentDefinition
}

/** A skill contributed by a plugin (manifest `contributes.skills` or `ctx.skills.register`; plugin API 1.4.0). */
export interface RegisteredSkill {
  readonly pluginId: string
  readonly definition: SkillDefinition
}

export type RegistryKind = 'provider' | 'models' | 'tool' | 'command' | 'hook' | 'mcpServer' | 'agent' | 'skill'

/**
 * A registration was added or removed. `key`: provider id, provider id (models), tool / command / hook name, MCP id,
 * agent or skill name (Phase 10).
 */
export interface RegistryChange {
  kind: RegistryKind
  action: 'added' | 'removed'
  pluginId: string
  key: string
}

export interface ProviderRegistry {
  /**
   * Validates the definition (plugin providers: id `<pluginId>` or `<pluginId>-<suffix>`) and adds it; a duplicate id
   * throws `conflict`.
   */
  readonly register: (pluginId: string, definition: ProviderDefinition) => Disposable
  readonly get: (id: string) => RegisteredProvider | undefined
  /** Registry order. */
  readonly list: () => RegisteredProvider[]
}

export interface ModelRegistry {
  /** Adds models to any provider; registrations for a provider that is not registered yet are held until it is. */
  readonly register: (pluginId: string, providerId: string, models: readonly ModelInfo[]) => Disposable
  /** Plugin-contributed models of a registered provider in registry order (held registrations are not returned). */
  readonly list: (providerId: string) => RegisteredModels[]
}

export interface ToolRegistry {
  /**
   * Validates name (`^[a-zA-Z0-9_-]{1,64}$`, `mcp__` reserved for the MCP manager), schema and policy; a duplicate name
   * throws `conflict`.
   */
  readonly register: (pluginId: string, definition: ToolDefinition, options?: ToolRegisterOptions) => Disposable
  readonly get: (name: string) => RegisteredTool | undefined
  /** Sorted by name. */
  readonly list: () => RegisteredTool[]
}

export interface CommandRegistry {
  /** Exactly one of `template` / `run`; client-only names are rejected; a duplicate name throws `conflict`. */
  readonly register: (pluginId: string, definition: CommandDefinition) => Disposable
  readonly get: (name: string) => RegisteredCommand | undefined
  /** Sorted by name. */
  readonly list: () => RegisteredCommand[]
}

export interface HookRegistry {
  readonly on: <K extends HookName>(pluginId: string, name: K, handler: HookHandler<K>, options?: { priority?: number }) => Disposable
  /** Handlers in call order: priority desc, then plugin load order, then registration order. */
  readonly list: <K extends HookName>(name: K) => RegisteredHook<K>[]
  /**
   * Runs every handler of `name` in order with a frozen `input` and the mutable `output` draft; each call is guarded
   * (3 s, `plugin_error` phase `hook`), failures are logged to the plugin log and counted (5 consecutive failures
   * disable that handler until the plugin reloads) and are not rethrown, except for `tool.before`, where a failure
   * blocks the tool call (rethrown as `plugin_error`).
   */
  readonly run: <K extends HookName>(name: K, ...args: HookMap[K]) => Promise<void>
}

export interface McpServerRegistry {
  /** Same rules as `contributes.mcpServers`; a duplicate id (across plugins and user servers) throws `conflict`. */
  readonly register: (pluginId: string, decl: McpServerDecl) => Disposable
  readonly get: (id: string) => RegisteredMcpServer | undefined
  readonly list: () => RegisteredMcpServer[]
}

/**
 * Agent types of plugins (Phase 10, plugin API 1.4.0, ADR-045). Names follow `AGENT_NAME_PATTERN`; the builtin names
 * (`explore`, `general`, `general-purpose`) are reserved. Sorted by name.
 */
export interface AgentRegistry {
  /**
   * Validates the definition (name pattern and reserved names, description, `instructions` ≤ 64 KiB, tool names, model
   * ref) and adds it; a name another plugin registered throws `conflict` (W10.7; the C30 stub throws `not_implemented`).
   */
  readonly register: (pluginId: string, definition: AgentDefinition) => Disposable
  readonly get: (name: string) => RegisteredAgent | undefined
  /** Sorted by name. */
  readonly list: () => RegisteredAgent[]
  /** The plugin that registered `name`, or undefined. */
  readonly owner: (name: string) => string | undefined
  /** Changes of agents only (`RegistryChange.kind === 'agent'`); listeners run synchronously. */
  readonly onChange: (listener: (change: RegistryChange) => void) => Disposable
}

/** Skills of plugins (Phase 10, plugin API 1.4.0, ADR-045). Names follow `AGENT_NAME_PATTERN`. Sorted by name. */
export interface SkillRegistry {
  /**
   * Validates the definition (name pattern, description, `content` ≤ 64 KiB) and adds it; a name another plugin
   * registered throws `conflict` (W10.7; the C30 stub throws `not_implemented`).
   */
  readonly register: (pluginId: string, definition: SkillDefinition) => Disposable
  readonly get: (name: string) => RegisteredSkill | undefined
  /** Sorted by name. */
  readonly list: () => RegisteredSkill[]
  /** The plugin that registered `name`, or undefined. */
  readonly owner: (name: string) => string | undefined
  /** Changes of skills only (`RegistryChange.kind === 'skill'`); listeners run synchronously. */
  readonly onChange: (listener: (change: RegistryChange) => void) => Disposable
}

export interface Registry {
  readonly providers: ProviderRegistry
  readonly models: ModelRegistry
  readonly tools: ToolRegistry
  readonly commands: CommandRegistry
  readonly hooks: HookRegistry
  readonly mcpServers: McpServerRegistry
  /** Agent types of plugins (Phase 10, plugin API 1.4.0). */
  readonly agents: AgentRegistry
  /** Skills of plugins (Phase 10, plugin API 1.4.0). */
  readonly skills: SkillRegistry
  /** Change notifications (catalog refresh, MCP manager, `plugin.changed`); listeners run synchronously. */
  readonly onChange: (listener: (change: RegistryChange) => void) => Disposable
  /** Current contributions of a plugin (`PluginSummary.contributions`; Phase 10: `agents`, `skills`). */
  readonly contributions: (pluginId: string) => PluginContributions
}
