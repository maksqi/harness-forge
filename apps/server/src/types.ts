import type { ModelCatalog } from './catalog/types.ts'
// Frozen composition contract: `AppDeps` is the single object that holds every service. `createDeps()` (deps.ts) builds
// it for `main.ts` and `createTestApp()`; `createApp(deps)` (app.ts) and every route module receive it. Services are
// typed by the frozen interfaces in `*/types.ts`; implementations are swapped in behind the same factory names.
import type { ChatRunner } from './chat/types.ts'
import type { Db } from './db/client.ts'
import type { Env } from './env.ts'
import type { Logger } from './logger.ts'
import type { McpManager, ToolService } from './mcp/types.ts'
import type { BuiltinPlugin, PluginDrafts, PluginFiles, PluginHost, PluginInstaller } from './plugins/types.ts'
import type { IconService, ProviderService } from './providers/types.ts'
import type { Registry } from './registry/types.ts'
import type { Keyring, PasswordService, Redactor, SessionService } from './security/types.ts'
import type { ChatsService } from './services/chats/types.ts'
import type { DataService } from './services/data/types.ts'
import type { EventBus } from './services/events/types.ts'
import type { FilesService } from './services/files/types.ts'
import type { CredentialService, SecretStore } from './services/secrets/types.ts'
import type { SettingsService } from './services/settings/types.ts'
import type { ShareService } from './services/shares/types.ts'

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
  /** Chats, messages, usage (W1.5); the message tree and the bulk data members (W5.1, ADR-023 / ADR-024). */
  readonly chats: ChatsService
  /** Uploaded files (W1.5); `importFile` / `purge` (W5.3, ADR-024). */
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
