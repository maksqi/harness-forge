// Enumerations of the contract (DECISIONS.md "Enumerations", API.md section 4.1, PLUGINS.md section 9).
// Error codes and actions live in `errors.ts`.
import { z } from 'zod'
import { CLAUDE_ENTRY_SOURCE_KINDS } from './util/claude-plugins.ts'
import {
  CUSTOMIZATION_KINDS,
  CUSTOMIZATION_SOURCES,
  DEFINITION_DIAGNOSTIC_CODES,
  DEFINITION_DIAGNOSTIC_LEVELS,
} from './util/definitions.ts'
import { HOOK_DIAGNOSTIC_CODES, HOOK_EVENTS, HOOK_SOURCES } from './util/hooks.ts'
import { MCP_JSON_TRANSPORTS } from './util/mcp-config.ts'
import { TRUST_ITEM_KINDS } from './util/trust.ts'

/**
 * Chat permission mode (UI label: permission mode). Default `ask`. `edits` ("Accept edits", Phase 7, ADR-032): safe
 * tools and `ask` tools with workspace access `write` run without asking; everything else asks. `plan` ("Plan", Phase 9,
 * ADR-041): read-only; tools with workspace access `write` / `execute` are not offered, the agent proposes a plan with
 * `exit_plan_mode`, everything else asks like `ask`. The order is the order of the UI lists.
 */
export const toolModeSchema = z.enum(['off', 'ask', 'edits', 'plan', 'auto'])
export type ToolMode = z.infer<typeof toolModeSchema>

/**
 * What a tool does with the project folder of a chat (`ToolDefinition.workspace`, `ToolSummary.workspace`; Phase 7,
 * ADR-032): such a tool is offered only in chats whose project folder opened; `execute` tools only while
 * `HF_WORKSPACE_SHELL` is not `0` (ADR-033).
 */
export const workspaceAccessSchema = z.enum(['read', 'write', 'execute'])
export type WorkspaceAccess = z.infer<typeof workspaceAccessSchema>

/** Reasoning effort; `auto` sends nothing to the provider. */
export const reasoningEffortSchema = z.enum(['auto', 'off', 'low', 'medium', 'high', 'max'])
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>

/** Approval policy of a tool. */
export const toolPolicySchema = z.enum(['safe', 'ask', 'always'])
export type ToolPolicy = z.infer<typeof toolPolicySchema>

/** User override of a tool's approval (`tool_prefs.override`). */
export const toolOverrideSchema = z.enum(['allow', 'ask', 'deny'])
export type ToolOverride = z.infer<typeof toolOverrideSchema>

export const providerStatusSchema = z.enum(['connected', 'not_configured', 'env', 'error'])
export type ProviderStatus = z.infer<typeof providerStatusSchema>

export const pluginKindSchema = z.enum(['declarative', 'code'])
export type PluginKind = z.infer<typeof pluginKindSchema>

/**
 * Where an installed plugin comes from. Phase 12 (ADR-054): `github` (an archive of a resolved commit of a GitHub
 * repository) and `marketplace` (an entry of a marketplace, `PluginDetail.origin`).
 */
export const pluginSourceSchema = z.enum(['builtin', 'created', 'zip', 'npm', 'url', 'link', 'copy', 'github', 'marketplace'])
export type PluginSource = z.infer<typeof pluginSourceSchema>

/**
 * The layout of a plugin folder (Phase 12, ADR-053; column `plugins.format`): `harness` (a root `plugin.json`, the
 * harness manifest) or `claude` (a Claude Code plugin: `.claude-plugin/plugin.json` and / or Claude components).
 */
export const pluginFormatSchema = z.enum(['harness', 'claude'])
export type PluginFormat = z.infer<typeof pluginFormatSchema>

export const pluginStateSchema = z.enum(['disabled', 'untrusted', 'incompatible', 'loading', 'active', 'error'])
export type PluginState = z.infer<typeof pluginStateSchema>

/** Advisory plugin permissions (PLUGINS.md section 3). */
export const pluginPermissionSchema = z.enum(['network', 'secrets', 'storage', 'hooks', 'process'])
export type PluginPermission = z.infer<typeof pluginPermissionSchema>

/** Wire format of a declarative provider. */
export const apiFormatSchema = z.enum(['openai-chat', 'openai-responses', 'anthropic', 'google'])
export type ApiFormat = z.infer<typeof apiFormatSchema>

/** How a declarative provider maps the effort menu to request options (PLUGINS.md section 4). */
export const reasoningStyleSchema = z.enum(['openai-effort', 'anthropic-thinking', 'google-thinking', 'none'])
export type ReasoningStyle = z.infer<typeof reasoningStyleSchema>

/** Input type of a provider credential field. */
export const credentialFieldTypeSchema = z.enum(['secret', 'text', 'url', 'select'])
export type CredentialFieldType = z.infer<typeof credentialFieldTypeSchema>

/**
 * Kind of a model. Only `chat` models (and `image` models of providers that can generate images, ADR-028) are shown in
 * the chat model picker; `transcription` (speech to text) and `speech` (text to speech) models serve dictation and
 * read-aloud (Phase 6, ADR-029); `audio` covers other audio models.
 */
export const modelKindSchema = z.enum(['chat', 'embedding', 'image', 'audio', 'transcription', 'speech', 'other'])
export type ModelKind = z.infer<typeof modelKindSchema>

/** Where a catalog entry comes from. */
export const modelSourceSchema = z.enum(['custom', 'live', 'plugin', 'seed'])
export type ModelSource = z.infer<typeof modelSourceSchema>

export const titleSourceSchema = z.enum(['auto', 'fallback', 'user'])
export type TitleSource = z.infer<typeof titleSourceSchema>

/** Where a resolved secret comes from (`stored` wins over `env`). */
export const secretSourceSchema = z.enum(['stored', 'env'])
export type SecretSource = z.infer<typeof secretSourceSchema>

export const mcpStatusSchema = z.enum(['disabled', 'connecting', 'connected', 'error'])
export type McpStatus = z.infer<typeof mcpStatusSchema>

export const logLevelSchema = z.enum(['debug', 'info', 'warn', 'error'])
export type LogLevel = z.infer<typeof logLevelSchema>

// ---------- marketplaces (Phase 12, ADR-054) ----------

/**
 * Where a marketplace is read from: `github` (`.claude-plugin/marketplace.json` of a resolved commit of a repository),
 * `url` (a hosted `marketplace.json`) or `path` (a folder on the server host).
 */
export const marketplaceSourceTypeSchema = z.enum(['github', 'url', 'path'])
export type MarketplaceSourceType = z.infer<typeof marketplaceSourceTypeSchema>

/**
 * The source kind of a marketplace entry (`CLAUDE_ENTRY_SOURCE_KINDS` of `util/claude-plugins.ts`, type
 * `ClaudeEntrySourceKind`): installable are `relative`, `github`, `archive` and `npm` (default registry); a github.com
 * `url` / `git-subdir` entry is classified as `github`; other git hosts, `command` and `unknown` are unsupported.
 */
export const marketplaceEntrySourceKindSchema = z.enum(CLAUDE_ENTRY_SOURCE_KINDS)

/** Code plugin templates of `POST /plugins/scaffold`. */
export const pluginTemplateIdSchema = z.enum(['tool', 'provider', 'mcp-bridge', 'command-pack'])
export type PluginTemplateId = z.infer<typeof pluginTemplateIdSchema>

// ---------- workspace 2.0 (Phase 8) ----------

/**
 * Kind of a row of the workspace change journal (ADR-036): `edit` (an agent `write_file` / `edit_file`), `revert`,
 * `rewind` and `undo` (user operations, one batch each), `shell` (a shell command, never restorable) and `untracked` (a
 * call of another tool with workspace access `write` / `execute`, never restorable).
 */
export const workspaceChangeKindSchema = z.enum(['edit', 'revert', 'rewind', 'undo', 'shell', 'untracked'])
export type WorkspaceChangeKind = z.infer<typeof workspaceChangeKindSchema>

/** View of the changes panel (ADR-037): `chat` (from the change journal, no git needed) or `git` (against HEAD). */
export const changeSourceSchema = z.enum(['chat', 'git'])
export type ChangeSource = z.infer<typeof changeSourceSchema>

/**
 * What a rewind or an undo does with a file that changed since its last recorded change (ADR-036): `skip` it (listed
 * as a conflict), or `force` the restore.
 */
export const conflictHandlingSchema = z.enum(['skip', 'force'])
export type ConflictHandling = z.infer<typeof conflictHandlingSchema>

/**
 * What wrote the files of a `workspace.changed` event (ADR-036): an agent tool, or a user rewind, revert or undo; Phase
 * 12 (ADR-056): `user`, a project definition file saved from the UI (not journaled, `chatId: null`).
 */
export const workspaceChangedSourceSchema = z.enum(['tool', 'rewind', 'revert', 'undo', 'user'])
export type WorkspaceChangedSource = z.infer<typeof workspaceChangedSourceSchema>

/** The automatic orphaned-file sweep (setting `fileSweep`, ADR-039): `off` (default), `daily` or `weekly`. */
export const fileSweepModeSchema = z.enum(['off', 'daily', 'weekly'])
export type FileSweepMode = z.infer<typeof fileSweepModeSchema>

// ---------- agent 2.0 (Phase 9) ----------

/** Status of a todo item of `todo_write` (ADR-041). */
export const todoStatusSchema = z.enum(['pending', 'in_progress', 'completed'])
export type TodoStatus = z.infer<typeof todoStatusSchema>

/**
 * The builtin sub-agent types of the `task` tool (ADR-043): `explore` is read-only, `general` gets the parent's tools.
 * Since Phase 10 (ADR-045) `task.type` names any agent of the catalog (`agentTypeInputSchema`); this enum stays the
 * builtin set (the web picks the icons of the builtins with it).
 */
export const taskTypeSchema = z.enum(['explore', 'general'])
export type TaskType = z.infer<typeof taskTypeSchema>

/**
 * What started a run (Phase 9, ADR-042; `run.started.origin`): a `POST /chat` request, the server with the first queued
 * message (`queue`), since Phase 10 (ADR-046) the server with the results of finished background tasks (`task`), and
 * since Phase 11 (ADR-048) the server after a `Stop` hook blocked the end of a run (`hook`: a follow-up turn from a
 * user-role carrier message that holds only `data-hook` parts). Also the origin of the run that launched a background
 * task (`BackgroundTask.origin`).
 */
export const runOriginSchema = z.enum(['request', 'queue', 'task', 'hook'])
export type RunOrigin = z.infer<typeof runOriginSchema>

// ---------- agent customization (Phase 10) ----------

/** Kind of a definition (ADR-044): an agent type, a slash command or a skill (type `CustomizationKind`). */
export const customizationKindSchema = z.enum(CUSTOMIZATION_KINDS)

/**
 * Where a catalog entry comes from (ADR-044; type `CustomizationSource`); precedence, lowest first: `builtin` < `plugin`
 * < `user` (Settings -> Customize, table `customizations`) < `project` (`.claude/{kind}`, then `.harness/{kind}` of the
 * project folder).
 */
export const customizationSourceSchema = z.enum(CUSTOMIZATION_SOURCES)

/**
 * State of a catalog entry: `active` (wins its name), `shadowed` (a higher source or an earlier file has the name),
 * `invalid` (an `error` diagnostic: the definition cannot be used) or `off` (a personal definition turned off).
 */
export const customizationStateSchema = z.enum(['active', 'shadowed', 'invalid', 'off'])
export type CustomizationState = z.infer<typeof customizationStateSchema>

/** Where a server-side slash command comes from (`GET /commands`, ADR-045); `harness` = run by the server itself. */
export const commandSourceSchema = z.enum(['harness', 'plugin', 'user', 'project'])
export type CommandSource = z.infer<typeof commandSourceSchema>

/**
 * Where `/remember` writes (ADR-047): the project file (`AGENTS.md`, else `CLAUDE.md`, else a new `AGENTS.md`), the
 * project's instructions, or the global Custom instructions.
 */
export const rememberTargetSchema = z.enum(['project-file', 'project-instructions', 'global'])
export type RememberTarget = z.infer<typeof rememberTargetSchema>

/**
 * Level of a definition diagnostic (type `DefinitionDiagnosticLevel`): `error` (unusable, state `invalid`), `warning`
 * (used, something dropped) or `info`.
 */
export const definitionDiagnosticLevelSchema = z.enum(DEFINITION_DIAGNOSTIC_LEVELS)

/** Code of a definition diagnostic (`DEFINITION_DIAGNOSTIC_CODES`, type `DefinitionDiagnosticCode`). */
export const definitionDiagnosticCodeSchema = z.enum(DEFINITION_DIAGNOSTIC_CODES)

/**
 * A problem of a definition or of a definition folder (zod mirror of the `DefinitionDiagnostic` interface, which is its
 * type): never an error of the request; the message is one English sentence without file contents, the path is
 * project-relative.
 */
export const definitionDiagnosticSchema = z.object({
  level: definitionDiagnosticLevelSchema,
  code: definitionDiagnosticCodeSchema,
  message: z.string().max(1000),
  /** 1-based line in the file, when known. */
  line: z.int().min(1).optional(),
  /** Project-relative path (catalog diagnostics only). */
  path: z.string().max(4096).optional(),
  kind: customizationKindSchema.optional(),
  name: z.string().max(256).optional(),
})

// ---------- hooks, trust, project MCP and output styles (Phase 11) ----------

/**
 * The hook events (ADR-048; Claude Code names, `HOOK_EVENTS` of `util/hooks.ts`, type `HookEvent`): `PreToolUse`,
 * `PostToolUse`, `UserPromptSubmit`, `Notification`, `Stop`, `SubagentStop`, `PreCompact`, `SessionStart`; Phase 12
 * (ADR-057): `PostToolUseFailure`, `PermissionRequest`, `SubagentStart`, `PostCompact`, `SessionEnd` (13).
 */
export const hookEventSchema = z.enum(HOOK_EVENTS)

/**
 * The type of a hook handler (Phase 12, ADR-057): `command` (a shell command, the Phase 11 handler) or `prompt` (a small
 * model answers `{ ok, reason?, impossible? }` about the hook input; never a permission grant).
 */
export const hookHandlerTypeSchema = z.enum(['command', 'prompt'])
export type HookHandlerType = z.infer<typeof hookHandlerTypeSchema>

/**
 * Where a command hook comes from (ADR-048; `HOOK_SOURCES`, type `HookSource`): a personal hook (table `hooks`), a
 * project settings file (`.harness` / `.claude` `settings{,.local}.json`, only after approval, ADR-049) or a plugin.
 */
export const hookSourceSchema = z.enum(HOOK_SOURCES)

/** A command hook (a shell command run through the workspace shell runner) or a plugin code hook (`ctx.hooks.on`). */
export const hookKindSchema = z.enum(['command', 'code'])
export type HookKind = z.infer<typeof hookKindSchema>

/**
 * State of a hook in `GET /hooks` (ADR-048): `active` (runs), `pending` (a project hook whose hash is not approved,
 * ADR-049; Phase 12: also a hook of an untrusted plugin, listed from its manifest), `off` (a personal hook turned
 * off), `invalid` (an `error` diagnostic, e.g. a regex-like matcher: never runs) or `blocked` (a kill switch is on: the
 * setting `hooksEnabled`, `HF_WORKSPACE_SHELL=0` or `HF_SAFE_MODE`).
 */
export const hookStateSchema = z.enum(['active', 'pending', 'off', 'invalid', 'blocked'])
export type HookState = z.infer<typeof hookStateSchema>

/**
 * What the hooks of one event did (`data-hook` `outcome`, the run log; ADR-048; named apart from the `HookOutcome`
 * reading of one process in `util/hooks.ts`): `context` (model-visible context
 * added), `denied` (`PreToolUse` deny or exit 2: the tool call was refused), `asked` (`PreToolUse` ask: an approval card),
 * `allowed` (`PreToolUse` allow: the card was skipped), `rewritten` (`PreToolUse` `updatedInput`), `blocked` (a block
 * with a reason: `PostToolUse` feedback, `UserPromptSubmit` / `SessionStart` refusal, a `SubagentStop` continuation),
 * `continued` (a `Stop` hook blocked the end of the run: a follow-up turn), `stopped` (`continue: false`) or `error` (a
 * non-blocking failure: another exit code, a timeout, invalid output).
 */
export const hookRecordOutcomeSchema = z.enum(['context', 'denied', 'asked', 'allowed', 'rewritten', 'blocked', 'continued', 'stopped', 'error'])
export type HookRecordOutcome = z.infer<typeof hookRecordOutcomeSchema>

/** Code of a hook configuration diagnostic (`HOOK_DIAGNOSTIC_CODES`, type `HookDiagnosticCode`). */
export const hookDiagnosticCodeSchema = z.enum(HOOK_DIAGNOSTIC_CODES)

/**
 * Kind of an executable item of a project folder (ADR-049; `TRUST_ITEM_KINDS`, type `TrustItemKind`): a hook of its
 * settings files, a server of its `.mcp.json`, or a command file with `` !`cmd` `` spans.
 */
export const trustItemKindSchema = z.enum(TRUST_ITEM_KINDS)

/** Whether the current sha256 of a project item is in the project's approved set (ADR-049). */
export const trustStateSchema = z.enum(['approved', 'pending'])
export type TrustState = z.infer<typeof trustStateSchema>

/**
 * A review warning of a project item (ADR-049, ADR-050): `private-network` (an http / sse server on a loopback or private
 * address), `referenced-file-missing` (a script file the command names is missing, unreadable or larger than 1 MiB) or
 * `runs-repository-code` (the command runs code of the repository, e.g. `npm test`, whose files are not pinned).
 */
export const trustWarningSchema = z.enum(['private-network', 'referenced-file-missing', 'runs-repository-code'])
export type TrustWarning = z.infer<typeof trustWarningSchema>

/** Transport of a project `.mcp.json` server (`MCP_JSON_TRANSPORTS`, type `McpJsonTransport`; ADR-050). */
export const projectMcpTransportSchema = z.enum(MCP_JSON_TRANSPORTS)

/**
 * State of a project MCP server (ADR-050): `pending` (not approved), `needs-variables` (approved, a `${VAR}` without a
 * value or a default), `idle` (approved and ready, not started: servers start lazily for the first run of a project
 * chat, and stop after 10 idle minutes), `connecting`, `connected`, `error` (`error` says why) or `disabled`
 * (`HF_SAFE_MODE`, or the project folder is unavailable).
 */
export const projectMcpStateSchema = z.enum(['pending', 'needs-variables', 'idle', 'connecting', 'connected', 'error', 'disabled'])
export type ProjectMcpState = z.infer<typeof projectMcpStateSchema>

/**
 * What a slash name invokes (Phase 11, ADR-052; `CommandSummary.kind`, `metadata.command.kind`): a command, or a
 * user-invocable skill (`/name [arguments]`; a command wins a name over a skill).
 */
export const invocationKindSchema = z.enum(['command', 'skill'])
export type InvocationKind = z.infer<typeof invocationKindSchema>

// ---------- global settings enums ----------

export const sendKeySchema = z.enum(['enter', 'mod-enter'])
export type SendKey = z.infer<typeof sendKeySchema>

export const densitySchema = z.enum(['comfortable', 'compact'])
export type Density = z.infer<typeof densitySchema>

export const readingFontSchema = z.enum(['sans', 'serif'])
export type ReadingFont = z.infer<typeof readingFontSchema>

export const textSizeSchema = z.enum(['sm', 'md', 'lg'])
export type TextSize = z.infer<typeof textSizeSchema>
