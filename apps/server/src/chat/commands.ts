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
// Phase 12 (C44 stubs, ADR-058; W12.7 implements behind them): every `expandArguments` call of a definition body passes
// `argumentOptions({ body, names, vars })` (`vars`: `CommandContext.argumentVars` of `prepare.ts`, plus what the call
// site knows); the stub answers undefined, the Phase 10 expansion (no names, base 1, no variables), so every v1.7
// template expands as before. Qualified names (`<pluginId>:<name>`) pass through unchanged (their resolution and the
// bare alias are W12.7's, open point 8).
import type { CommandDefinition, CommandRunResult } from '@harness-forge/plugin-sdk'
import type { CommandInvocation, CommandSource, CommandSummary, CustomizationEntry, CustomizationSource, ExpandArgumentsOptions, HarnessUIMessage } from '@harness-forge/shared'
import type { Logger } from '../logger.ts'
import type { PluginHost } from '../plugins/types.ts'
import type { Registry } from '../registry/types.ts'
import type { CustomizationCatalog, CustomizationService, LoadedDefinition } from '../services/customizations/types.ts'
import type { OpenWorkspace } from '../services/projects/types.ts'
import type { AppDeps } from '../types.ts'
import type { CommandBodyExpansion, CommandBodySource, CommandPlanRunner } from './inline/index.ts'
import { Buffer } from 'node:buffer'
import {
  COMMAND_NAME_PATTERN,
  DEFINITION_LIMITS,
  expandArguments,
  HarnessError,
  isClientCommand,
  isHarnessCommand,
  isHarnessError,
  LIMITS,
  modelRefSchema,
  planCommandExpansion,
  skillInvocation,
  SLASH_NAME_PATTERN,
} from '@harness-forge/shared'
import { GUARD_TIMEOUTS } from '../plugins/guard.ts'
import { expandCommandPlan, minimalExpansion, needsInlining, prepareCommandPlan } from './inline/index.ts'

export interface ParsedCommand {
  name: string
  /** The text after `/name`, trimmed. */
  input: string
}

/** `/name` of up to 64 characters (Phase 11: user-invocable skills; command names stay at 32). */
const COMMAND_PREFIX = /^\/([a-z][\da-z-]{0,63})(?=\s|$)/

/** `/name input` at the start of `text` (leading whitespace ignored), else null. */
export function parseSlashCommand(text: string): ParsedCommand | null {
  const trimmed = text.trimStart()
  const match = trimmed.match(COMMAND_PREFIX)
  const name = match?.[1]
  if (match === null || name === undefined || !SLASH_NAME_PATTERN.test(name))
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
  registry: Pick<Registry, 'commands'>
  plugins: Pick<PluginHost, 'guard'>
  /** Phase 10: the bodies of command files and personal commands (`load(entry, signal)`). */
  customizations: Pick<CustomizationService, 'load'>
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
   * `CLAUDE_SESSION_ID` = the chat id), for `argumentOptions`. Absent = none.
   */
  argumentVars?: Readonly<Record<string, string>>
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
 * The `expandArguments` options of a definition body (Phase 12, ADR-058; C44 stub with its final signature: W12.7
 * answers `{ names, base: argumentBase(body, names), vars }`). The stub answers undefined: the Phase 10 expansion (no
 * names, base 1, no variables), so every v1.6 / v1.7 template expands exactly as before.
 */
export function argumentOptions(_input: ArgumentOptionsInput): ExpandArgumentsOptions | undefined {
  return undefined
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

function promptResolution(name: string, input: string, expansion: string, extras: InvocationExtras = {}): PromptCommandResolution {
  if (Buffer.byteLength(expansion, 'utf8') > LIMITS.commandExpansionBytes)
    throw tooLong(name)
  return { kind: 'prompt', invocation: { name, input, type: 'prompt', expansion, ...extras } }
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
 * The project or personal command of `name` in the catalog (its active entry), else null (no catalog, a plugin entry,
 * no entry, or a client or harness command name, which a definition can never take).
 */
export function definitionCommand(catalog: CustomizationCatalog | null | undefined, name: string): (CustomizationEntry & { source: 'project' | 'user' }) | null {
  if (catalog === null || catalog === undefined || isClientCommand(name) || isHarnessCommand(name))
    return null
  const entry = catalog.command(name)
  return isDefinitionCommand(entry) ? entry : null
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
  const request = { name, input, plan, source, host, signal: context.signal, ...(context.logger === undefined ? {} : { logger: context.logger }) }
  if (context.deferExpansion !== true)
    return { done: await expandCommandPlan(request) }
  return { placeholder, run: await prepareCommandPlan(request) }
}

/** The prompt resolution of a body expansion (`extras`: the definition's fields; `kind` / `inlined` follow the body). */
function bodyResolution(name: string, input: string, body: BodyExpansion, extras: InvocationExtras = {}): PromptCommandResolution {
  if ('done' in body)
    return promptResolution(name, input, body.done.text, { ...extras, ...inlinedExtras(body.done) })
  const finish = async (): Promise<PromptCommandResolution> => {
    const done = await body.run()
    return promptResolution(name, input, done.text, { ...extras, ...inlinedExtras(done) })
  }
  return { ...promptResolution(name, input, body.placeholder, extras), finish }
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

/**
 * A project or personal command (Phase 10): the definition loaded again (`load`: the same guards as the discovery),
 * its body expanded with `expandArguments` (Phase 11: `bodyExpansion`, the spans and references of a trusted body). A
 * definition that cannot be loaded any more is a `validation_error` on the message (nothing is stored); the abort of a
 * stopped run is rethrown.
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
  const modelRef = commandModelRef(fields.model)
  const allowedTools = commandAllowedTools(fields.allowedTools)
  const options = argumentOptions({ body: fields.body, names: fields.arguments ?? null, vars: context.argumentVars ?? {} })
  const expansion = await bodyExpansion(parsed.name, fields.body, parsed.input, entry.source, context, () => expandArguments(fields.body, parsed.input, options).text)
  return bodyResolution(parsed.name, parsed.input, expansion, {
    source,
    ...(modelRef === undefined ? {} : { modelRef }),
    ...(allowedTools === undefined ? {} : { allowedTools }),
  })
}

/** The source of a skill invocation or listing (`CommandSource` has no `builtin`: a builtin is the harness's). */
function skillSource(source: CustomizationSource): CommandSource {
  return source === 'builtin' ? 'harness' : source
}

/**
 * The active user-invocable skill of `name` in the catalog (Phase 11, ADR-052: `user-invocable` not false), else null
 * (no catalog, no such skill, or a client or harness command name, which a skill never takes).
 */
export function invocableSkill(catalog: CustomizationCatalog | null | undefined, name: string): CustomizationEntry | null {
  if (catalog === null || catalog === undefined || isClientCommand(name) || isHarnessCommand(name) || !SLASH_NAME_PATTERN.test(name))
    return null
  const entry = catalog.skill(name)
  return entry !== null && entry.kind === 'skill' && entry.state === 'active' && entry.userInvocable !== false ? entry : null
}

/**
 * A user-invocable skill run as `/name [arguments]` (Phase 11, ADR-052): its content loaded again (`load`) and expanded
 * with `expandArguments` (text only: no spans, no references); a skill that is no longer user-invocable or cannot be
 * loaded is a `validation_error` on the message.
 */
async function skillResolution(services: CommandServices, entry: CustomizationEntry, parsed: ParsedCommand, context: CommandContext): Promise<CommandResolution> {
  const definition = (await loadDefinition(services, entry, parsed.name, context.signal)).definition
  if (definition.kind !== 'skill')
    throw definitionUnavailable(parsed.name, new HarnessError({ code: 'validation_error', message: 'The definition is not a skill.' }))
  if (!skillInvocation(definition.fields).userInvocable)
    throw definitionUnavailable(parsed.name, new HarnessError({ code: 'validation_error', message: 'The skill can no longer be run as a command.' }))
  const content = definition.fields.content
  const options = argumentOptions({ body: content, names: definition.fields.arguments ?? null, vars: context.argumentVars ?? {} })
  const expansion = expandArguments(content, parsed.input, options).text
  return promptResolution(parsed.name, parsed.input, expansion, { kind: 'skill', source: skillSource(entry.source) })
}

/**
 * The command invoked by `text`, or null when the text is not a harness command, a command of the run catalog, a
 * registered server-side command or (Phase 11) a user-invocable skill of the run catalog. Throws `validation_error` when
 * a prompt expansion is larger than 64 KB, a `/compact` focus longer than 1000 characters or a command definition can no
 * longer be loaded, and (Phase 11, with `context.expansion`) the errors of `!` spans: `validation_error` without a
 * project (or its folder), `conflict` `disabled` with the shell off, `conflict` `untrusted` for a project command file
 * whose trust hash is not approved; the abort reason when the run was stopped; a failing `run` is returned as `failed`.
 */
export async function resolveCommand(
  services: CommandServices,
  text: string,
  context: CommandContext,
): Promise<CommandResolution | null> {
  const parsed = parseSlashCommand(text)
  if (parsed === null || isClientCommand(parsed.name))
    return null
  if (isHarnessCommand(parsed.name))
    return compactResolution(parsed.input)
  const definitionEntry = definitionCommand(context.catalog, parsed.name)
  if (definitionEntry !== null)
    return definitionResolution(services, definitionEntry, parsed, context)
  const registered = services.registry.commands.get(parsed.name)
  if (registered === undefined) {
    // Phase 11: a user-invocable skill comes last (a command of any source wins the name).
    const skill = invocableSkill(context.catalog, parsed.name)
    return skill === null ? null : skillResolution(services, skill, parsed, context)
  }
  const { name, input } = parsed
  const definition: CommandDefinition = registered.definition
  const template = definition.template
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
 * The effective server-side commands of a scope (`GET /commands`), sorted by name: `/compact`, then one entry per name
 * of the catalog's project and personal commands and the plugin registry (a project or personal command wins its name
 * over a plugin command: the catalog's precedence). Plugin commands come from the live registry (a catalog that still
 * lists a disposed plugin's command does not bring it back); client and harness names are never taken. Every command
 * is `kind: 'command'`; the catalog's active user-invocable skills (Phase 11, ADR-052) follow as `kind: 'skill'` with
 * their `argumentHint` (and `pluginId` for a plugin skill) unless a command has the name.
 */
export function listServerCommands(registry: Pick<Registry, 'commands'>, catalog: CustomizationCatalog | null): CommandSummary[] {
  const byName = new Map<string, CommandSummary>()
  for (const entry of registry.commands.list()) {
    const name = entry.definition.name
    if (isClientCommand(name) || isHarnessCommand(name) || byName.has(name))
      continue
    byName.set(name, { name, kind: 'command', description: entry.definition.description, source: 'plugin', pluginId: entry.pluginId })
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
      description: entry.description,
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
    byName.set(entry.name, {
      name: entry.name,
      kind: 'skill',
      description: entry.description,
      source: skillSource(entry.source),
      ...(entry.source === 'plugin' && entry.pluginId !== undefined ? { pluginId: entry.pluginId } : {}),
      ...(entry.argumentHint === undefined ? {} : { argumentHint: entry.argumentHint }),
    })
  }
  return [...HARNESS_COMMAND_SUMMARIES.map(summary => ({ ...summary })), ...byName.values()]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/**
 * True when `text` starts a server command in a chat of `projectId` (null = no project): the harness command
 * `/compact`, a command a plugin registered, (Phase 10) every active command file or personal command of the project's
 * catalog (`deps.customizations.catalog`, cached) and (Phase 11) every active user-invocable skill of that catalog. The
 * queue marks such items `turnOnly` (never steered).
 * Client commands (`/model`, `/remember`) and plain text are never server commands. A catalog that cannot be read
 * (it never rejects by contract) adds nothing: the v1.5 answer (harness and plugin commands only).
 */
export async function isServerCommandFor(deps: Pick<AppDeps, 'registry' | 'customizations'>, projectId: string | null, text: string): Promise<boolean> {
  const parsed = parseSlashCommand(text)
  if (parsed === null || isClientCommand(parsed.name))
    return false
  if (isHarnessCommand(parsed.name) || deps.registry.commands.get(parsed.name) !== undefined)
    return true
  try {
    const catalog = await deps.customizations.catalog(projectId)
    return definitionCommand(catalog, parsed.name) !== null || invocableSkill(catalog, parsed.name) !== null
  }
  catch {
    return false
  }
}

/**
 * The tool restriction of the turn a run answers (Phase 10, ADR-045; `PreparedRun.turnRestriction`): the
 * `metadata.command.allowedTools` of the turn's user message (the last user message of `history`), so an approval
 * continuation and a regenerate of the turn keep it; null = no restriction (`assembleTools({ allowedTools })`; an empty
 * list leaves no tool but `exit_plan_mode` in plan mode).
 */
export function turnToolRestriction(history: readonly HarnessUIMessage[]): readonly string[] | null {
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index]
    if (message?.role !== 'user')
      continue
    const tools = commandAllowedTools(message.metadata?.command?.allowedTools)
    return tools === undefined ? null : Object.freeze(tools)
  }
  return null
}
