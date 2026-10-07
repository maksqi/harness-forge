// Server-side slash commands (PLUGINS.md 6 and 9 "Commands", ARCHITECTURE.md 6.1). A command runs when the first text
// part of a user message starts with `/name` followed by whitespace or the end of the text and `name` is registered.
// The transcript keeps the original text; `metadata.command` records the invocation:
// - `template` commands: every `{{input}}` is replaced with the input (appended after a blank line when the template
//   has no placeholder and the input is not empty); the expansion is sent to the model instead of the text;
// - `run` commands (guarded, 30 s, phase `tool`): `{ type: 'prompt', text }` behaves like a template expansion,
//   `{ type: 'reply', markdown }` is written as the assistant message without a model call; a throw or timeout is
//   shown as a `plugin_error` in the chat.
// Phase 9 (ADR-040): the harness command `/compact [focus]` (`HARNESS_COMMANDS`) is checked before the registry (a
// plugin cannot register the name) and resolves to `compact`: `launchRun` answers it with a compaction instead of a
// model call (`compaction/stream.ts`). `GET /commands` lists it with `HARNESS_COMMAND_SUMMARIES`.
// Phase 10 (ADR-045, ARCHITECTURE.md 6.24): command files and personal commands. `resolveCommand(…, { catalog })` looks
// a name up in this order: client commands (never the server's) → the harness command → the run catalog's active
// command (a project `.harness` file over a `.claude` file over a personal command over a plugin command: the catalog's
// precedence) → the plugin registry. A project or personal command is loaded again (`customizations.load`: the file read
// and validated through the discovery guards) and expanded with the shared `expandArguments` (`$ARGUMENTS`, `$1` …
// `$9`, `{{input}}`; ≤ 64 KB); its invocation carries `source` and, when the definition declares them, `modelRef` (the
// turn runs on it, `prepare.ts`) and `allowedTools` (the turn's tools narrow to them, `turnToolRestriction`). In Phase
// 10 a body was text (`!` lines never run, `@file` never expanded; Phase 11 below). A plugin command (also when the
// catalog lists it) keeps the v1.5 path through the registry. `isServerCommandFor(deps, projectId, text)` tells the
// queue which queued texts are server commands of the chat's project (`turnOnly`). Bodies and expansions are never
// logged.
// Phase 11 (ADR-052, ARCHITECTURE.md 6.32; C37 seams, W11.5): `CommandContext.expansion` (`CommandExpansionHost`, built
// by `prepare.ts`) carries what `` !`cmd` `` spans and `@path` references need: the chat's project folder (opened lazily,
// once per turn), the shell switch and the trust check of a project command file's hash. With a host, the body of a
// command file, a personal command or a plugin template is scanned with the shared `planCommandExpansion` BEFORE the
// arguments are expanded (an argument is never inside a span) and expanded by `chat/inline/` (spans of trusted sources
// only: personal commands, loaded plugins, approved project files, else 409 `untrusted`; a project chat, else 400; the
// shell on, else 409 `disabled`; `@path` files in project chats only); a 64 KB floor is checked before anything runs.
// The result is frozen in the invocation (`expansion`, `kind: 'command'`, `inlined { shell, files }`), so a regenerate
// or a continuation (no host) never runs a span again; without a host, and for bodies without spans and (in project
// chats) references, the Phase 10 expansion is unchanged. User-invocable skills (`user-invocable` not false) resolve
// last: client → harness → definition command → plugin command → skill (a command wins a name); a skill expands its
// content with `expandArguments` (text only, no spans) into a prompt invocation with `kind: 'skill'`. Names may have 64
// characters (`SLASH_NAME_PATTERN`; commands stay at 32). `listServerCommands` / `isServerCommandFor` include the
// skills. Span commands, outputs and file contents are never logged.
// W11.17: with `CommandContext.deferExpansion` (`prepare.ts`, a new message), a body with something to inline is checked
// (the 64 KB floor, the project, the shell switch, the folder, the trust hash) but its spans and `@path` reads wait: the
// prompt resolution carries `finish()` and a placeholder expansion (every span empty, no file block) that is never
// stored; `prepare.ts` runs the prompt hooks first and calls `finish()` only once they passed.
// Phase 12 (ADR-053 / ADR-058; W12.7 behind the C44 call sites):
// - names: `/name` may be a qualified catalog name (`/review-kit:review`, `/review-kit:db:migrate`, ≤ 128 characters,
//   `CATALOG_NAME_PATTERN`); `resolveSlashName` picks the name a slash text stands for BEFORE the Phase 11 order runs: the
//   exact name of a command file / personal command, a registered command or a user-invocable skill, else the one
//   qualified name of a unique bare alias across those (`/review` while only `review-kit:review` ends in `:review` and
//   nothing has the name `review`), else a harness plugin's `<pluginId>:<name>` (its bare command or skill). The
//   resolution order stays client → harness → definition command → plugin command → skill; the invocation records the
//   resolved name. `listServerCommands` lists qualified names as they are and `isServerCommandFor` accepts the aliases;
// - arguments: every definition body expands with `argumentOptions` (`{ names, base: argumentBase(body, names), vars }`;
//   `vars`: `CLAUDE_SESSION_ID`, `CLAUDE_PROJECT_DIR` when a project folder is open, `CLAUDE_SKILL_DIR` of a project skill
//   (its project-relative folder) or a plugin skill (its absolute folder), the plugin variables of a plugin command);
//   the Phase 10 templates keep their meaning (`argumentBase` is 1 unless the body uses `$0` / `$ARGUMENTS[` or declares
//   `arguments`);
// - markdown plugin commands (`CommandDefinition.syntax: 'markdown'`, Claude Code plugins) take the command-file path:
//   `argumentOptions` with the plugin variables, `!` spans as a trusted plugin source whose environment adds
//   `CLAUDE_PLUGIN_ROOT` / `HARNESS_PLUGIN_ROOT` and `CLAUDE_PLUGIN_DATA`, `@path`, `model` and `allowedTools` that only
//   narrow (plugin `allowed-tools` never pre-approve);
// - models: a definition's Claude model name (`modelAlias`, or a plugin command's `model: sonnet`) resolves through
//   `resolveClaudeModel` (`modelAliases`); one that does not resolve runs the chat's model and the resolution carries
//   `modelUnavailable` (the `command-model-unavailable` notice of `prepare.ts`); skills now apply their `model` and
//   `allowed-tools` on `/name` like a command;
// - restrict-only: `disallowed-tools` of the turn's command or skill (its catalog entry, `turnToolRestrictionFor`)
//   remove tools from the turn; `allowed-tools` narrow it; `exit_plan_mode` stays in plan mode (`restrictTools`);
// - fork definitions (`context: fork`): a user `/name` expands with a delegation directive (`forkDirective`) that asks
//   the main agent to call `task` with the definition's `agent` type (default `general`); `task` is kept in the turn.
import type { CommandDefinition, CommandRunResult } from '@harness-forge/plugin-sdk'
import type {
  CommandInvocation,
  CommandSource,
  CommandSummary,
  CustomizationEntry,
  CustomizationSource,
  ExpandArgumentsOptions,
  HarnessUIMessage,
  ModelAliases,
} from '@harness-forge/shared'
import type { DataPaths } from '../env.ts'
import type { Logger } from '../logger.ts'
import type { PluginHost } from '../plugins/types.ts'
import type { ProviderService } from '../providers/types.ts'
import type { RegisteredCommand, Registry } from '../registry/types.ts'
import type { CustomizationCatalog, CustomizationService, LoadedDefinition } from '../services/customizations/types.ts'
import type { OpenWorkspace } from '../services/projects/types.ts'
import type { AppDeps } from '../types.ts'
import type { CommandBodyExpansion, CommandBodySource, CommandPlanRunner } from './inline/index.ts'
import { Buffer } from 'node:buffer'
import { join, posix } from 'node:path'
import {
  argumentBase,
  CATALOG_NAME_PATTERN,
  claudeModelAlias,
  COMMAND_NAME_PATTERN,
  DEFINITION_LIMITS,
  expandArguments,
  HarnessError,
  isClientCommand,
  isHarnessCommand,
  isHarnessError,
  LIMITS,
  matchToolAllowlist,
  MCP_TOOL_PREFIX,
  modelRefSchema,
  planCommandExpansion,
  skillInvocation,
} from '@harness-forge/shared'
import { GUARD_TIMEOUTS } from '../plugins/guard.ts'
import { bareAliasNames, isQualifiedName } from '../services/customizations/qualified.ts'
import { expandCommandPlan, minimalExpansion, needsInlining, prepareCommandPlan } from './inline/index.ts'
import { resolveClaudeModel } from './model-aliases.ts'

export interface ParsedCommand {
  name: string
  /** The text after `/name`, trimmed. */
  input: string
}

/**
 * `/name` (Phase 11: up to 64 characters for user-invocable skills; Phase 12: a qualified catalog name of up to 128
 * characters, `/<pluginId>:<seg>…:<name>`), followed by whitespace or the end; `CATALOG_NAME_PATTERN` decides.
 */
const COMMAND_PREFIX = /^\/([\da-z][\d:a-z-]{0,127})(?=\s|$)/

/** `/name input` at the start of `text` (leading whitespace ignored), else null. */
export function parseSlashCommand(text: string): ParsedCommand | null {
  const trimmed = text.trimStart()
  const match = trimmed.match(COMMAND_PREFIX)
  const name = match?.[1]
  if (match === null || name === undefined || !CATALOG_NAME_PATTERN.test(name))
    return null
  return { name, input: trimmed.slice(match[0].length).trim() }
}

/** Replaces every `{{input}}`; without a placeholder a non-empty input is appended after a blank line. */
export function expandTemplate(template: string, input: string): string {
  if (template.includes('{{input}}'))
    return template.split('{{input}}').join(input)
  return input === '' ? template : `${template}\n\n${input}`
}

/** A command whose expansion is sent to the model instead of the typed text. */
export interface PromptCommandResolution {
  kind: 'prompt'
  invocation: CommandInvocation & { type: 'prompt', expansion: string }
  /**
   * W11.17 (`CommandContext.deferExpansion`): the body's `!` spans and `@path` files are checked but have not run;
   * `invocation.expansion` is a placeholder (every span empty, no file block, never stored) until `finish()` runs them
   * and answers the final resolution (rejects with the errors of the spans, the 64 KB cap and the abort of the run).
   */
  finish?: () => Promise<PromptCommandResolution>
  /**
   * Phase 12 (ADR-058): the Claude model name of the definition (`sonnet`, `claude-…`) that did not resolve
   * (`resolveClaudeModel`): the chat's model answers and `prepare.ts` adds the `command-model-unavailable` notice.
   */
  modelUnavailable?: string
}

export type CommandResolution
  = | PromptCommandResolution
    | { kind: 'reply', invocation: CommandInvocation & { type: 'reply' }, markdown: string }
    | { kind: 'failed', invocation: CommandInvocation & { type: 'reply' }, error: HarnessError }
    /** `/compact [focus]` (Phase 9): `focus` is the input, trimmed (null when empty). */
    | { kind: 'compact', invocation: CommandInvocation & { name: 'compact', type: 'compact' }, focus: string | null }

/** The harness commands as `GET /commands` lists them (Phase 9; `pluginId` names the plugin of the agent tools). */
export const HARNESS_COMMAND_SUMMARIES: readonly CommandSummary[] = Object.freeze([
  Object.freeze({ name: 'compact', kind: 'command', description: 'Summarize the conversation to free up context', source: 'harness', pluginId: 'core-agent' }),
])

export interface CommandServices {
  /** Phase 12 (optional): `skills` gives a plugin skill's folder (`SkillDefinition.baseDir`, `${CLAUDE_SKILL_DIR}`). */
  registry: Pick<Registry, 'commands'> & Partial<Pick<Registry, 'skills'>>
  /** Phase 12: `directory` (optional) is the root of a markdown plugin command or a plugin skill (`${CLAUDE_…}`). */
  plugins: Pick<PluginHost, 'guard'> & Partial<Pick<PluginHost, 'directory'>>
  /** Phase 10: the bodies of command files and personal commands (`load(entry, signal)`). */
  customizations: Pick<CustomizationService, 'load'>
  /** Phase 12 (optional): the plugin data folders (`${CLAUDE_PLUGIN_DATA}` = `<pluginData>/<id>`). */
  env?: { readonly paths: Pick<DataPaths, 'pluginData'> }
  /** Phase 12 (optional): resolves a full Claude model id (`resolveClaudeModel`); absent = Claude names never resolve. */
  providers?: Pick<ProviderService, 'resolveModel'>
}

/**
 * What `!` spans and `@path` references of a command file need (Phase 11, ADR-052; `CommandContext.expansion`, built by
 * `prepare.ts` with `commandExpansionHost`).
 */
export interface CommandExpansionHost {
  /** The chat's project folder, opened once on first use; null without a project or when the folder is not available. */
  readonly workspace: () => Promise<OpenWorkspace | null>
  /** `HF_WORKSPACE_SHELL` (`env.workspaceShell`): spans may run (else 409 `disabled`). */
  readonly shellEnabled: boolean
  /** The trust hash `sha256` of a project command file is approved for `projectId` (`ProjectTrustService.approved`). */
  readonly trusted: (projectId: string, sha256: string) => Promise<boolean>
  /** The chat's project, or null (spans need one: else 400; `@path` references then stay text). */
  readonly projectId: string | null
}

/** The call-specific values of `resolveCommand`. */
export interface CommandContext {
  chatId: string
  /** The run signal (a guarded `run`, a body load). */
  signal: AbortSignal
  /**
   * The run's catalog snapshot (Phase 10, `PreparedRun.catalog`): the command files of the chat's project and the
   * personal commands, by precedence. Absent = the harness command and the plugin registry only.
   */
  catalog?: CustomizationCatalog
  /**
   * Phase 11 (ADR-052): what `!` spans and `@path` references of a command file need (`prepare.ts`); absent = they are
   * text (a regenerate re-resolves only reply commands).
   */
  expansion?: CommandExpansionHost
  /** Phase 11: the request's logger (counts and durations of spans only, never commands, outputs or contents). */
  logger?: Logger
  /**
   * W11.17: check a body's spans and references but run them only when the resolution's `finish()` is called (the
   * prompt hooks run in between, `prepare.ts`); default false (they run while resolving).
   */
  deferExpansion?: boolean
  /**
   * Phase 12 (ADR-058): the `${NAME}` variables of definition bodies the caller knows (`prepare.ts`:
   * `CLAUDE_SESSION_ID` = the chat id), for `argumentOptions`. Absent = none. `CLAUDE_PROJECT_DIR` is added from the
   * expansion host's folder when a body names it.
   */
  argumentVars?: Readonly<Record<string, string>>
  /** Phase 12 (ADR-058): the setting `modelAliases` (Claude model names of definitions); absent = none configured. */
  modelAliases?: Readonly<ModelAliases> | null
}

/** What the `expandArguments` options of one definition body are built from (Phase 12, ADR-058). */
export interface ArgumentOptionsInput {
  /** The body that is expanded (the argument base heuristic, `argumentBase`, reads it). */
  readonly body: string
  /** The definition's `arguments` names (`fields.arguments`); null or absent = none. */
  readonly names?: readonly string[] | null
  /**
   * The `${NAME}` variables of the call site (`CLAUDE_SESSION_ID`, `CLAUDE_PROJECT_DIR`, `CLAUDE_SKILL_DIR`, the plugin
   * variables); absent = none. Never read from `process.env`.
   */
  readonly vars?: Readonly<Record<string, string>>
}

/**
 * The `expandArguments` options of a definition body (Phase 12, ADR-058): `{ names, base: argumentBase(body, names),
 * vars }`. The base is 0 when the body uses `$0` or `$ARGUMENTS[` or the definition declares `arguments` (Claude Code's
 * counting), else 1 (Phase 10: `$1` is the first word), so every v1.6 / v1.7 template expands as before.
 */
export function argumentOptions(input: ArgumentOptionsInput): ExpandArgumentsOptions {
  const body = typeof input.body === 'string' ? input.body : ''
  const names = Array.isArray(input.names) ? input.names.filter((name): name is string => typeof name === 'string') : []
  const vars: Record<string, string> = {}
  for (const [key, value] of Object.entries(input.vars ?? {})) {
    if (typeof value === 'string')
      vars[key] = value
  }
  return { names, base: argumentBase(body, names), vars }
}

function tooLong(name: string): HarnessError {
  return new HarnessError({
    code: 'validation_error',
    message: `The expanded /${name} command is larger than ${LIMITS.commandExpansionBytes / 1024} KB. Shorten the input.`,
    details: { issues: [{ path: ['message', 'parts'], message: 'Command expansions are limited to 64 KB.', code: 'too_big' }] },
  })
}

/** `/compact [focus]`; a focus longer than `LIMITS.compactFocusMaxChars` is a `validation_error` on `['message']`. */
function compactResolution(input: string): CommandResolution {
  if (input.length > LIMITS.compactFocusMaxChars) {
    const message = `The focus of /compact is limited to ${LIMITS.compactFocusMaxChars} characters.`
    throw new HarnessError({ code: 'validation_error', message, details: { issues: [{ path: ['message'], message, code: 'too_big' }] } })
  }
  return { kind: 'compact', invocation: { name: 'compact', input, type: 'compact' }, focus: input === '' ? null : input }
}

/** `/compact` with an image model as the chat model (Phase 9): a `validation_error` on `['modelRef']`. */
export function compactNeedsChatModel(): HarnessError {
  const message = 'An image model cannot compact the conversation. Pick a chat model to run /compact.'
  return new HarnessError({ code: 'validation_error', message, details: { issues: [{ path: ['modelRef'], message, code: 'custom' }] } })
}

/**
 * The optional fields of a prompt invocation: a command file's `source`, `modelRef`, `allowedTools` (Phase 10), the
 * `kind` and what a body `inlined` (Phase 11).
 */
type InvocationExtras = Pick<CommandInvocation, 'source' | 'modelRef' | 'allowedTools' | 'kind' | 'inlined'>

/** What a resolution adds besides the invocation (Phase 12). */
interface ResolutionExtras {
  readonly modelUnavailable?: string
}

function promptResolution(name: string, input: string, expansion: string, extras: InvocationExtras = {}, more: ResolutionExtras = {}): PromptCommandResolution {
  if (Buffer.byteLength(expansion, 'utf8') > LIMITS.commandExpansionBytes)
    throw tooLong(name)
  return {
    kind: 'prompt',
    invocation: { name, input, type: 'prompt', expansion, ...extras },
    ...(more.modelUnavailable === undefined ? {} : { modelUnavailable: more.modelUnavailable }),
  }
}

function commandError(pluginId: string, message: string, cause?: unknown): HarnessError {
  return new HarnessError({ code: 'plugin_error', message, details: { pluginId, phase: 'tool' } }, cause === undefined ? {} : { cause })
}

function isRunResult(value: unknown): value is CommandRunResult {
  if (typeof value !== 'object' || value === null)
    return false
  const result = value as Record<string, unknown>
  return (result.type === 'prompt' && typeof result.text === 'string') || (result.type === 'reply' && typeof result.markdown === 'string')
}

/** A catalog entry that is a command file or a personal command (resolved here, not through the registry). */
function isDefinitionCommand(entry: CustomizationEntry | null | undefined): entry is CustomizationEntry & { source: 'project' | 'user' } {
  return entry?.kind === 'command' && entry.state === 'active' && (entry.source === 'project' || entry.source === 'user')
}

/**
 * The project or personal command of exactly `name` in the catalog (its active entry), else null (no catalog, a plugin
 * entry, no entry, an alias of another name, or a client or harness command name, which a definition can never take).
 */
export function definitionCommand(catalog: CustomizationCatalog | null | undefined, name: string): (CustomizationEntry & { source: 'project' | 'user' }) | null {
  if (catalog === null || catalog === undefined || isClientCommand(name) || isHarnessCommand(name))
    return null
  const entry = catalog.command(name)
  return isDefinitionCommand(entry) && entry.name === name ? entry : null
}

/** The `model` of a command definition when it is a model reference (the parser drops anything else). */
function commandModelRef(model: string | null | undefined): string | undefined {
  if (typeof model !== 'string')
    return undefined
  return modelRefSchema.safeParse(model).success ? model : undefined
}

/** The `allowed-tools` of a command definition as stored in the invocation (≤ 64 names of 1 – 256 characters). */
function commandAllowedTools(tools: readonly string[] | null | undefined): string[] | undefined {
  if (!Array.isArray(tools))
    return undefined
  return tools
    .filter((tool): tool is string => typeof tool === 'string' && tool.length > 0 && tool.length <= 256)
    .slice(0, DEFINITION_LIMITS.toolsMax)
}

/** A command definition that cannot be loaded any more (the file changed since the catalog listed it). */
function definitionUnavailable(name: string, error: unknown): HarnessError {
  const reason = isHarnessError(error) ? HarnessError.from(error).message : 'Its definition could not be read.'
  const message = `The /${name} command cannot be used right now. ${reason}`.slice(0, 1000)
  return new HarnessError(
    { code: 'validation_error', message, details: { issues: [{ path: ['message', 'parts'], message, code: 'custom' }] } },
    { cause: error },
  )
}

/** `kind: 'command'` and `inlined` of an expansion that inlined something; nothing otherwise (the v1.6 shape). */
function inlinedExtras(expansion: CommandBodyExpansion): InvocationExtras {
  return expansion.inlined === undefined ? {} : { kind: 'command', inlined: expansion.inlined }
}

/** The expansion of a command body: done, or (`deferExpansion`) checked and waiting for `run` behind a placeholder. */
type BodyExpansion
  = | { readonly done: CommandBodyExpansion }
    | { readonly placeholder: string, readonly run: CommandPlanRunner }

/** What a body expansion adds for the spans and the text parts (Phase 12). */
interface BodyExpansionOptions {
  /** The `expandArguments` options of the body (`argumentOptions`); absent = the Phase 10 expansion. */
  readonly arguments?: ExpandArgumentsOptions
  /** Extra variables of the spans' environment (a plugin's `CLAUDE_PLUGIN_ROOT` / `CLAUDE_PLUGIN_DATA`). */
  readonly spanEnv?: Readonly<Record<string, string>>
}

/**
 * The expansion of a command body (Phase 11, ADR-052). With an expansion host and something to inline (spans; `@path`
 * references in a project chat), the body is scanned before the arguments, refused above 64 KB before anything runs,
 * and expanded by `chat/inline/` (the checks, the spans, the files; W11.17: with `deferExpansion` only the checks, the
 * spans and files wait for `run`); otherwise `fallback()` (the Phase 10 expansion: `expandArguments` for definitions,
 * `expandTemplate` for plugin templates).
 */
async function bodyExpansion(
  name: string,
  body: string,
  input: string,
  source: CommandBodySource,
  context: CommandContext,
  fallback: () => string,
  options: BodyExpansionOptions = {},
): Promise<BodyExpansion> {
  const host = context.expansion
  if (host === undefined)
    return { done: { text: fallback() } }
  const plan = planCommandExpansion(body)
  if (!needsInlining(plan, host))
    return { done: { text: fallback() } }
  const placeholder = minimalExpansion(plan, input)
  if (Buffer.byteLength(placeholder, 'utf8') > LIMITS.commandExpansionBytes)
    throw tooLong(name)
  const request = {
    name,
    input,
    plan,
    source,
    host,
    signal: context.signal,
    ...(context.logger === undefined ? {} : { logger: context.logger }),
    ...(options.arguments === undefined ? {} : { arguments: options.arguments }),
    ...(options.spanEnv === undefined ? {} : { spanEnv: options.spanEnv }),
  }
  if (context.deferExpansion !== true)
    return { done: await expandCommandPlan(request) }
  return { placeholder, run: await prepareCommandPlan(request) }
}

/** The prompt resolution of a body expansion (`extras`: the definition's fields; `kind` / `inlined` follow the body). */
function bodyResolution(name: string, input: string, body: BodyExpansion, extras: InvocationExtras = {}, more: ResolutionExtras = {}): PromptCommandResolution {
  if ('done' in body)
    return promptResolution(name, input, body.done.text, { ...extras, ...inlinedExtras(body.done) }, more)
  const finish = async (): Promise<PromptCommandResolution> => {
    const done = await body.run()
    return promptResolution(name, input, done.text, { ...extras, ...inlinedExtras(done) }, more)
  }
  return { ...promptResolution(name, input, body.placeholder, extras, more), finish }
}

/** The entry or definition cannot be used: the abort of a stopped run is rethrown, anything else is `definitionUnavailable`. */
async function loadDefinition(services: CommandServices, entry: CustomizationEntry, name: string, signal: AbortSignal): Promise<LoadedDefinition> {
  try {
    return await services.customizations.load(entry, signal)
  }
  catch (error) {
    if (signal.aborted)
      throw error
    throw definitionUnavailable(name, error)
  }
}

// ---------- Phase 12: variables, models, forks ----------

/** The variables of a body: the caller's, plus `CLAUDE_PROJECT_DIR` (the open project folder) when the body names it. */
async function bodyVars(context: CommandContext, body: string, extra: Readonly<Record<string, string>> = {}): Promise<Record<string, string>> {
  const vars: Record<string, string> = { ...(context.argumentVars ?? {}), ...extra }
  const host = context.expansion
  if (vars.CLAUDE_PROJECT_DIR === undefined && host !== undefined && host.projectId !== null && body.includes('CLAUDE_PROJECT_DIR')) {
    const workspace = await host.workspace()
    context.signal.throwIfAborted()
    if (workspace !== null)
      vars.CLAUDE_PROJECT_DIR = workspace.root
  }
  return vars
}

/** The folder and data folder of a plugin (`${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`); null when not known. */
async function pluginFolders(services: CommandServices, pluginId: string): Promise<{ root: string, data: string | null } | null> {
  if (services.plugins.directory === undefined)
    return null
  let root: string | null
  try {
    root = await services.plugins.directory(pluginId)
  }
  catch {
    return null
  }
  if (root === null)
    return null
  const data = services.env === undefined ? null : join(services.env.paths.pluginData, pluginId)
  return { root, data }
}

/** The `${…}` variables of a plugin body (`CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`). */
function pluginVars(folders: { root: string, data: string | null } | null): Record<string, string> {
  if (folders === null)
    return {}
  return { CLAUDE_PLUGIN_ROOT: folders.root, ...(folders.data === null ? {} : { CLAUDE_PLUGIN_DATA: folders.data }) }
}

/** The extra environment of a plugin's `!` spans (the plugin folder and its data folder). */
function pluginSpanEnv(folders: { root: string, data: string | null } | null): Record<string, string> | undefined {
  if (folders === null)
    return undefined
  return { HARNESS_PLUGIN_ROOT: folders.root, ...pluginVars(folders) }
}

/** The model a definition's turn runs on (Phase 12): its model ref, a resolved Claude model name, or the name that did not resolve. */
interface DefinitionModel {
  readonly modelRef?: string
  readonly unavailable?: string
}

/**
 * The model of a definition: `model` when it is a model ref; else the Claude model name (`modelAlias`, or a plugin
 * command's `model: sonnet`) through `resolveClaudeModel` (`modelAliases`, then `anthropic:<id>`); a name that does not
 * resolve is `unavailable` (the chat's model answers with the notice). The abort of the run is rethrown.
 */
async function definitionModel(services: CommandServices, context: CommandContext, model: string | null | undefined, alias: string | null | undefined): Promise<DefinitionModel> {
  const modelRef = commandModelRef(model)
  if (modelRef !== undefined)
    return { modelRef }
  const name = typeof alias === 'string' && alias !== '' ? claudeModelAlias(alias) : typeof model === 'string' ? claudeModelAlias(model) : null
  if (name === null)
    return {}
  if (services.providers === undefined)
    return { unavailable: name }
  const resolved = await resolveClaudeModel(name, { modelAliases: context.modelAliases ?? null, providers: services.providers, signal: context.signal })
  return resolved === null ? { unavailable: name } : { modelRef: resolved }
}

/** The invocation fields of a definition model. */
function modelExtras(model: DefinitionModel): { invocation: InvocationExtras, more: ResolutionExtras } {
  return {
    invocation: model.modelRef === undefined ? {} : { modelRef: model.modelRef },
    more: model.unavailable === undefined || model.modelRef !== undefined ? {} : { modelUnavailable: model.unavailable },
  }
}

/** The tool a fork definition's directive asks the main agent to call (kept in the turn's tools). */
export const FORK_TOOL_NAME = 'task'
/** The sub-agent type of a fork without `agent`. */
export const FORK_DEFAULT_AGENT = 'general'

/**
 * The expansion of a user `/name` of a fork definition (`context: fork`, ADR-058): a directive that asks the main agent
 * to delegate the expanded body to a sub-agent of type `agent` through `task` (a user turn never starts a child by
 * itself), then the instructions.
 */
export function forkDirective(name: string, agent: string, instructions: string): string {
  return [
    `Run /${name} in a sub-agent: call the ${FORK_TOOL_NAME} tool once with type "${agent}", a short description and the instructions below as its prompt, complete and unchanged (the sub-agent does not see this conversation). When it reports back, answer with its result.`,
    '',
    '<instructions>',
    instructions.trim(),
    '</instructions>',
  ].join('\n')
}

/** The allowed tools of a fork's turn: the declared ones plus `task` (the delegation must stay possible). */
function forkAllowedTools(tools: string[] | undefined): string[] | undefined {
  if (tools === undefined || tools.includes(FORK_TOOL_NAME))
    return tools
  return [...tools, FORK_TOOL_NAME].slice(-DEFINITION_LIMITS.toolsMax)
}

/**
 * A project or personal command (Phase 10): the definition loaded again (`load`: the same guards as the discovery),
 * its body expanded with `expandArguments` (Phase 11: `bodyExpansion`, the spans and references of a trusted body;
 * Phase 12: `argumentOptions`, the model alias, a fork directive). A definition that cannot be loaded any more is a
 * `validation_error` on the message (nothing is stored); the abort of a stopped run is rethrown.
 */
async function definitionResolution(
  services: CommandServices,
  entry: CustomizationEntry & { source: 'project' | 'user' },
  parsed: ParsedCommand,
  context: CommandContext,
): Promise<CommandResolution> {
  const definition = (await loadDefinition(services, entry, parsed.name, context.signal)).definition
  if (definition.kind !== 'command')
    throw definitionUnavailable(parsed.name, new HarnessError({ code: 'validation_error', message: 'The definition is not a command.' }))
  const fields = definition.fields
  const source: CommandSource = entry.source
  const model = modelExtras(await definitionModel(services, context, fields.model, fields.modelAlias))
  const fork = fields.context === 'fork'
  const declared = commandAllowedTools(fields.allowedTools)
  const allowedTools = fork ? forkAllowedTools(declared) : declared
  const options = argumentOptions({ body: fields.body, names: fields.arguments ?? null, vars: await bodyVars(context, fields.body) })
  const expansion = await bodyExpansion(parsed.name, fields.body, parsed.input, entry.source, context, () => expandArguments(fields.body, parsed.input, options).text, { arguments: options })
  const extras: InvocationExtras = { source, ...model.invocation, ...(allowedTools === undefined ? {} : { allowedTools }) }
  if (!fork)
    return bodyResolution(parsed.name, parsed.input, expansion, extras, model.more)
  return forkResolution(parsed.name, parsed.input, expansion, fields.agent ?? FORK_DEFAULT_AGENT, extras, model.more)
}

/** The prompt resolution of a fork body: the directive around the expansion (after the spans ran, W11.17). */
function forkResolution(name: string, input: string, body: BodyExpansion, agent: string, extras: InvocationExtras, more: ResolutionExtras): PromptCommandResolution {
  const wrap = (expansion: CommandBodyExpansion): CommandBodyExpansion => ({ ...expansion, text: forkDirective(name, agent, expansion.text) })
  if ('done' in body)
    return bodyResolution(name, input, { done: wrap(body.done) }, extras, more)
  return bodyResolution(name, input, { placeholder: forkDirective(name, agent, body.placeholder), run: async () => wrap(await body.run()) }, extras, more)
}

/** The source of a skill invocation or listing (`CommandSource` has no `builtin`: a builtin is the harness's). */
function skillSource(source: CustomizationSource): CommandSource {
  return source === 'builtin' ? 'harness' : source
}

/**
 * The active user-invocable skill of exactly `name` in the catalog (Phase 11, ADR-052: `user-invocable` not false), else
 * null (no catalog, no such skill, an alias of another name, or a client or harness command name, which a skill never
 * takes).
 */
export function invocableSkill(catalog: CustomizationCatalog | null | undefined, name: string): CustomizationEntry | null {
  if (catalog === null || catalog === undefined || isClientCommand(name) || isHarnessCommand(name) || !CATALOG_NAME_PATTERN.test(name))
    return null
  const entry = catalog.skill(name)
  return entry !== null && entry.kind === 'skill' && entry.state === 'active' && entry.userInvocable !== false && entry.name === name ? entry : null
}

/** The `${CLAUDE_SKILL_DIR}` of a skill (Phase 12): a project skill's project-relative folder, a plugin skill's absolute folder. */
async function skillDirVar(services: CommandServices, entry: CustomizationEntry): Promise<Record<string, string>> {
  if (entry.source === 'project' && entry.path !== undefined) {
    const dir = posix.dirname(entry.path.replaceAll('\\', '/'))
    return dir === '.' || dir === '' ? {} : { CLAUDE_SKILL_DIR: dir }
  }
  if (entry.source !== 'plugin' || entry.pluginId === undefined)
    return {}
  const baseDir = pluginSkillBaseDir(services, entry)
  const folders = baseDir === null ? null : await pluginFolders(services, entry.pluginId)
  if (folders === null || baseDir === null)
    return {}
  return { ...pluginVars(folders), CLAUDE_SKILL_DIR: baseDir === '.' ? folders.root : join(folders.root, baseDir) }
}

/** The plugin-relative folder of a plugin skill (`SkillDefinition.baseDir`), or null (none, or not a plugin skill). */
function pluginSkillBaseDir(services: CommandServices, entry: CustomizationEntry): string | null {
  const registered = services.registry.skills?.get(entry.name)
  const baseDir = registered?.pluginId === entry.pluginId ? registered?.definition.baseDir : undefined
  if (typeof baseDir !== 'string' || baseDir === '' || baseDir.startsWith('/') || baseDir.split('/').includes('..'))
    return null
  return baseDir
}

/**
 * A user-invocable skill run as `/name [arguments]` (Phase 11, ADR-052): its content loaded again (`load`) and expanded
 * with `expandArguments` (text only, no spans, no references); a skill that is no longer user-invocable or cannot be
 * loaded is a `validation_error` on the message. Phase 12: `argumentOptions` (`CLAUDE_SKILL_DIR` of a project or plugin
 * skill), the skill's `model` (or Claude model name) and `allowed-tools` apply to the turn like a command's, and a fork
 * skill expands with the delegation directive.
 */
async function skillResolution(services: CommandServices, entry: CustomizationEntry, parsed: ParsedCommand, context: CommandContext): Promise<CommandResolution> {
  const definition = (await loadDefinition(services, entry, parsed.name, context.signal)).definition
  if (definition.kind !== 'skill')
    throw definitionUnavailable(parsed.name, new HarnessError({ code: 'validation_error', message: 'The definition is not a skill.' }))
  if (!skillInvocation(definition.fields).userInvocable)
    throw definitionUnavailable(parsed.name, new HarnessError({ code: 'validation_error', message: 'The skill can no longer be run as a command.' }))
  const fields = definition.fields
  const content = fields.content
  const vars = await bodyVars(context, content, await skillDirVar(services, entry))
  const options = argumentOptions({ body: content, names: fields.arguments ?? null, vars })
  const expanded = expandArguments(content, parsed.input, options).text
  const model = modelExtras(await definitionModel(services, context, fields.model, fields.modelAlias))
  const fork = fields.context === 'fork'
  const declared = commandAllowedTools(fields.allowedTools)
  const allowedTools = fork ? forkAllowedTools(declared) : declared
  const expansion = fork ? forkDirective(parsed.name, fields.agent ?? FORK_DEFAULT_AGENT, expanded) : expanded
  return promptResolution(parsed.name, parsed.input, expansion, {
    kind: 'skill',
    source: skillSource(entry.source),
    ...model.invocation,
    ...(allowedTools === undefined ? {} : { allowedTools }),
  }, model.more)
}

/** Fields a markdown plugin command may carry besides `CommandDefinition` (a Claude Code plugin's frontmatter, W12.1). */
interface MarkdownCommandExtras {
  readonly arguments?: unknown
  readonly modelAlias?: unknown
  readonly context?: unknown
  readonly agent?: unknown
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : null
}

/**
 * A markdown plugin command (Phase 12, ADR-053: `syntax: 'markdown'`, a Claude Code plugin's command file): the
 * command-file path with the plugin as a trusted source of spans (`CLAUDE_PLUGIN_ROOT` / `CLAUDE_PLUGIN_DATA` in the
 * spans' environment and the body's variables), `argumentOptions`, `@path`, the per-turn `model` and `allowedTools` that
 * only narrow. The invocation keeps the v1.5 shape of plugin commands (no `source`).
 */
async function markdownResolution(services: CommandServices, registered: RegisteredCommand, name: string, input: string, context: CommandContext): Promise<CommandResolution> {
  const definition = registered.definition
  const extras = definition as CommandDefinition & MarkdownCommandExtras
  const body = definition.template ?? ''
  const folders = await pluginFolders(services, registered.pluginId)
  const options = argumentOptions({ body, names: stringArray(extras.arguments), vars: await bodyVars(context, body, pluginVars(folders)) })
  const spanEnv = pluginSpanEnv(folders)
  const model = modelExtras(await definitionModel(services, context, definition.model, typeof extras.modelAlias === 'string' ? extras.modelAlias : null))
  const fork = extras.context === 'fork'
  const declared = commandAllowedTools(definition.allowedTools)
  const allowedTools = fork ? forkAllowedTools(declared) : declared
  const expansion = await bodyExpansion(name, body, input, 'plugin', context, () => expandArguments(body, input, options).text, {
    arguments: options,
    ...(spanEnv === undefined ? {} : { spanEnv }),
  })
  const invocation: InvocationExtras = { ...model.invocation, ...(allowedTools === undefined ? {} : { allowedTools }) }
  if (!fork)
    return bodyResolution(name, input, expansion, invocation, model.more)
  return forkResolution(name, input, expansion, typeof extras.agent === 'string' && extras.agent !== '' ? extras.agent : FORK_DEFAULT_AGENT, invocation, model.more)
}

// ---------- Phase 12: the slash name ----------

/** A name of the slash namespace: a command (catalog or registry) or a user-invocable skill. */
interface SlashName {
  readonly name: string
  readonly source?: string
  readonly pluginId?: string
}

/** Every name a `/name` may stand for in a scope (the slash namespace), for the alias rule. */
function slashNames(registry: Pick<Registry, 'commands'>, catalog: CustomizationCatalog | null | undefined): SlashName[] {
  const names: SlashName[] = []
  for (const entry of registry.commands.list())
    names.push({ name: entry.definition.name, source: 'plugin', pluginId: entry.pluginId })
  for (const entry of catalog?.commands() ?? [])
    names.push({ name: entry.name, source: entry.source, ...(entry.pluginId === undefined ? {} : { pluginId: entry.pluginId }) })
  for (const entry of catalog?.skills() ?? []) {
    if (entry.userInvocable !== false)
      names.push({ name: entry.name, source: entry.source, ...(entry.pluginId === undefined ? {} : { pluginId: entry.pluginId }) })
  }
  return names
}

/** True when a command or a user-invocable skill has exactly `name` in the scope. */
function hasExactSlashName(registry: Pick<Registry, 'commands'>, catalog: CustomizationCatalog | null | undefined, name: string): boolean {
  if (definitionCommand(catalog, name) !== null || registry.commands.get(name) !== undefined || invocableSkill(catalog, name) !== null)
    return true
  return catalog?.command(name)?.name === name
}

/** What a typed `/name` stands for (`slashTarget`). */
export interface SlashTarget {
  /** The name the command or skill is looked up by (a bare alias resolved to its qualified name). */
  readonly name: string
  /**
   * A harness plugin's entry called `<pluginId>:<name>`: only that plugin's registered command or plugin skill of `name`
   * answers (a personal or project definition of the bare name does not); null otherwise.
   */
  readonly pluginId: string | null
  /** The name the invocation records: the resolved name, or the typed `<pluginId>:<name>`. */
  readonly invocationName: string
}

/**
 * The name a typed `/name` stands for (Phase 12, ADR-053): the name itself when a command or a user-invocable skill has
 * it; else, for a bare name, the one qualified name that ends in `:<name>` across the commands and user-invocable skills
 * of the scope (none or several: the name itself, which then resolves to nothing); else, for `<pluginId>:<name>`, the
 * bare command or skill of that plugin.
 */
export function slashTarget(registry: Pick<Registry, 'commands'>, catalog: CustomizationCatalog | null | undefined, typed: string): SlashTarget {
  const plain: SlashTarget = { name: typed, pluginId: null, invocationName: typed }
  if (isClientCommand(typed) || isHarnessCommand(typed) || hasExactSlashName(registry, catalog, typed))
    return plain
  if (!typed.includes(':')) {
    const aliases = bareAliasNames(slashNames(registry, catalog), typed)
    return aliases.length === 1 ? { name: aliases[0]!, pluginId: null, invocationName: aliases[0]! } : plain
  }
  if (!isQualifiedName(typed))
    return plain
  const separator = typed.indexOf(':')
  const pluginId = typed.slice(0, separator)
  const bare = typed.slice(separator + 1)
  if (bare.includes(':'))
    return plain
  const command = registry.commands.get(bare)
  const skill = catalog?.skill(bare) ?? null
  const owned = command?.pluginId === pluginId
    || (skill !== null && skill.name === bare && skill.source === 'plugin' && skill.pluginId === pluginId && skill.userInvocable !== false)
  return owned ? { name: bare, pluginId, invocationName: typed } : plain
}

/** The name a typed `/name` is looked up by (`slashTarget(…).name`). */
export function resolveSlashName(registry: Pick<Registry, 'commands'>, catalog: CustomizationCatalog | null | undefined, typed: string): string {
  return slashTarget(registry, catalog, typed).name
}

/** The command or skill of a plugin-qualified call (`SlashTarget.pluginId`): only that plugin's entries answer. */
async function pluginQualifiedResolution(services: CommandServices, target: SlashTarget, parsed: ParsedCommand, context: CommandContext): Promise<CommandResolution | null> {
  const registered = services.registry.commands.get(target.name)
  if (registered !== undefined && registered.pluginId === target.pluginId)
    return registeredResolution(services, registered, parsed, context)
  const skill = invocableSkill(context.catalog, target.name)
  if (skill === null || skill.source !== 'plugin' || skill.pluginId !== target.pluginId)
    return null
  return skillResolution(services, skill, parsed, context)
}

/**
 * The command invoked by `text`, or null when the text is not a harness command, a command of the run catalog, a
 * registered server-side command or (Phase 11) a user-invocable skill of the run catalog. Throws `validation_error` when
 * a prompt expansion is larger than 64 KB, a `/compact` focus longer than 1000 characters or a command definition can no
 * longer be loaded, and (Phase 11, with `context.expansion`) the errors of `!` spans: `validation_error` without a
 * project (or its folder), `conflict` `disabled` with the shell off, `conflict` `untrusted` for a project command file
 * whose trust hash is not approved; the abort reason when the run was stopped; a failing `run` is returned as `failed`.
 * Phase 12: the name may be qualified or a bare alias (`resolveSlashName`); the invocation records the resolved name.
 */
export async function resolveCommand(
  services: CommandServices,
  text: string,
  context: CommandContext,
): Promise<CommandResolution | null> {
  const typed = parseSlashCommand(text)
  if (typed === null || isClientCommand(typed.name))
    return null
  if (isHarnessCommand(typed.name))
    return compactResolution(typed.input)
  const target = slashTarget(services.registry, context.catalog, typed.name)
  const parsed: ParsedCommand = { name: target.invocationName, input: typed.input }
  if (target.pluginId !== null)
    return pluginQualifiedResolution(services, target, parsed, context)
  const definitionEntry = definitionCommand(context.catalog, target.name)
  if (definitionEntry !== null)
    return definitionResolution(services, definitionEntry, parsed, context)
  const registered = services.registry.commands.get(target.name)
  if (registered === undefined) {
    // Phase 11: a user-invocable skill comes last (a command of any source wins the name).
    const skill = invocableSkill(context.catalog, target.name)
    return skill === null ? null : skillResolution(services, skill, parsed, context)
  }
  return registeredResolution(services, registered, parsed, context)
}

/** A command of the plugin registry: a template, a markdown body (Phase 12) or a guarded `run`. */
async function registeredResolution(services: CommandServices, registered: RegisteredCommand, parsed: ParsedCommand, context: CommandContext): Promise<CommandResolution | null> {
  const { name, input } = parsed
  const definition: CommandDefinition = registered.definition
  const template = definition.template
  if (template !== undefined && definition.syntax === 'markdown')
    return markdownResolution(services, registered, name, input, context)
  if (template !== undefined) {
    // A loaded plugin's template is a trusted source of spans (Phase 11); without spans or references: `expandTemplate`.
    const expansion = await bodyExpansion(name, template, input, 'plugin', context, () => expandTemplate(template, input))
    return bodyResolution(name, input, expansion)
  }
  const run = definition.run
  if (run === undefined)
    return null

  const failed = (error: HarnessError): CommandResolution => ({ kind: 'failed', invocation: { name, input, type: 'reply' }, error })
  let result: unknown
  try {
    result = await services.plugins.guard(
      registered.pluginId,
      signal => run.call(definition, { input, chatId: context.chatId, signal }),
      { timeoutMs: GUARD_TIMEOUTS.command, phase: 'tool', signal: context.signal, label: `/${name}` },
    )
  }
  catch (error) {
    if (context.signal.aborted)
      throw error
    return failed(isHarnessError(error) ? HarnessError.from(error) : commandError(registered.pluginId, `The /${name} command failed.`, error))
  }
  if (!isRunResult(result))
    return failed(commandError(registered.pluginId, `The /${name} command returned an invalid result.`))
  if (result.type === 'prompt')
    return promptResolution(name, input, result.text)
  return { kind: 'reply', invocation: { name, input, type: 'reply' }, markdown: result.markdown }
}

/**
 * A description as listings show it (Phase 12, ADR-058): the description, then ` - ` and `when_to_use` when the
 * definition has one.
 */
export function describedWithWhenToUse(description: string, whenToUse: string | undefined): string {
  const extra = typeof whenToUse === 'string' ? whenToUse.trim() : ''
  if (extra === '')
    return description
  return description.trim() === '' ? extra : `${description} - ${extra}`
}

/** The catalog's plugin entry of a registered command (its `when_to_use`, Phase 12), or null. */
function pluginCommandEntry(catalog: CustomizationCatalog | null, name: string, pluginId: string): CustomizationEntry | null {
  const entry = catalog?.command(name) ?? null
  return entry !== null && entry.name === name && entry.source === 'plugin' && entry.pluginId === pluginId ? entry : null
}

/**
 * The effective server-side commands of a scope (`GET /commands`), sorted by name: `/compact`, then one entry per name
 * of the catalog's project and personal commands and the plugin registry (a project or personal command wins its name
 * over a plugin command: the catalog's precedence). Plugin commands come from the live registry (a catalog that still
 * lists a disposed plugin's command does not bring it back); client and harness names are never taken. Every command
 * is `kind: 'command'`; the catalog's active user-invocable skills (Phase 11, ADR-052) follow as `kind: 'skill'` with
 * their `argumentHint` (and `pluginId` for a plugin skill) unless a command has the name. Phase 12: qualified names are
 * listed as they are (a bare alias is not an item of its own); plugin commands carry their `argumentHint` and model ref;
 * a definition's `when_to_use` is appended to its description.
 */
export function listServerCommands(registry: Pick<Registry, 'commands'>, catalog: CustomizationCatalog | null): CommandSummary[] {
  const byName = new Map<string, CommandSummary>()
  for (const entry of registry.commands.list()) {
    const name = entry.definition.name
    if (isClientCommand(name) || isHarnessCommand(name) || byName.has(name) || !CATALOG_NAME_PATTERN.test(name))
      continue
    const hint = entry.definition.argumentHint
    const argumentHint = typeof hint === 'string' && hint.length <= DEFINITION_LIMITS.argumentHintMaxChars ? hint : undefined
    const modelRef = commandModelRef(entry.definition.model)
    const listed = pluginCommandEntry(catalog, name, entry.pluginId)
    byName.set(name, {
      name,
      kind: 'command',
      description: describedWithWhenToUse(entry.definition.description, listed?.whenToUse),
      source: 'plugin',
      pluginId: entry.pluginId,
      ...(argumentHint === undefined ? {} : { argumentHint }),
      ...(modelRef === undefined ? {} : { modelRef }),
    })
  }
  for (const listed of catalog?.commands() ?? []) {
    // The name's active entry, when it is a command file or a personal command (plugin entries: the registry above).
    const entry = COMMAND_NAME_PATTERN.test(listed.name) ? definitionCommand(catalog, listed.name) : null
    if (entry === null)
      continue
    const modelRef = typeof entry.modelRef === 'string' ? commandModelRef(entry.modelRef) : undefined
    byName.set(entry.name, {
      name: entry.name,
      kind: 'command',
      description: describedWithWhenToUse(entry.description, entry.whenToUse),
      source: entry.source,
      ...(entry.namespace === undefined ? {} : { namespace: entry.namespace }),
      ...(entry.argumentHint === undefined ? {} : { argumentHint: entry.argumentHint }),
      ...(modelRef === undefined ? {} : { modelRef }),
    })
  }
  for (const listed of catalog?.skills() ?? []) {
    const entry = byName.has(listed.name) ? null : invocableSkill(catalog, listed.name)
    if (entry === null || entry.name !== listed.name)
      continue
    const modelRef = typeof entry.modelRef === 'string' ? commandModelRef(entry.modelRef) : undefined
    byName.set(entry.name, {
      name: entry.name,
      kind: 'skill',
      description: describedWithWhenToUse(entry.description, entry.whenToUse),
      source: skillSource(entry.source),
      ...(entry.source === 'plugin' && entry.pluginId !== undefined ? { pluginId: entry.pluginId } : {}),
      ...(entry.argumentHint === undefined ? {} : { argumentHint: entry.argumentHint }),
      ...(modelRef === undefined ? {} : { modelRef }),
    })
  }
  return [...HARNESS_COMMAND_SUMMARIES.map(summary => ({ ...summary })), ...byName.values()]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/**
 * True when `text` starts a server command in a chat of `projectId` (null = no project): the harness command
 * `/compact`, a command a plugin registered, (Phase 10) every active command file or personal command of the project's
 * catalog (`deps.customizations.catalog`, cached) and (Phase 11) every active user-invocable skill of that catalog
 * (Phase 12: also by a qualified name or a unique bare alias, `resolveSlashName`). The queue marks such items `turnOnly`
 * (never steered).
 * Client commands (`/model`, `/remember`) and plain text are never server commands. A catalog that cannot be read
 * (it never rejects by contract) adds nothing: the v1.5 answer (harness and plugin commands only).
 */
export async function isServerCommandFor(deps: Pick<AppDeps, 'registry' | 'customizations'>, projectId: string | null, text: string): Promise<boolean> {
  const parsed = parseSlashCommand(text)
  if (parsed === null || isClientCommand(parsed.name))
    return false
  if (isHarnessCommand(parsed.name) || deps.registry.commands.get(parsed.name) !== undefined)
    return true
  let catalog: CustomizationCatalog | null = null
  try {
    catalog = await deps.customizations.catalog(projectId)
  }
  catch {
    catalog = null
  }
  const target = slashTarget(deps.registry, catalog, parsed.name)
  const registered = deps.registry.commands.get(target.name)
  if (registered !== undefined && (target.pluginId === null || registered.pluginId === target.pluginId))
    return true
  if (catalog === null)
    return false
  const skill = invocableSkill(catalog, target.name)
  if (target.pluginId !== null)
    return skill !== null && skill.source === 'plugin' && skill.pluginId === target.pluginId
  return definitionCommand(catalog, target.name) !== null || skill !== null
}

/** The last user message of a path (the turn's command). */
function lastUserMessage(history: readonly HarnessUIMessage[]): HarnessUIMessage | null {
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index]
    if (message?.role === 'user')
      return message
  }
  return null
}

/**
 * The tool restriction of the turn a run answers (Phase 10, ADR-045; `PreparedRun.turnRestriction`): the
 * `metadata.command.allowedTools` of the turn's user message (the last user message of `history`), so an approval
 * continuation and a regenerate of the turn keep it; null = no restriction (`assembleTools({ allowedTools })`; an empty
 * list leaves no tool but `exit_plan_mode` in plan mode).
 */
export function turnToolRestriction(history: readonly HarnessUIMessage[]): readonly string[] | null {
  const message = lastUserMessage(history)
  if (message === null)
    return null
  const tools = commandAllowedTools(message.metadata?.command?.allowedTools)
  return tools === undefined ? null : Object.freeze(tools)
}

/** What `turnToolRestrictionFor` subtracts a `disallowed-tools` list from (Phase 12). */
export interface TurnRestrictionOptions {
  /** The run's catalog: the `disallowedTools` of the turn command's or skill's active entry. */
  readonly catalog?: CustomizationCatalog | null
  /**
   * The names of the registered tools (`registry.tools`): the tool set a list without `allowed-tools` narrows; a
   * function is called only when the turn has a `disallowed-tools` list.
   */
  readonly toolNames?: readonly string[] | (() => readonly string[])
}

/**
 * The `disallowed-tools` of the turn's invocation (Phase 12, ADR-058): the active catalog entry of the invoked command or
 * skill (the resolved name; a fork keeps `task`); none for a reply, a harness command or a name the catalog no longer
 * has.
 */
export function invocationDisallowedTools(catalog: CustomizationCatalog | null | undefined, invocation: CommandInvocation | undefined): string[] {
  if (catalog === null || catalog === undefined || invocation === undefined || invocation.type !== 'prompt' || typeof invocation.name !== 'string')
    return []
  const entry = invocation.kind === 'skill' ? catalog.skill(invocation.name) : catalog.command(invocation.name)
  if (entry === null || entry.name !== invocation.name)
    return []
  const denied = commandAllowedTools(entry.disallowedTools) ?? []
  return entry.context === 'fork' ? denied.filter(tool => tool !== FORK_TOOL_NAME) : denied
}

/** The prefix an allowlist entry stands for (`mcp__x__*` → `mcp__x__`, `mcp__x` → `mcp__x__`), or null for a name. */
function entryPrefix(entry: string): string | null {
  if (entry.endsWith('*'))
    return entry.slice(0, -1)
  if (entry.startsWith(MCP_TOOL_PREFIX)) {
    const server = entry.slice(MCP_TOOL_PREFIX.length)
    if (server !== '' && !server.includes('__'))
      return `${entry}__`
  }
  return null
}

/**
 * An allowlist without the tools `denied` matches (Phase 12, restrict-only): `allowed` (null = every tool of `known`,
 * plus `mcp__*` for the MCP tools a run adds later unless `denied` names MCP tools); a name `denied` matches is dropped;
 * a prefix entry a denied prefix covers is dropped, one a denied entry falls inside is replaced by the known names under
 * it that are not denied. Never adds a tool.
 */
export function withoutDisallowedTools(allowed: readonly string[] | null, denied: readonly string[], known: readonly string[]): string[] {
  const deniesMcp = denied.some(entry => entry.startsWith(MCP_TOOL_PREFIX))
  const base = allowed ?? [...known, ...(deniesMcp ? [] : [`${MCP_TOOL_PREFIX}*`])]
  const deniedPrefixes = denied.map(entryPrefix).filter((prefix): prefix is string => prefix !== null)
  const kept: string[] = []
  const keep = (name: string): void => {
    if (!kept.includes(name))
      kept.push(name)
  }
  for (const entry of base) {
    const prefix = entryPrefix(entry)
    if (prefix === null) {
      if (!matchToolAllowlist(entry, denied))
        keep(entry)
      continue
    }
    if (deniedPrefixes.some(deniedPrefix => prefix.startsWith(deniedPrefix)))
      continue
    const overlaps = denied.some(item => (entryPrefix(item) ?? item).startsWith(prefix))
    if (!overlaps) {
      keep(entry)
      continue
    }
    for (const name of known) {
      if (name.startsWith(prefix) && !matchToolAllowlist(name, denied))
        keep(name)
    }
  }
  return kept
}

/**
 * `turnToolRestriction` plus the turn command's or skill's `disallowed-tools` (Phase 12, ADR-058; `prepare.ts`): the
 * allowlist of the invocation without the disallowed tools (`withoutDisallowedTools` over `options.toolNames`); without
 * a disallowed list exactly `turnToolRestriction`.
 */
export function turnToolRestrictionFor(history: readonly HarnessUIMessage[], options: TurnRestrictionOptions = {}): readonly string[] | null {
  const allowed = turnToolRestriction(history)
  const denied = invocationDisallowedTools(options.catalog, lastUserMessage(history)?.metadata?.command)
  if (denied.length === 0)
    return allowed
  const known = typeof options.toolNames === 'function' ? options.toolNames() : options.toolNames ?? []
  return Object.freeze(withoutDisallowedTools(allowed, denied, known))
}
