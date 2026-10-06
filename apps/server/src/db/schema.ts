// Drizzle schema of `data/harness.db` (ARCHITECTURE.md section 8). FROZEN after Phase 0: changes go through a CCR and a
// new migration (`pnpm db:generate`). Conventions: timestamps are integer Unix epoch milliseconds, booleans are
// integers 0/1, JSON is stored as text, money is REAL USD. `created_at` / `updated_at` default to `Date.now()` when
// an insert omits them (runtime default, not a SQL default).
import type {
  BackgroundTaskStatus,
  ChatSettings,
  CustomizationKind,
  HarnessErrorInit,
  HarnessUIMessage,
  HookEvent,
  HookHandlerType,
  MarketplaceSource,
  MessageMetadata,
  ModelInfo,
  PluginFormat,
  PluginSource,
  ProviderStatus,
  RunOrigin,
  ShareOptions,
  ShareSnapshot,
  TaskOutput,
  TitleSource,
  ToolOverride,
  ToolPolicy,
  TrustItemKind,
} from '@harness-forge/shared'
import { relations, sql } from 'drizzle-orm'
import { blob, index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

/** Claude handler fields of a personal hook (Phase 12, ADR-057; column `hooks.options`). */
export interface PersonalHookOptions {
  readonly continueOnBlock?: boolean
  readonly args?: readonly string[]
  readonly async?: boolean
  readonly if?: string
  readonly statusMessage?: string
}

function timestamp(name: string) {
  return integer(name, { mode: 'number' })
}

function createdAt() {
  return timestamp('created_at').notNull().$defaultFn(() => Date.now())
}

function updatedAt() {
  return timestamp('updated_at').notNull().$defaultFn(() => Date.now())
}

function bool(name: string) {
  return integer(name, { mode: 'boolean' })
}

function json<T>(name: string) {
  return text(name, { mode: 'json' }).$type<T>()
}

/** Role of a stored UI message. */
export type MessageRole = HarnessUIMessage['role']

/**
 * Purpose of a usage row: a chat run, a title generation, an image generation (image turn or the `generate_image`
 * tool, ADR-028) or a voice request (ADR-029: dictation = `transcription`, read-aloud = `speech`); Phase 12: `hook` = a
 * prompt hook's model call (ADR-057). A type only: the column is plain text.
 */
export type UsagePurpose = 'chat' | 'title' | 'image' | 'transcription' | 'speech' | 'compact' | 'subagent' | 'hook'

/**
 * `mcp_servers.transport`: only header / env NAMES are stored; their values are secrets (scope `mcp:<id>`, names
 * `header.<Name>` / `env.<NAME>`).
 */
export type McpTransportRecord
  = | { type: 'http' | 'sse', url: string, headerNames: string[] }
    | { type: 'stdio', command: string, args: string[], envNames: string[] }

/** Global settings (API `Settings` keys) and internal keys (prefix `_`, never returned by the API). */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: json<unknown>('value').notNull(),
  updatedAt: updatedAt(),
})

/** Every secret, AES-256-GCM encrypted: `iv (12 B) || ciphertext || tag (16 B)`, AAD = `<scope>/<name>`. */
export const secrets = sqliteTable('secrets', {
  /** `provider:<id>` | `plugin:<id>` | `mcp:<id>` | `auth`. */
  scope: text('scope').notNull(),
  /** e.g. `apiKey`, `settings.<key>`, `header.<Name>`, `env.<NAME>`, `password`. */
  name: text('name').notNull(),
  ciphertext: blob('ciphertext', { mode: 'buffer' }).notNull(),
  /** Masked hint computed at write time (`sk-...9fQ2`), never the value. */
  hint: text('hint'),
  keyVersion: integer('key_version', { mode: 'number' }).notNull().default(1),
  updatedAt: updatedAt(),
}, table => [
  primaryKey({ columns: [table.scope, table.name] }),
])

/** Per-provider user configuration; a missing row means the defaults (enabled, no options). */
export const providerConfigs = sqliteTable('provider_configs', {
  providerId: text('provider_id').primaryKey(),
  enabled: bool('enabled').notNull().default(true),
  /** Non-secret credential values (e.g. `baseURL`). */
  options: json<Record<string, string>>('options').notNull().default({}),
  /** `ProviderStatus` computed at the last check. */
  status: text('status').$type<ProviderStatus>(),
  lastError: json<HarnessErrorInit>('last_error'),
  /** Last successful validation. */
  validatedAt: timestamp('validated_at'),
  updatedAt: updatedAt(),
})

/** Last good live model listing per provider. */
export const modelCache = sqliteTable('model_cache', {
  providerId: text('provider_id').primaryKey(),
  models: json<ModelInfo[]>('models').notNull().default([]),
  /** Last successful fetch. */
  fetchedAt: timestamp('fetched_at'),
  /** Last attempt (backoff). */
  attemptedAt: timestamp('attempted_at').notNull(),
  /** Error of the last failed attempt. */
  error: json<HarnessErrorInit>('error'),
})

/** User model preferences and custom models. */
export const modelPrefs = sqliteTable('model_prefs', {
  providerId: text('provider_id').notNull(),
  modelId: text('model_id').notNull(),
  /** null = default from `classify()`. */
  hidden: bool('hidden'),
  favorite: bool('favorite').notNull().default(false),
  /** Display name override. */
  alias: text('alias'),
  /** User-added model id. */
  custom: bool('custom').notNull().default(false),
  /** Metadata of custom models. */
  info: json<ModelInfo>('info'),
  /** Drives "recent" in the model picker. */
  lastUsedAt: timestamp('last_used_at'),
  updatedAt: updatedAt(),
}, table => [
  primaryKey({ columns: [table.providerId, table.modelId] }),
])

export const chats = sqliteTable('chats', {
  /** uuidv7 (client-generated). */
  id: text('id').primaryKey(),
  title: text('title'),
  titleSource: text('title_source').$type<TitleSource>(),
  /** Last used model ref. */
  modelRef: text('model_ref'),
  settings: json<ChatSettings>('settings').notNull().default({}),
  pinned: bool('pinned').notNull().default(false),
  archived: bool('archived').notNull().default(false),
  /** The last message of the active path waits for a tool approval. */
  pendingApproval: bool('pending_approval').notNull().default(false),
  /**
   * Last message of the path shown (ADR-023); null = empty chat. No foreign key: `remove()` deletes the messages of a
   * chat before the chat, and drizzle-kit cannot add `ON DELETE` to an `ALTER TABLE ... ADD` column.
   */
  activeLeafId: text('active_leaf_id'),
  /**
   * Project of the chat (ADR-031); null = no project. No foreign key: added by `ALTER TABLE` in migration 0004 (a
   * rebuild of `chats` would cascade-delete its messages); deleting a project detaches its chats in a transaction.
   */
  projectId: text('project_id'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, table => [
  index('chats_list_idx').on(table.archived, sql`${table.updatedAt} DESC`, sql`${table.id} DESC`),
  index('chats_project_idx').on(table.projectId, table.archived, sql`${table.updatedAt} DESC`, sql`${table.id} DESC`),
])

export const messages = sqliteTable('messages', {
  /** `msg_` + 16 chars. */
  id: text('id').primaryKey(),
  chatId: text('chat_id').notNull().references(() => chats.id, { onDelete: 'cascade' }),
  /**
   * Parent message in the same chat (ADR-023): null = a first message; versions of a message share a parent. No
   * foreign key (added by `ALTER TABLE` in migration 0001, which backfills a linear chain).
   */
  parentId: text('parent_id'),
  /**
   * The child last shown under this message (ADR-030): switching to a version restores the path last shown under it.
   * A hint without a foreign key (added by `ALTER TABLE` in migration 0002, which backfills the active paths); null or a
   * child that no longer exists means "the latest leaf".
   */
  selectedChildId: text('selected_child_id'),
  /** Creation order in the chat (unique per chat; a child is always created after its parent). */
  seq: integer('seq', { mode: 'number' }).notNull(),
  role: text('role').$type<MessageRole>().notNull(),
  parts: json<HarnessUIMessage['parts']>('parts').notNull(),
  metadata: json<MessageMetadata>('metadata'),
  /** Concatenated text parts, used by `GET /chats?q=`. */
  searchText: text('search_text').notNull().default(''),
  createdAt: createdAt(),
  /** Changes on approval continuations. */
  updatedAt: updatedAt(),
}, table => [
  uniqueIndex('messages_chat_seq_idx').on(table.chatId, table.seq),
  index('messages_chat_parent_idx').on(table.chatId, table.parentId),
])

/** One row per model call (chat run or title generation); kept when a chat is deleted. */
export const usage = sqliteTable('usage', {
  id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
  chatId: text('chat_id').references(() => chats.id, { onDelete: 'set null' }),
  messageId: text('message_id'),
  purpose: text('purpose').$type<UsagePurpose>().notNull().default('chat'),
  providerId: text('provider_id').notNull(),
  modelId: text('model_id').notNull(),
  /** Input tokens. */
  input: integer('input', { mode: 'number' }).notNull().default(0),
  /** Output tokens (reasoning included). */
  output: integer('output', { mode: 'number' }).notNull().default(0),
  /** Reasoning tokens (subset of output). */
  reasoning: integer('reasoning', { mode: 'number' }).notNull().default(0),
  cacheRead: integer('cache_read', { mode: 'number' }).notNull().default(0),
  cacheWrite: integer('cache_write', { mode: 'number' }).notNull().default(0),
  /** USD; unknown price = null. */
  costUsd: real('cost_usd'),
  createdAt: createdAt(),
}, table => [
  index('usage_chat_idx').on(table.chatId),
  index('usage_created_idx').on(table.createdAt),
])

/** One row per known plugin (builtins get a row at first boot). */
export const plugins = sqliteTable('plugins', {
  /** Plugin id = directory name. */
  id: text('id').primaryKey(),
  source: text('source').$type<PluginSource>().notNull(),
  /** npm spec, URL, linked absolute path, or zip file name. */
  sourceRef: text('source_ref'),
  version: text('version').notNull(),
  /** User intent. */
  enabled: bool('enabled').notNull().default(true),
  /** Trust pin: sha256 hex of `plugin.json` + entry, or `path:` + sha256 of the realpath for `link`. */
  trustedHash: text('trusted_hash'),
  /** Boot sentinel. */
  loadingSince: timestamp('loading_since'),
  lastError: json<HarnessErrorInit>('last_error'),
  installedAt: timestamp('installed_at').notNull().$defaultFn(() => Date.now()),
  updatedAt: updatedAt(),
  /** Phase 12 (ADR-053): `harness` (a `plugin.json` plugin) or `claude` (a Claude Code plugin read in place). */
  format: text('format').$type<PluginFormat>().notNull().default('harness'),
  /**
   * Phase 12 (ADR-054): where a GitHub or marketplace install came from (`StoredPluginOrigin` of `S/plugins/types.ts`:
   * marketplace + entry + commit / archive sha256 + the entry overlay, or a GitHub repo + commit); null otherwise.
   */
  origin: json<Record<string, unknown>>('origin'),
})

/**
 * Non-secret plugin settings values (`format: 'secret'` values live in `secrets`, scope `plugin:<id>`, name
 * `settings.<key>`). No foreign key, so `DELETE /plugins/:id?keepData=true` can keep the row.
 */
export const pluginSettings = sqliteTable('plugin_settings', {
  pluginId: text('plugin_id').primaryKey(),
  values: json<Record<string, unknown>>('values').notNull().default({}),
  updatedAt: updatedAt(),
})

/** `ctx.storage` (values <= 256 KB each, <= 10 MB per plugin). No foreign key (same reason). */
export const pluginKv = sqliteTable('plugin_kv', {
  pluginId: text('plugin_id').notNull(),
  /** <= 256 chars. */
  key: text('key').notNull(),
  value: json<unknown>('value').notNull(),
  updatedAt: updatedAt(),
}, table => [
  primaryKey({ columns: [table.pluginId, table.key] }),
])

export const toolPrefs = sqliteTable('tool_prefs', {
  toolName: text('tool_name').primaryKey(),
  enabled: bool('enabled').notNull().default(true),
  override: text('override').$type<ToolOverride>(),
  updatedAt: updatedAt(),
})

/** User-configured MCP servers (owned by `core-mcp`). */
export const mcpServers = sqliteTable('mcp_servers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  transport: json<McpTransportRecord>('transport').notNull(),
  policy: text('policy').$type<ToolPolicy>().notNull().default('ask'),
  enabled: bool('enabled').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

/** Upload metadata; bytes live in `data/files/<aa>/<sha256>` (deduplicated). */
export const files = sqliteTable('files', {
  /** `file_` + 16 chars. */
  id: text('id').primaryKey(),
  /** Lowercase hex. */
  sha256: text('sha256').notNull(),
  /** Sanitized original name (<= 255 chars). */
  name: text('name').notNull(),
  mime: text('mime').notNull(),
  /** Bytes. */
  size: integer('size', { mode: 'number' }).notNull(),
  createdAt: createdAt(),
}, table => [
  index('files_sha256_idx').on(table.sha256),
])

/**
 * Read-only share links (ADR-025): a sanitized snapshot of a chat's active path. The public token is derived from the
 * id with the keyring subkey `share` and never stored; deleting the row revokes the link.
 */
export const chatShares = sqliteTable('chat_shares', {
  /** `shr_` + 16 chars. */
  id: text('id').primaryKey(),
  chatId: text('chat_id').notNull().references(() => chats.id, { onDelete: 'cascade' }),
  /** Title shown on the share page (null = the chat title at snapshot time). */
  title: text('title'),
  options: json<ShareOptions>('options').notNull(),
  snapshot: json<ShareSnapshot>('snapshot').notNull(),
  /** The only file ids the share may serve. */
  fileIds: json<string[]>('file_ids').notNull().default([]),
  /** Messages of the snapshot (the active path length at snapshot time). */
  messageCount: integer('message_count', { mode: 'number' }).notNull().default(0),
  snapshotAt: timestamp('snapshot_at').notNull(),
  /** null = never expires. */
  expiresAt: timestamp('expires_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, table => [
  index('chat_shares_chat_idx').on(table.chatId),
])

/** Projects (ADR-031): a named folder on the server host, inside one of the workspace roots. */
export const projects = sqliteTable('projects', {
  /** `prj_` + 16 chars. */
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** Canonical realpath of the project folder (unique). */
  path: text('path').notNull(),
  /** Project instructions, joined after AGENTS.md / CLAUDE.md of the folder; null = none. */
  instructions: text('instructions'),
  /** Phase 11 (ADR-051, migration 0008): the project's output style name; null = the global setting `outputStyle`. */
  outputStyle: text('output_style'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, table => [
  uniqueIndex('projects_path_idx').on(table.path),
])

/**
 * Workspace change journal (Phase 8, ADR-036): one row per recorded change of a project file (an agent edit, a revert,
 * a rewind or an undo) and per unrestorable call (a shell command, a third-party write / execute tool). Before-states
 * live in `<dataDir>/checkpoints/<aa>/<sha256>`; after-states are kept as hashes only. Rows go with their chat or
 * project (cascade); never exported or backed up.
 */
export const workspaceChanges = sqliteTable('workspace_changes', {
  /** Global order (inserted under the per-file lock, so it follows the write order of each path). */
  id: integer('id').primaryKey({ autoIncrement: true }),
  chatId: text('chat_id').notNull().references(() => chats.id, { onDelete: 'cascade' }),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  /** `max(messages.seq)` of the chat at insert time: the rewind watermark. */
  messageSeq: integer('message_seq').notNull(),
  /** The assistant message of the run (null for user operations). */
  messageId: text('message_id'),
  toolCallId: text('tool_call_id'),
  /** `wcb_` + 16 chars: one revert, rewind or undo (null for agent edits). */
  batchId: text('batch_id'),
  /** `edit | revert | rewind | undo | shell | untracked`. */
  kind: text('kind').notNull(),
  /** The tool name (`write_file`, `edit_file`, `shell`, a plugin tool); null for user operations. */
  tool: text('tool'),
  /** Project-relative POSIX path of the target (null for `shell` / `untracked` rows). */
  path: text('path'),
  /** The shell command of a `shell` row (at most 1000 characters). */
  command: text('command'),
  /** `missing | stored | too-large | evicted` (null for `shell` / `untracked` rows). */
  beforeState: text('before_state'),
  beforeSha: text('before_sha'),
  beforeSize: integer('before_size'),
  beforeMode: integer('before_mode'),
  /** sha256 of the content written; null = the change removed the file. */
  afterSha: text('after_sha'),
  afterSize: integer('after_size'),
  createdAt: createdAt(),
}, table => [
  index('workspace_changes_chat_path_idx').on(table.chatId, table.path, table.id),
  index('workspace_changes_chat_seq_idx').on(table.chatId, table.messageSeq),
  index('workspace_changes_project_idx').on(table.projectId, table.id),
  index('workspace_changes_before_sha_idx').on(table.beforeSha),
])

/**
 * Shell rules (Phase 8, ADR-038): command prefixes that let a matching `shell` command run without asking. Global when
 * `project_id` is null. Not settings and not in backups (a backup never grants shell rights).
 */
export const shellRules = sqliteTable('shell_rules', {
  /** `srl_` + 16 chars. */
  id: text('id').primaryKey(),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  /** The canonical prefix (`parseShellRule(prefix).canonical`). */
  prefix: text('prefix').notNull(),
  createdAt: createdAt(),
}, table => [
  index('shell_rules_project_idx').on(table.projectId),
  // Phase 9 (migration 0006): one rule per scope and prefix (SQLite treats NULLs as distinct, hence two partial indexes).
  uniqueIndex('shell_rules_global_prefix_uq').on(table.prefix).where(sql`project_id is null`),
  uniqueIndex('shell_rules_project_prefix_uq').on(table.projectId, table.prefix).where(sql`project_id is not null`),
])

/**
 * Personal agents, commands and skills (Phase 10, ADR-044): the raw markdown with frontmatter, parsed by
 * `packages/shared/src/util/definitions.ts`; `name` / `description` are denormalized from it. In backups
 * (`customizations.json`), kept by delete-all.
 */
export const customizations = sqliteTable('customizations', {
  /** `cus_` + 16 chars. */
  id: text('id').primaryKey(),
  kind: text('kind').$type<CustomizationKind>().notNull(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  /** The markdown file (≤ `DEFINITION_LIMITS.contentBytes`). */
  content: text('content').notNull(),
  enabled: bool('enabled').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, table => [
  uniqueIndex('customizations_kind_name_uq').on(table.kind, table.name),
])

/**
 * Background sub-agents (Phase 10, ADR-046): one row per `task` call with `background: true`; `running` rows become
 * `aborted` at boot. Never in backups or exports; deleted with their chat.
 */
export const backgroundTasks = sqliteTable('background_tasks', {
  /** `bgt_` + 16 chars. */
  id: text('id').primaryKey(),
  chatId: text('chat_id').notNull().references(() => chats.id, { onDelete: 'cascade' }),
  /** The assistant message whose `task` call launched it. */
  messageId: text('message_id').notNull(),
  toolCallId: text('tool_call_id').notNull(),
  /** The agent type name. */
  type: text('type').notNull(),
  description: text('description').notNull(),
  status: text('status').$type<BackgroundTaskStatus>().notNull(),
  /** The origin of the launching run. */
  origin: text('origin').$type<RunOrigin>().notNull(),
  /** The latest `TaskOutput` snapshot (written at start and finish). */
  output: json<TaskOutput>('output').notNull(),
  createdAt: createdAt(),
  finishedAt: timestamp('finished_at'),
  deliveredAt: timestamp('delivered_at'),
  deliveredMessageId: text('delivered_message_id'),
}, table => [
  index('background_tasks_chat_idx').on(table.chatId, table.createdAt),
  index('background_tasks_pending_idx').on(table.deliveredAt, table.status),
])

/**
 * Personal command hooks (Phase 11, ADR-048): one row per hook handler in Claude Code's format (event, matcher,
 * command, timeout in seconds). Created and changed with fresh auth; never in backups; kept by delete-all.
 */
export const hooks = sqliteTable('hooks', {
  /** `hok_` + 16 chars. */
  id: text('id').primaryKey(),
  event: text('event').$type<HookEvent>().notNull(),
  /** The safe matcher subset (`compileMatcher`); null = every target. */
  matcher: text('matcher'),
  /** The shell command (run through `runShellCommand`). */
  command: text('command').notNull(),
  /** Seconds (1 – 600); null = the default 60 s (prompt hooks: 30 s). */
  timeout: integer('timeout', { mode: 'number' }),
  enabled: bool('enabled').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  /** Phase 12 (ADR-057): `command` or `prompt` (a prompt hook stores `command = ''`). */
  type: text('type').$type<HookHandlerType>().notNull().default('command'),
  /** The prompt of a prompt hook (`$ARGUMENTS` = the hook input); null for command hooks. */
  prompt: text('prompt'),
  /** A prompt hook's model (a model ref or a Claude alias); null = the `hookModelRef` setting, then the fallbacks. */
  model: text('model'),
  /** Claude handler fields: `{ continueOnBlock?, args?, async?, if?, statusMessage? }`; null = none. */
  options: json<PersonalHookOptions>('options'),
})

/**
 * Marketplaces (Phase 12, ADR-054): a Claude Code `marketplace.json` added from a GitHub repository, a URL or a server
 * folder. Refreshed only on request; never in backups; kept by delete-all.
 */
export const marketplaces = sqliteTable('marketplaces', {
  /** `mkt_` + 16 chars. */
  id: text('id').primaryKey(),
  /** The `marketplace.json` name (unique). */
  name: text('name').notNull(),
  source: json<MarketplaceSource>('source').notNull(),
  /** The resolved 40-hex commit (github), the sha256 of the fetched JSON (url) or null (path). */
  resolvedRef: text('resolved_ref'),
  /** The validated, normalized catalog (≤ 1 MiB); null before the first successful fetch. */
  catalog: json<Record<string, unknown>>('catalog'),
  fetchedAt: timestamp('fetched_at'),
  lastError: json<HarnessErrorInit>('last_error'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, table => [
  uniqueIndex('marketplaces_name_unique').on(table.name),
])

/**
 * Project trust (Phase 11, ADR-049): the sha256 of every approved executable item of a project folder (a hook, a
 * `.mcp.json` server, a command file with `!` spans). Deleted with the project; never in backups; kept by delete-all.
 */
export const projectTrust = sqliteTable('project_trust', {
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  /** sha256 (lowercase hex) of `trustHashInput(item)`. */
  sha256: text('sha256').notNull(),
  kind: text('kind').$type<TrustItemKind>().notNull(),
  /** A short label of the item when it was approved (matches a changed item to its old approval). */
  label: text('label').notNull(),
  createdAt: createdAt(),
}, table => [
  primaryKey({ columns: [table.projectId, table.sha256] }),
])

// ---------- relations (relational query API: `db.query.chats.findFirst({ with: { messages: true } })`) ----------

export const chatsRelations = relations(chats, ({ many }) => ({
  messages: many(messages),
  usage: many(usage),
  shares: many(chatShares),
}))

export const chatSharesRelations = relations(chatShares, ({ one }) => ({
  chat: one(chats, { fields: [chatShares.chatId], references: [chats.id] }),
}))

export const messagesRelations = relations(messages, ({ one }) => ({
  chat: one(chats, { fields: [messages.chatId], references: [chats.id] }),
}))

export const usageRelations = relations(usage, ({ one }) => ({
  chat: one(chats, { fields: [usage.chatId], references: [chats.id] }),
}))

/** Every table name (the 23 tables of DECISIONS.md "Database tables"). */
export const TABLE_NAMES = [
  'settings',
  'secrets',
  'provider_configs',
  'model_cache',
  'model_prefs',
  'chats',
  'messages',
  'usage',
  'plugins',
  'plugin_settings',
  'plugin_kv',
  'tool_prefs',
  'mcp_servers',
  'files',
  'chat_shares',
  'projects',
  'workspace_changes',
  'shell_rules',
  'customizations',
  'background_tasks',
  'hooks',
  'project_trust',
  'marketplaces',
] as const

// ---------- row types ----------

export type SettingRow = typeof settings.$inferSelect
export type SecretRow = typeof secrets.$inferSelect
export type ProviderConfigRow = typeof providerConfigs.$inferSelect
export type ModelCacheRow = typeof modelCache.$inferSelect
export type ModelPrefRow = typeof modelPrefs.$inferSelect
export type ChatRow = typeof chats.$inferSelect
export type MessageRow = typeof messages.$inferSelect
export type CustomizationRow = typeof customizations.$inferSelect
export type MarketplaceRow = typeof marketplaces.$inferSelect
export type BackgroundTaskRow = typeof backgroundTasks.$inferSelect
export type UsageRow = typeof usage.$inferSelect
export type PluginRow = typeof plugins.$inferSelect
export type PluginSettingsRow = typeof pluginSettings.$inferSelect
export type PluginKvRow = typeof pluginKv.$inferSelect
export type ToolPrefRow = typeof toolPrefs.$inferSelect
export type McpServerRow = typeof mcpServers.$inferSelect
export type FileRow = typeof files.$inferSelect
export type ChatShareRow = typeof chatShares.$inferSelect
export type ProjectRow = typeof projects.$inferSelect
export type WorkspaceChangeRow = typeof workspaceChanges.$inferSelect
export type ShellRuleRow = typeof shellRules.$inferSelect
export type HookRow = typeof hooks.$inferSelect
export type ProjectTrustRow = typeof projectTrust.$inferSelect
