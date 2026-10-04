// Enumerations of the contract (DECISIONS.md "Enumerations", API.md section 4.1, PLUGINS.md section 9).
// Error codes and actions live in `errors.ts`.
import { z } from 'zod'
import {
  CUSTOMIZATION_KINDS,
  CUSTOMIZATION_SOURCES,
  DEFINITION_DIAGNOSTIC_CODES,
  DEFINITION_DIAGNOSTIC_LEVELS,
} from './util/definitions.ts'

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

export const pluginSourceSchema = z.enum(['builtin', 'created', 'zip', 'npm', 'url', 'link', 'copy'])
export type PluginSource = z.infer<typeof pluginSourceSchema>

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

/** What wrote the files of a `workspace.changed` event (ADR-036): an agent tool, or a user rewind, revert or undo. */
export const workspaceChangedSourceSchema = z.enum(['tool', 'rewind', 'revert', 'undo'])
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
 * message (`queue`), or, since Phase 10 (ADR-046), the server with the results of finished background tasks (`task`).
 * Also the origin of the run that launched a background task (`BackgroundTask.origin`).
 */
export const runOriginSchema = z.enum(['request', 'queue', 'task'])
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

// ---------- global settings enums ----------

export const sendKeySchema = z.enum(['enter', 'mod-enter'])
export type SendKey = z.infer<typeof sendKeySchema>

export const densitySchema = z.enum(['comfortable', 'compact'])
export type Density = z.infer<typeof densitySchema>

export const readingFontSchema = z.enum(['sans', 'serif'])
export type ReadingFont = z.infer<typeof readingFontSchema>

export const textSizeSchema = z.enum(['sm', 'md', 'lg'])
export type TextSize = z.infer<typeof textSizeSchema>
