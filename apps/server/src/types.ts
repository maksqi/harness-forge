import type { ModelCatalog } from './catalog/types.ts'
// Frozen composition contract: `AppDeps` is the single object that holds every service. `createDeps()` (deps.ts) builds
// it for `main.ts` and `createTestApp()`; `createApp(deps)` (app.ts) and every route module receive it. Services are
// typed by the frozen interfaces in `*/types.ts`; implementations are swapped in behind the same factory names.
import type { ChatRunner } from './chat/types.ts'
import type { Db } from './db/client.ts'
import type { Env } from './env.ts'
import type { Logger } from './logger.ts'
import type { McpManager, ProjectMcpManager, ToolService } from './mcp/types.ts'
import type { MarketplaceService } from './plugins/marketplaces/types.ts'
import type { BuiltinPlugin, PluginDrafts, PluginFiles, PluginHost, PluginInstaller } from './plugins/types.ts'
import type { IconService, ProviderService } from './providers/types.ts'
import type { Registry } from './registry/types.ts'
import type { Keyring, PasswordService, Redactor, SessionService } from './security/types.ts'
import type { AudioService } from './services/audio/types.ts'
import type { ChatsService } from './services/chats/types.ts'
import type { CheckpointService } from './services/checkpoints/types.ts'
import type { ClaudeImportService } from './services/claude-import/types.ts'
import type { CustomizationService } from './services/customizations/types.ts'
import type { DataService } from './services/data/types.ts'
import type { EventBus } from './services/events/types.ts'
import type { FilesService } from './services/files/types.ts'
import type { HookService } from './services/hooks/types.ts'
import type { ImageService } from './services/images/types.ts'
import type { KeyService } from './services/keys/types.ts'
import type { MaintenanceService } from './services/maintenance/types.ts'
import type { ProjectConfigService } from './services/project-config/types.ts'
import type { ProjectDefinitionsService } from './services/project-definitions/types.ts'
import type { ProjectFileService } from './services/project-files/types.ts'
import type { ProjectTrustService } from './services/project-trust/types.ts'
import type { ProjectService } from './services/projects/types.ts'
import type { CredentialService, SecretStore } from './services/secrets/types.ts'
import type { SettingsService } from './services/settings/types.ts'
import type { ShareService } from './services/shares/types.ts'
import type { ShellRuleService } from './services/shell-rules/types.ts'

/** Values created before the services (by `main.ts` or `createTestApp()`). */
export interface AppBase {
  readonly env: Env
  readonly logger: Logger
  readonly redactor: Redactor
  /** Drizzle over libsql (`data/harness.db`, or in-memory in tests), migrated. */
  readonly db: Db
  /** Builtin plugins to load (`getBuiltinPlugins(env)`, or a test override). */
  readonly builtins: readonly BuiltinPlugin[]
}

/** Every service, keyed by its `deps` name. Owners in parentheses. */
export interface AppServices {
  /** Master key + HKDF subkeys (W1.2). */
  readonly keyring: Keyring
  /** Password hashing + active password (W1.1). */
  readonly passwords: PasswordService
  /** `hf_session` tokens (W1.1). */
  readonly sessions: SessionService
  /** Server events bus behind `GET /api/events` (W1.5). */
  readonly events: EventBus
  /** Global settings + internal keys (W1.2). */
  readonly settings: SettingsService
  /** Encrypted secrets (W1.2). */
  readonly secrets: SecretStore
  /** Write-only provider credentials + resolution with env fallback (W1.2). */
  readonly credentials: CredentialService
  /** Providers, models, tools, commands, hooks, MCP declarations (W1.3). */
  readonly registry: Registry
  /** Plugin lifecycle, state, guard, logs (W1.3). */
  readonly plugins: PluginHost
  /** Install from zip / npm / URL / folder (W3.2). */
  readonly installer: PluginInstaller
  /** Declarative plugins created in the browser (W3.3). */
  readonly drafts: PluginDrafts
  /** Code plugin scaffold, files and build (W3.4). */
  readonly pluginFiles: PluginFiles
  /** LobeHub brand icons (W1.4). */
  readonly icons: IconService
  /** Provider DTOs, model resolution, provider tests, error mapping (W1.4). */
  readonly providers: ProviderService
  /** Model catalog (W1.4). */
  readonly catalog: ModelCatalog
  /**
   * Chats, messages, usage (W1.5); the message tree and the bulk data members (W5.1, ADR-023 / ADR-024); remembered
   * versions and `deleteMessage` (W6.6, ADR-030).
   */
  readonly chats: ChatsService
  /** Uploaded files (W1.5); `importFile` / `purge` (W5.3, ADR-024); `saveGenerated` (W6.4, ADR-028). */
  readonly files: FilesService
  /** Chat runs: stream, resume, stop (W2.1). */
  readonly runs: ChatRunner
  /** Tool list + preferences (W3.5). */
  readonly tools: ToolService
  /** MCP clients (W3.5). */
  readonly mcp: McpManager
  /** Bulk data: summary, backup export, import, delete-all (W5.3, ADR-024). */
  readonly data: DataService
  /** Read-only share links: owner operations and the public snapshot view (W5.4, ADR-025). */
  readonly shares: ShareService
  /** Image generation for image turns and `ctx.images` / `generate_image` (W6.4, ADR-028). */
  readonly images: ImageService
  /** Dictation (`transcribe`) and read-aloud (`speak`) behind `/api/audio/*` (W6.5, ADR-029). */
  readonly audio: AudioService
  /**
   * Projects (folders on the server host that chats belong to), the allowed workspace roots and `openWorkspace` for
   * chat runs (Phase 7, ADR-031; C14 stub, W7.1). `start()` is the first step of `startDeps()`.
   */
  readonly projects: ProjectService
  /** Master-key state and the online key rotation behind `/api/keys` (Phase 7, ADR-034; C16 stub, W7.7). */
  readonly keys: KeyService
  /**
   * One maintenance operation at a time: import, delete-all, key rotation, file cleanup; `blockRuns` refuses new chat
   * runs (Phase 7, ADR-034 / ADR-035; C16).
   */
  readonly maintenance: MaintenanceService
  /**
   * Checkpoints, rewind, revert, undo and the changes panel data: the journal of agent writes in `workspace_changes`
   * and the blob store `<dataDir>/checkpoints/` (Phase 8, ADR-036 / ADR-037; C19 stub, W8.1 - W8.3). `start()` runs
   * right after `projects.start()`; `stop()` after the runs stopped.
   */
  readonly checkpoints: CheckpointService
  /** Shell rules: the per-project and global allowlist of command prefixes (Phase 8, ADR-038; C19 stub, W8.6). */
  readonly shellRules: ShellRuleService
  /**
   * File mentions of project chats: the per-project in-memory file index (built lazily by the first search) and the
   * attach of a project file as an upload snapshot (Phase 9, ADR-042; C24 stub, W9.6). `stop()` runs right after the
   * runs stopped.
   */
  readonly projectFiles: ProjectFileService
  /**
   * The catalog of agents, commands and skills (builtin, plugin, personal and project definition files) and the personal
   * definitions of the `customizations` table (Phase 10, ADR-044 / ADR-045; C30 stub, W10.1). `stop()` runs right after
   * the runs stopped.
   */
  readonly customizations: CustomizationService
  /**
   * Command hooks (personal rows, approved project settings-file hooks, plugin `contributes.hooks`) and the plugin code
   * hooks of the Phase 11 events, merged into one snapshot per run and per prepare; the personal hooks and the run log
   * (Phase 11, ADR-048; C36 stub, W11.1). No boot step (lazy); `stop()` right after the runs stopped, before the project
   * MCP runtimes.
   */
  readonly hooks: HookService
  /**
   * The executable items of a project folder's settings files and `.mcp.json` with their trust hashes, and the
   * verify-before-run check (Phase 11, ADR-049 / ADR-050; C36 stub, W11.3). No boot step; `stop()` after the
   * customizations.
   */
  readonly projectConfig: ProjectConfigService
  /** The approved hashes of project items, the review list, approve and revoke (Phase 11, ADR-049; C36 stub, W11.3). */
  readonly projectTrust: ProjectTrustService
  /**
   * The servers of a project's `.mcp.json`, offered only in that project's chats (Phase 11, ADR-050; C36 stub, W11.4).
   * Lazy (no boot step); `stop()` right after the hooks.
   */
  readonly projectMcp: ProjectMcpManager
  /**
   * Claude Code plugin marketplaces: the `marketplaces` table, the GitHub / URL / folder sources read as HTTPS archives
   * through the plugin-source `safeFetch` (Phase 12, ADR-054; C43 stub, W12.2). Lazy (no boot step); `stop()` after the
   * checkpoints, before the plugins (the fetches in flight aborted).
   */
  readonly marketplaces: MarketplaceService
  /**
   * The import from a Claude Code home folder: the allowlisted scan of `HF_CLAUDE_HOME` or an upload, the in-memory plans
   * and apply (Phase 12, ADR-055; C43 stub with a real `home()`, W12.3). Lazy; `stop()` is the first shutdown step (the
   * plans dropped).
   */
  readonly claudeImport: ClaudeImportService
  /**
   * The project definition file editor: definitions, the `hooks` key of settings files and `.mcp.json`'s `mcpServers`
   * (Phase 12, ADR-056; C43 stub, W12.4). No state: no boot or shutdown step.
   */
  readonly projectDefinitions: ProjectDefinitionsService
}

export interface AppDeps extends AppBase, AppServices {}

export type ServiceName = keyof AppServices

/**
 * Passed by routes to service operations that may need fresh auth (ADR-017) depending on data only the service knows
 * (a stdio MCP server in a manifest, a code plugin's files). The service calls `requireFreshAuth()` before writing
 * anything; it throws `forbidden` (action `login`) when the session is not fresh. Routes pass
 * `{ requireFreshAuth: () => requireFreshAuth(c) }` (`http/middleware/fresh-auth.ts`).
 */
export interface SensitiveOperationOptions {
  requireFreshAuth: () => void
}
