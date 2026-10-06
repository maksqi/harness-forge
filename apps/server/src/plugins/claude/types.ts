// Frozen types of the Claude Code plugin format (Phase 12, ADR-053; ARCHITECTURE.md 6.33, PLUGINS.md "Claude Code
// plugins"): what the reader (`readClaudePluginDirectory`, `plugins/claude/reader.ts`, W12.1) gives the host, the
// installer and the registration (`registerClaudeContributions(ctx, read, runtime)`), the component and executable
// shapes, the reader options and the skill-file helper's result. C43 lands these types and the two stubs
// `detectPluginLayout` (`detect.ts`) and `listPluginSkillFiles` / `readPluginSkillFile` (`skill-files.ts`) with their
// final signatures; W12.1 implements the module set (`reader`, `layout`, `files`, `tree-hash`, `variables`,
// `user-config`, `mcp`, `hooks`, `register`, `info` and the two stubs).
//
// A Claude Code plugin is stored byte for byte under `<dataDir>/plugins/<id>/` (owner exec bits kept) and read in place;
// its `plugin.json` and `marketplace.json` are parsed only by the shared `util/claude-plugins.ts`, its definition files
// only by the shared `parseDefinition`, its hooks by `readSettingsHooks` / `readHooksConfig` (prompts on), its MCP
// servers by `parseMcpJson`. Files are read through the definition reader with the plugin root (no links, regular files,
// caps before parsing). Every entry has a qualified name `<pluginId>:<seg>…:<name>` (`catalogNameSchema`). Variables
// (`${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_SKILL_DIR}`,
// `${user_config.KEY}`) are substituted only by `substitutePluginVariables`, never from `process.env`. A plugin that runs
// anything (a command hook handler, a stdio MCP server, a `` !`cmd` `` span) needs a trust pin over its whole-tree hash
// (`hf-claude-plugin/v1`). `.lsp.json`, `bin/`, `themes/`, `monitors/`, `workflows/` and the plugin's own `settings.json`
// are never executed (info diagnostics). Plugin contents, `userConfig` values and commands are never logged at `info`.
import type { AgentDefinition, CommandDefinition, HooksConfig, OutputStyleDefinition, SkillDefinition } from '@harness-forge/plugin-sdk'
import type {
  ClaudeDiagnostic,
  ClaudePluginExecutable,
  ClaudePluginInfo,
  ClaudePluginManifest,
  ClaudeUserConfigOption,
  HookDiagnostic,
  HookSpec,
  McpServerDecl,
  PluginFormat,
  PromptHookSpec,
  SettingsSchema,
} from '@harness-forge/shared'
import type { PluginDirectoryRead } from '../loader.ts'
import type { ClaudeEntryOverlay } from '../types.ts'

// ---------- detection ----------

/**
 * The layout of a plugin found in a list of paths (`detectPluginLayout`, `detect.ts`): the format and the prefix of
 * the plugin root inside the list (`''` = the root of the list, `<top>/` = one top-level folder that holds everything,
 * as in a zipped folder, npm's `package/` or a GitHub zip's `<repo>-<sha>/`).
 */
export interface PluginLayout {
  readonly format: PluginFormat
  /** `''` or `<top>/` (with the trailing slash). */
  readonly prefix: string
}

// ---------- reader options ----------

/** Options of `readClaudePluginDirectory(dir, options)` (W12.1) and of `PluginHost.inspectDirectory` for `claude`. */
export interface ClaudePluginReadOptions {
  /** The plugin id the folder must read as (an installed plugin: its directory name); omitted for staging folders. */
  readonly expectedId?: string
  /** The marketplace entry overlay applied with `mergeEntryOverlay` (and hashed into the tree hash). */
  readonly overlay?: ClaudeEntryOverlay
  /** The name the id is derived from when neither `plugin.json` nor the overlay has one (folder, repository, package). */
  readonly nameHint?: string
  /** The raw version when neither `plugin.json` nor the overlay has one (the 12-character commit or archive sha). */
  readonly versionHint?: string
  /** Hex digest of a UTF-8 text for `claudePluginId` (default: sha256 of `node:crypto`). */
  readonly digest?: (text: string) => string
  /** Aborts the read (inspect requests, shutdown). */
  readonly signal?: AbortSignal
}

// ---------- components ----------

/**
 * A command of the plugin (`commands/**\/*.md`, `plugin.json` `commands` paths or the inline object form): registered as
 * a `CommandDefinition` with `syntax: 'markdown'` (the body is a command file: `$ARGUMENTS`, `$N`, named arguments,
 * `!` spans, `@path`, `model`, `allowedTools` that only narrow).
 */
export interface ClaudeCommandComponent {
  /** Qualified name `<pluginId>:<seg>…:<name>` (command subfolders add segments; stems slugified). */
  readonly name: string
  /** Plugin-relative file (`commands/db/migrate.md`); null for an inline `content` command of `plugin.json`. */
  readonly path: string | null
  /** What is registered (`name` above, `syntax: 'markdown'`, `template` = the body with the markdown variables). */
  readonly definition: CommandDefinition
  /** The `` !`cmd` `` spans of the body as written (`planCommandExpansion`): each one is an executable. */
  readonly shellCommands: readonly string[]
}

/** An agent of the plugin (`agents/*.md`, `plugin.json` `agents`): a sub-agent type with a qualified name. */
export interface ClaudeAgentComponent {
  /** Qualified name `<pluginId>:<name>` (the value of `task.type`). */
  readonly name: string
  readonly path: string
  /** What is registered (`model` resolved later: a Claude alias goes through `resolveClaudeModel`). */
  readonly definition: AgentDefinition
  /** The Claude model alias of the file (`sonnet`, `opus`, `haiku`, `fable`, a full `claude-*` id); absent = none. */
  readonly modelAlias?: string
}

/** A skill of the plugin (`skills/<name>/SKILL.md`, a root `SKILL.md`, `plugin.json` `skills`). */
export interface ClaudeSkillComponent {
  /** Qualified name `<pluginId>:<folder>` (frontmatter `name` replaces only the last segment). */
  readonly name: string
  /** Plugin-relative `SKILL.md`. */
  readonly path: string
  /** Plugin-relative skill folder (`skills/pdf`, `.` for a root `SKILL.md`): `SkillDefinition.baseDir`. */
  readonly baseDir: string
  readonly definition: SkillDefinition
}

/** An output style of the plugin (`output-styles/*.md`, `plugin.json` `outputStyles`). */
export interface ClaudeStyleComponent {
  /** Qualified name `<pluginId>:<name>`. */
  readonly name: string
  readonly path: string
  readonly definition: OutputStyleDefinition
}

/**
 * The hooks of the plugin: `hooks/hooks.json` (the `{ "hooks": … }` wrapper), the inline `plugin.json` `hooks` and its
 * path / array forms, merged per event and read with `readHooksConfig(…, { source: 'plugin', prompts: true })`; trimmed
 * to `LIMITS.pluginHooksMax` handlers with a diagnostic. Registered with `HookCommandsRegistration { root, hooks: config,
 * env, prompts }`.
 */
export interface ClaudeHooksComponent {
  /** The merged hooks object (Claude Code format, at most `LIMITS.pluginHooksMax` handlers): `registration.hooks`. */
  readonly config: HooksConfig
  /** The valid command handlers (`args` already substituted for the exec form). */
  readonly commands: readonly HookSpec[]
  /** The valid prompt handlers. */
  readonly prompts: readonly PromptHookSpec[]
  /** Unknown events, unsupported handler types (`http`, `mcp_tool`, `agent`), `${user_config.*}` in shell form, … */
  readonly diagnostics: readonly HookDiagnostic[]
}

/** An MCP server of the plugin (`.mcp.json`, wrapper or flat map, and `plugin.json` `mcpServers`). */
export interface ClaudeMcpServerComponent {
  /** The name as written. */
  readonly name: string
  /** The harness id: `<pluginId>` (one server), `<pluginId>-<slug>`, `<pluginId>-<4 hex>` (at most 32 characters). */
  readonly id: string
  /** `plugin_<plugin name>_<server name>`: `McpServerRegistry.register(…, { claudeName })`. */
  readonly claudeName: string
  /** The declaration (`{{settings.*}}` placeholders for `userConfig` and other `${VAR}`; `cwd` = the plugin folder). */
  readonly decl: McpServerDecl
}

// ---------- the read ----------

/** What the reader found in a Claude Code plugin folder (after the `plugin.json` path rules and the entry overlay). */
export interface ClaudePluginRead {
  /** The effective manifest (`plugin.json` with the overlay applied); null when the plugin has neither. */
  readonly manifest: ClaudePluginManifest | null
  /** The name the id was derived from (`plugin.json` → overlay → `nameHint`). */
  readonly name: string
  /** `claudePluginId(name)`. */
  readonly id: string
  /** The raw version (`plugin.json` → overlay → `versionHint` → `0.0.0`). */
  readonly version: string
  readonly commands: readonly ClaudeCommandComponent[]
  readonly agents: readonly ClaudeAgentComponent[]
  readonly skills: readonly ClaudeSkillComponent[]
  readonly styles: readonly ClaudeStyleComponent[]
  readonly hooks: ClaudeHooksComponent
  readonly mcpServers: readonly ClaudeMcpServerComponent[]
  /** The `userConfig` options as parsed. */
  readonly userConfig: readonly ClaudeUserConfigOption[]
  /** The plugin settings schema of `userConfig` (`userConfigToSettings`); null without options. */
  readonly settings: SettingsSchema | null
  /** Every command hook handler (with its arguments), stdio MCP server and `!` span: exactly what trust approves. */
  readonly executables: readonly ClaudePluginExecutable[]
  /** `executables` is not empty (a command hook of any event, a stdio server, a span): the plugin needs a trust pin. */
  readonly requiresTrust: boolean
  /** The whole-tree trust hash (`hf-claude-plugin/v1`, overlay included). */
  readonly treeHash: string
  /** The inspection / detail block (`claudePluginInfoSchema`). */
  readonly info: ClaudePluginInfo
  /** Every problem found (also in `info.diagnostics`, at most `LIMITS.claudePluginDiagnosticsMax`). */
  readonly diagnostics: readonly ClaudeDiagnostic[]
}

/**
 * The result of `readClaudePluginDirectory`: the host's view of the folder (`PluginDirectoryRead`: the synthesized
 * manifest, `hash` = the tree hash, `requiresTrust`, the first problem) and the Claude Code part. Never throws: an
 * unusable `plugin.json`, a path outside the folder, a link or a special file is the `error` problem of `directory`, and
 * `claude` is null when nothing could be read.
 */
export interface ClaudePluginDirectoryRead {
  readonly directory: PluginDirectoryRead
  readonly claude: ClaudePluginRead | null
}

// ---------- skill files ----------

/** One supporting file of a plugin skill, read by the `skill` tool's `file` input (`readPluginSkillFile`). */
export interface PluginSkillFile {
  /** Relative to the skill folder (POSIX). */
  readonly path: string
  /** UTF-8 text, at most `LIMITS.skillFileReadBytes` bytes. */
  readonly content: string
  /** The file was longer and `content` was cut. */
  readonly truncated: boolean
}
