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
//
// Phase 11 (plugin API 1.5.0, ADR-048 / ADR-051; C36): the kinds `style` and `hookCommands`, the registries `styles`
// (output styles of plugins: manifest `contributes.outputStyles`, `ctx.outputStyles.register`) and `hookCommands` (the
// command hooks of a plugin's `contributes.hooks`, one registration per plugin with the plugin folder) and the
// contributions `outputStyles` / `commandHooks`. C36 lands them empty (`registry/{styles,hook-commands}.ts`: nothing
// registered, `register` answers `not_implemented`); W11.7 implements the registration and its validation. The
// customization catalog reads `styles` (W11.6), the hook service `hookCommands` (W11.1).
//
// Phase 12 (plugin API 1.6.0, ADR-053 / ADR-057; C43, frozen after Gate P12-0b): a command hook registration may carry
// extra environment variables for the plugin's hooks (`env`: `CLAUDE_PLUGIN_DATA`, `CLAUDE_PLUGIN_OPTION_<KEY>`) and
// prompt hook handlers (`prompts`); an MCP server may carry its Claude Code name (`claudeName`, so the tool alias
// `mcp__plugin_<name>_<server>__*` of a Claude Code plugin resolves and matches hooks). Names of agents, skills, styles
// and commands may be qualified with the owner's id (`<pluginId>:<name>`, `catalogNameSchema`): W12.1 validates them.
import type {
  AgentDefinition,
  CommandDefinition,
  Disposable,
  HookHandler,
  HookMap,
  HookName,
  HooksConfig,
  McpServerDecl,
  ModelInfo,
  OutputStyleDefinition,
  ProviderDefinition,
  SkillDefinition,
  ToolDefinition,
} from '@harness-forge/plugin-sdk'
import type { HookDiagnostic, HookSpec, PluginContributions, PromptHookSpec } from '@harness-forge/shared'

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
  /**
   * Phase 12 (ADR-053): the server's Claude Code name `plugin_<plugin name>_<server name>` (a server of a Claude Code
   * plugin, whose harness id is `<pluginId>` or `<pluginId>-<slug>`): the tool alias `mcp__<claudeName>__<tool>` is
   * rewritten to the harness tool name in `tools` / `allowed-tools` and matched by hook matchers. Absent otherwise.
   */
  readonly claudeName?: string
}

/** Options of `McpServerRegistry.register` (Phase 12). */
export interface McpServerRegisterOptions {
  /** The Claude Code name of the server (`RegisteredMcpServer.claudeName`): `plugin_<name>_<server>`, ≤ 128 characters. */
  readonly claudeName?: string
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

/** An output style contributed by a plugin (manifest `contributes.outputStyles` or `ctx.outputStyles.register`; 1.5.0). */
export interface RegisteredStyle {
  readonly pluginId: string
  readonly definition: OutputStyleDefinition
}

/** What a plugin's command hooks are registered with (the loader, from the manifest `contributes.hooks`; 1.5.0). */
export interface HookCommandsRegistration {
  /**
   * The plugin's folder (canonical): `HARNESS_PLUGIN_ROOT` / `CLAUDE_PLUGIN_ROOT` of its hooks (their working folder
   * stays the chat's project root, else `<dataDir>/hooks`).
   */
  readonly root: string
  /** The Claude Code `hooks` object as declared (at most `LIMITS.pluginHooksMax` handlers). */
  readonly hooks: HooksConfig
  /**
   * Phase 12 (ADR-053): extra environment variables of the plugin's command hooks (a Claude Code plugin:
   * `CLAUDE_PLUGIN_DATA` = its private data folder and `CLAUDE_PLUGIN_OPTION_<KEY>` = its `userConfig` values), merged
   * over the minimal hook environment (`HARNESS_PLUGIN_ROOT` / `CLAUDE_PLUGIN_ROOT` and the project variables win; the
   * reserved names of `SHELL_ENV_RESERVED` are refused). Never read from `process.env`. Absent = none.
   */
  readonly env?: Readonly<Record<string, string>>
  /**
   * Phase 12 (ADR-057): prompt hook handlers of the plugin read elsewhere (`readHooksConfig(…, { source: 'plugin',
   * prompts: true })` of a Claude Code plugin's merged hook files), added to the prompt handlers of `hooks`. Counted
   * with the command handlers against `LIMITS.pluginHooksMax`. Absent = none.
   */
  readonly prompts?: readonly PromptHookSpec[]
}

/** The command hooks of one plugin (manifest `contributes.hooks`; plugin API 1.5.0, ADR-048). */
export interface RegisteredHookCommands {
  readonly pluginId: string
  /** The plugin's folder (`HookCommandsRegistration.root`). */
  readonly root: string
  /**
   * The valid handlers (`readHooksConfig(hooks, { source: 'plugin' })`), in declaration order; a handler with an `error`
   * diagnostic is not listed and never runs.
   */
  readonly hooks: readonly HookSpec[]
  /** What `readHooksConfig` reported (shown by `GET /hooks`). */
  readonly diagnostics: readonly HookDiagnostic[]
  /** Phase 12: the extra environment of the plugin's command hooks (`HookCommandsRegistration.env`; empty = none). */
  readonly env: Readonly<Record<string, string>>
  /**
   * Phase 12 (ADR-057): the valid prompt hook handlers (of `hooks` and `HookCommandsRegistration.prompts`), in
   * declaration order; they run as prompt hooks of source `plugin` while the plugin is active (no trust pin needed).
   */
  readonly prompts: readonly PromptHookSpec[]
}

export type RegistryKind = 'provider' | 'models' | 'tool' | 'command' | 'hook' | 'mcpServer' | 'agent' | 'skill' | 'style' | 'hookCommands'

/**
 * A registration was added or removed. `key`: provider id, provider id (models), tool / command / hook name, MCP id,
 * agent or skill name (Phase 10), output style name (`style`, Phase 11), plugin id (`hookCommands`, Phase 11).
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
  /**
   * Same rules as `contributes.mcpServers`; a duplicate id (across plugins and user servers) throws `conflict`. Phase 12:
   * `options.claudeName` records the Claude Code name of a Claude Code plugin's server (`RegisteredMcpServer.claudeName`).
   */
  readonly register: (pluginId: string, decl: McpServerDecl, options?: McpServerRegisterOptions) => Disposable
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

/**
 * Output styles of plugins (Phase 11, plugin API 1.5.0, ADR-051). Names follow `AGENT_NAME_PATTERN`; the builtin names
 * (`default`, `explanatory`, `learning`) are reserved. Sorted by name.
 */
export interface StyleRegistry {
  /**
   * Validates the definition (`declarativeOutputStyleSchema`: name pattern and reserved names, description, `content` ≤
   * 64 KiB) and adds it; a name another plugin registered throws `conflict` (W11.7; the C36 stub throws
   * `not_implemented`).
   */
  readonly register: (pluginId: string, definition: OutputStyleDefinition) => Disposable
  readonly get: (name: string) => RegisteredStyle | undefined
  /** Sorted by name. */
  readonly list: () => RegisteredStyle[]
  /** The plugin that registered `name`, or undefined. */
  readonly owner: (name: string) => string | undefined
  /** Changes of styles only (`RegistryChange.kind === 'style'`); listeners run synchronously. */
  readonly onChange: (listener: (change: RegistryChange) => void) => Disposable
}

/**
 * Command hooks of plugins (Phase 11, plugin API 1.5.0, ADR-048): one registration per plugin. A plugin with command
 * hooks requires trust; its hooks run only while it is active (the hook service checks the plugin state per snapshot).
 */
export interface HookCommandRegistry {
  /**
   * Reads `registration.hooks` with `readHooksConfig(…, { source: 'plugin' })` (at most `LIMITS.pluginHooksMax`
   * handlers) and adds them; a second registration of the same plugin throws `conflict` (W11.7; the C36 stub throws
   * `not_implemented`). Phase 12: also `registration.env` and the prompt handlers (`registration.prompts` and, read
   * with `prompts: true`, those of `hooks`; W12.1).
   */
  readonly register: (pluginId: string, registration: HookCommandsRegistration) => Disposable
  /** The registration of a plugin, or undefined. */
  readonly get: (pluginId: string) => RegisteredHookCommands | undefined
  /** Registry order (builtins first in load order, then user plugins by id). */
  readonly list: () => RegisteredHookCommands[]
  /** Changes of command hooks only (`RegistryChange.kind === 'hookCommands'`, key = the plugin id). */
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
  /** Output styles of plugins (Phase 11, plugin API 1.5.0). */
  readonly styles: StyleRegistry
  /** Command hooks of plugins (Phase 11, plugin API 1.5.0). */
  readonly hookCommands: HookCommandRegistry
  /** Change notifications (catalog refresh, MCP manager, `plugin.changed`); listeners run synchronously. */
  readonly onChange: (listener: (change: RegistryChange) => void) => Disposable
  /**
   * Current contributions of a plugin (`PluginSummary.contributions`; Phase 10: `agents`, `skills`; Phase 11:
   * `commandHooks` = the count of its registered command hook handlers, `outputStyles` = its style names, sorted).
   */
  readonly contributions: (pluginId: string) => PluginContributions
}
