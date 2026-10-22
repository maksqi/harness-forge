// Frozen interfaces of the MCP manager and of tool preferences (PLUGINS.md 5 / 10, API.md 5.12 / 5.13).
// Implementations (W3.5): `createMcpManager(deps)` in `mcp/index.ts`, `createToolService(deps)` in `mcp/tools.ts`.
// Phase 11 (ADR-050; API.md 4.32 / 5.33, ARCHITECTURE.md 6.30): the project MCP manager `ProjectMcpManager` (the servers
// of a project's `.mcp.json`, offered only in that project's chats). Implementation: `createProjectMcpManager(deps)` in
// `mcp/project.ts` (C36 stub: no tools; W11.4 implements the runtimes). Test double: `createFakeProjectMcpManager`
// (`testing/fake-project-mcp.ts`), installed with `createTestApp({ projectMcp: 'fake' })`.
// Phase 14 (ADR-059 / ADR-061, P14-0b C50; API.md 4.36 / 4.38, ARCHITECTURE.md 6.39 / 6.41 / 6.42): both managers gain
// the MCP prompts (`prompts`, `getPrompt`: slash commands `/mcp__<serverId>__<prompt>`), the MCP resources
// (`resources`, `readResource`: the `@` menu and its attach) and `authTarget` (where a server's OAuth secrets are
// stored, `McpAuthStorage`). The caches live in `mcp/{prompts,resources}.ts` (C51 stubs, W14.2); the content mapping in
// `mcp/content.ts`. Prompt and resource contents are untrusted text: capped before use, never logged at `info`.
import type { MCPClient } from '@ai-sdk/mcp'
import type {
  McpPromptArgument,
  McpServer,
  McpServerInput,
  McpServerStateAny,
  McpServerUpdate,
  ProjectMcpList,
  ProjectMcpServer,
  ProjectMcpVariablesBody,
  ToolOverride,
  ToolSummary,
  ToolUpdate,
} from '@harness-forge/shared'
import type { RegisteredTool } from '../registry/types.ts'
import type { SensitiveOperationOptions } from '../types.ts'
import type { McpAuthStorage } from './oauth/types.ts'

/** A prompt of a connected MCP server (Phase 14, ADR-061): offered as the slash command `/<commandName>`. */
export interface McpPromptInfo {
  readonly serverId: string
  /** The server's display name (`CommandSummary.mcpServer.name`). */
  readonly serverName: string
  /** The prompt's name as the server lists it (what `getPrompt` sends). */
  readonly name: string
  /** `mcpPromptCommandName(serverId, name)`: `mcp__<serverId>__<prompt>`, sanitized, at most 64 characters. */
  readonly commandName: string
  /** Untrusted plain text (capped). */
  readonly title: string | null
  /** Untrusted plain text (capped). */
  readonly description: string | null
  /** The declared arguments in order (at most `LIMITS.mcpPromptArgumentsMax`), for the hint and the binding. */
  readonly arguments: readonly McpPromptArgument[]
}

/** A resource of a connected MCP server (Phase 14, ADR-061; resource templates are not listed). Untrusted text. */
export interface McpResourceInfo {
  readonly serverId: string
  readonly serverName: string
  readonly uri: string
  readonly name: string
  readonly title: string | null
  readonly description: string | null
  readonly mimeType: string | null
  /** Bytes, when the server says. */
  readonly size: number | null
}

/** A server whose prompts or resources are missing from a listing, with its status (`McpStatus` / `ProjectMcpState`). */
export interface McpListingUnavailable {
  readonly serverId: string
  readonly status: McpServerStateAny
}

/** The prompts or resources of the connected servers of one scope (Phase 14). */
export interface McpListing<T> {
  /** Every server's entries (cached; at most `LIMITS.mcpPromptsMax` / `LIMITS.mcpResourcesMax` per server), by server. */
  readonly items: readonly T[]
  /** A server listed more entries than its cap (the rest are left out). */
  readonly truncated: boolean
  /**
   * Enabled servers of the scope that list nothing because they are not connected (connecting, `needs-auth`, error;
   * project servers: also `needs-variables`), with their status. Disabled and pending servers are not named.
   */
  readonly unavailable: readonly McpListingUnavailable[]
}

/** A project's listing (Phase 14): the global ids its approved servers replace in the project's chats (as for tools). */
export interface ProjectMcpListing<T> extends McpListing<T> {
  readonly shadowed: ReadonlySet<string>
}

/** Options of the project manager's `prompts` / `resources` (Phase 14). */
export interface ProjectMcpListingOptions {
  /** An abort ends the wait (the servers keep connecting). */
  readonly signal?: AbortSignal
  /**
   * How long to wait for approved servers that are not connected yet (they are started like `toolsFor` does); default
   * 0 = answer what is ready (the others are `unavailable`).
   */
  readonly waitMs?: number
}

/**
 * The result of `prompts/get` as `@ai-sdk/mcp` parses it (`messages` of user / assistant text, images, embedded
 * resources and resource links): mapped to the frozen command expansion by `mcp/content.ts`. Untrusted.
 */
export type McpPromptResult = Awaited<ReturnType<MCPClient['experimental_getPrompt']>>

/** The result of `resources/read` as `@ai-sdk/mcp` parses it (text and base64 `blob` contents). Untrusted. */
export type McpResourceContents = Awaited<ReturnType<MCPClient['readResource']>>

/**
 * One `@ai-sdk/mcp` client per enabled server declared in the registry (plugin declarations and `core-mcp` user
 * servers from `mcp_servers`). Connected servers' tools are registered as `mcp__<serverId>__<tool>` in the registry
 * (owner = the declaring plugin, `mcpServerId` set); connection changes emit `plugin.changed` for the owner.
 */
export interface McpManager {
  /** Boot (after the plugin host): connects declared servers in the background and follows registry changes. */
  readonly start: () => Promise<void>
  /** Closes every client (stdio children terminate). */
  readonly stop: () => Promise<void>
  /** User-configured (`editable`) and plugin-declared servers. */
  readonly list: () => Promise<McpServer[]>
  /** `not_found`. */
  readonly get: (id: string) => Promise<McpServer>
  /**
   * A `core-mcp` server: header / env values stored as secrets (`mcp:<id>`); `conflict` (`exists`). The route
   * requires fresh auth for stdio transports (or passes `requireFreshAuth` for the service to call).
   */
  readonly create: (input: McpServerInput, options?: SensitiveOperationOptions) => Promise<McpServer>
  /** `not_found`, `forbidden` (plugin-declared). Transport / `enabled` changes reconnect or close the client. */
  readonly update: (id: string, patch: McpServerUpdate, options?: SensitiveOperationOptions) => Promise<McpServer>
  /** Closes the client, unregisters its tools, deletes its secrets. `not_found`, `forbidden` (plugin-declared). */
  readonly remove: (id: string) => Promise<void>
  /** Close + reconnect, waiting up to 10 s. `not_found`, `conflict` (`disabled`). */
  readonly reconnect: (id: string) => Promise<McpServer>
  /**
   * Phase 14 (ADR-061): the prompts of the connected servers with the `prompts` capability (`GET /commands`, the slash
   * menus). The cache is filled on connect, on a stdio `notifications/prompts/list_changed` and here when it is older
   * than 60 s. Never rejects for a server problem (the server is `unavailable`).
   */
  readonly prompts: () => Promise<McpListing<McpPromptInfo>>
  /**
   * Phase 14 (ADR-061): `prompts/get` once (a command invocation; the result is frozen into the expansion). `args` are
   * the bound argument values. Throws `not_found` (unknown server or prompt), `conflict` `needs-auth` (the server needs
   * a sign-in), `provider_unreachable` (not connected) and `provider_error` (the server's error, redacted); an abort of
   * `signal` rejects with its reason.
   */
  readonly getPrompt: (serverId: string, name: string, args: Readonly<Record<string, string>>, signal: AbortSignal) => Promise<McpPromptResult>
  /**
   * Phase 14 (ADR-061): the resources of the connected servers with the `resources` capability (`GET /mcp/resources`),
   * cached under the prompt rules. Never rejects for a server problem.
   */
  readonly resources: () => Promise<McpListing<McpResourceInfo>>
  /**
   * Phase 14 (ADR-061): `resources/read` of one resource (`POST /mcp/resources/attach`; the caller caps the size). Throws
   * like `getPrompt`.
   */
  readonly readResource: (serverId: string, uri: string, signal: AbortSignal) => Promise<McpResourceContents>
  /**
   * Phase 14 (ADR-059): where the OAuth secrets of a server of `list()` are stored: a personal server → `user`
   * (`mcp:<id>`, `oauth.record`), a plugin or Claude Code plugin server → `plugin` (`plugin:<pluginId>`,
   * `mcp-oauth.<id>`); null for an unknown id.
   */
  readonly authTarget: (id: string) => McpAuthStorage | null
}

/** A `tool_prefs` row; a tool without a row is `{ enabled: true, override: null }`. */
export interface ToolPref {
  enabled: boolean
  override: ToolOverride | null
}

export interface ToolService {
  /** `GET /tools`: registry tools + tools of disconnected MCP servers (`available: false`), sorted by name. */
  readonly list: () => Promise<ToolSummary[]>
  /** `PATCH /tools/:name`: upserts `tool_prefs`; `not_found` for an unknown tool. */
  readonly update: (name: string, patch: ToolUpdate) => Promise<ToolSummary>
  /** Every stored pref (chat pipeline: disabled tools are not sent, `override` is approval step 1). */
  readonly prefs: () => Promise<ReadonlyMap<string, ToolPref>>
}

/** Options of `ProjectMcpManager.toolsFor`. */
export interface ProjectMcpToolsOptions {
  /** The run's signal: an abort ends the wait (the servers keep connecting for later runs). */
  readonly signal: AbortSignal
  /** How long to wait for servers that are still connecting (`LIMITS.projectMcpConnectWaitMs`, 5 s, for runs). */
  readonly waitMs: number
}

/** The project MCP tools of one run. */
export interface ProjectMcpTools {
  /**
   * The tools of the connected, approved servers (`mcp__<id>__<tool>`, `mcpServerId` set, owner `core-mcp`, the policy
   * from the annotations), sorted by name; never registered in the global registry.
   */
  readonly tools: RegisteredTool[]
  /** The ids of global MCP servers that a project server of the same id replaces in this project's chats. */
  readonly shadowed: ReadonlySet<string>
  /**
   * The names (as written in `.mcp.json`) of approved servers that were not ready within `waitMs` or failed: the run
   * has no tools of them and gets the notice `project-mcp-unavailable`. Pending servers (not approved) and servers that
   * need variables are not listed.
   */
  readonly unavailable: string[]
  /**
   * Server id → the server's name as written in `.mcp.json`, for the servers whose tools are in `tools`: hook matchers
   * also test `mcp__<name>__<tool>` (`hookTargetNames(tool, { mcpServerName })`; `My_Server.v2` has the id
   * `my-server-v2`).
   */
  readonly names: ReadonlyMap<string, string>
}

/**
 * The servers of a project's `.mcp.json` (Phase 11, ADR-050): one runtime per (project, server id) with a generation,
 * created lazily by `toolsFor`; a server starts only while its trust hash is approved (verified right before every
 * start) and its variables resolve (secret scope `project:<projectId>`, names `mcp.var.<NAME>`; never `process.env`).
 * Stdio servers run in their own process group (cwd = the project root, env = the minimal stdio environment + the
 * declared env). Stopped after `LIMITS.projectMcpIdleMs` without a run, on revoke, on a hash change, on a variables
 * change (restart), on project deletion (`project.changed { project: null }` → `stopProject` + the secret scope deleted)
 * and at shutdown; `HF_SAFE_MODE` starts nothing (`disabled`). Every state change emits `project-mcp.changed`. Variable
 * values, resolved env, args and headers are never logged. Errors are `HarnessError`s the routes pass through. Frozen
 * after P11-0b.
 */
export interface ProjectMcpManager {
  /**
   * The project MCP tools for a run of a project chat whose folder opened (`modelStream`, C37): starts the approved
   * servers that are not running, waits at most `options.waitMs` for the ones still connecting and answers what is
   * ready. Never rejects for a server problem (it is `unavailable`); rejects only when `options.signal` aborts.
   */
  readonly toolsFor: (projectId: string, options: ProjectMcpToolsOptions) => Promise<ProjectMcpTools>
  /**
   * `GET /projects/:id/mcp`: every server of the project's `.mcp.json` with its state (`pending` until approved), tools,
   * shadowed global id and missing variables, and the variables of every server (`set`, `hint`, `usedBy`; never a
   * value). Throws `not_found` for an unknown project.
   */
  readonly list: (projectId: string) => Promise<ProjectMcpList>
  /**
   * `PUT /projects/:id/mcp/variables`: calls `options.requireFreshAuth()` first when given (the route table marks the
   * route fresh too); a value sets a variable (stored encrypted), null removes it; the servers that use a changed
   * variable restart. Answers the list. Throws `not_found` for an unknown project.
   */
  readonly setVariables: (projectId: string, values: ProjectMcpVariablesBody['values'], options?: SensitiveOperationOptions) => Promise<ProjectMcpList>
  /**
   * `POST /projects/:id/mcp/:serverId/reconnect`: closes and restarts an approved server (a pending one stays pending)
   * and answers it. Throws `not_found` for an unknown project or server.
   */
  readonly reconnect: (projectId: string, serverId: string) => Promise<ProjectMcpServer>
  /** Stops every runtime of the project (project deletion, revoke of every item). Never rejects. */
  readonly stopProject: (projectId: string) => Promise<void>
  /**
   * Phase 14 (ADR-061): the prompts of the project's connected, approved servers (`GET /commands?projectId=`; a project
   * server shadows the global server of the same id, `shadowed`). Throws `not_found` for an unknown project; never
   * rejects for a server problem; an abort of `options.signal` rejects with its reason.
   */
  readonly prompts: (projectId: string, options?: ProjectMcpListingOptions) => Promise<ProjectMcpListing<McpPromptInfo>>
  /** Phase 14: `McpManager.getPrompt` for a project server; also `conflict` `untrusted` for a pending one. */
  readonly getPrompt: (projectId: string, serverId: string, name: string, args: Readonly<Record<string, string>>, signal: AbortSignal) => Promise<McpPromptResult>
  /** Phase 14 (ADR-061): the resources of the project's connected, approved servers (`GET /mcp/resources?projectId=`). */
  readonly resources: (projectId: string, options?: ProjectMcpListingOptions) => Promise<ProjectMcpListing<McpResourceInfo>>
  /** Phase 14: `McpManager.readResource` for a project server; also `conflict` `untrusted` for a pending one. */
  readonly readResource: (projectId: string, serverId: string, uri: string, signal: AbortSignal) => Promise<McpResourceContents>
  /**
   * Phase 14 (ADR-059): where the OAuth secrets of a project server are stored: `project` (`project:<projectId>`,
   * `mcp-oauth.<serverId>`). Pure (no existence check: the routes check the server first).
   */
  readonly authTarget: (projectId: string, serverId: string) => McpAuthStorage
  /**
   * Shutdown (`stopDeps`, right after the hooks): stops every runtime (stdio process groups killed), drops the
   * subscriptions and timers. Idempotent; never rejects.
   */
  readonly stop: () => Promise<void>
}
