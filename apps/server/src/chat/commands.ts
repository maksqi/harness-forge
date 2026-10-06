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
// turn runs on it, `prepare.ts`) and `allowedTools` (the turn's tools narrow to them, `turnToolRestriction`). A body is
// text: `!` lines are never run and `@file` references never expanded. A plugin command (also when the catalog lists it)
// keeps the v1.5 path through the registry. `isServerCommandFor(deps, projectId, text)` tells the queue which queued
// texts are server commands of the chat's project (`turnOnly`). Bodies and expansions are never logged.
// Phase 11 (C37 seams, ADR-052; W11.5 implements the features): `CommandContext.expansion` (`CommandExpansionHost`,
// built by `prepare.ts`) carries what `` !`cmd` `` spans and `@path` references of a command file need: the chat's
// project folder (opened lazily, once), the shell switch and the trust check of a project command file's hash
// (accepted, not used yet: a body is still text). `GET /commands` items carry `kind: 'command'` (user-invocable skills
// join the list as `kind: 'skill'` in W11.5).
import type { CommandDefinition, CommandRunResult } from '@harness-forge/plugin-sdk'
import type { CommandInvocation, CommandSource, CommandSummary, CustomizationEntry, HarnessUIMessage } from '@harness-forge/shared'
import type { PluginHost } from '../plugins/types.ts'
import type { Registry } from '../registry/types.ts'
import type { CustomizationCatalog, CustomizationService, LoadedDefinition } from '../services/customizations/types.ts'
import type { OpenWorkspace } from '../services/projects/types.ts'
import type { AppDeps } from '../types.ts'
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
} from '@harness-forge/shared'
import { GUARD_TIMEOUTS } from '../plugins/guard.ts'

export interface ParsedCommand {
  name: string
  /** The text after `/name`, trimmed. */
  input: string
}

const COMMAND_PREFIX = /^\/([a-z][\da-z-]{0,31})(?=\s|$)/

/** `/name input` at the start of `text` (leading whitespace ignored), else null. */
export function parseSlashCommand(text: string): ParsedCommand | null {
  const trimmed = text.trimStart()
  const match = trimmed.match(COMMAND_PREFIX)
  const name = match?.[1]
  if (match === null || name === undefined || !COMMAND_NAME_PATTERN.test(name))
    return null
  return { name, input: trimmed.slice(match[0].length).trim() }
}

/** Replaces every `{{input}}`; without a placeholder a non-empty input is appended after a blank line. */
export function expandTemplate(template: string, input: string): string {
  if (template.includes('{{input}}'))
    return template.split('{{input}}').join(input)
  return input === '' ? template : `${template}\n\n${input}`
}

export type CommandResolution
  = | { kind: 'prompt', invocation: CommandInvocation & { type: 'prompt', expansion: string } }
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
  /** The chat's project, or null (spans and references need one: else 400). */
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
   * text (a regenerate re-resolves only reply commands). Accepted, not used yet (W11.5).
   */
  expansion?: CommandExpansionHost
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

/** The optional Phase 10 fields of a prompt invocation (a command file's `source`, `modelRef`, `allowedTools`). */
type InvocationExtras = Pick<CommandInvocation, 'source' | 'modelRef' | 'allowedTools'>

function promptResolution(name: string, input: string, expansion: string, extras: InvocationExtras = {}): CommandResolution {
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

/**
 * A project or personal command (Phase 10): the definition loaded again (`load`: the same guards as the discovery),
 * its body expanded with `expandArguments`. A definition that cannot be loaded any more is a `validation_error` on the
 * message (nothing is stored); the abort of a stopped run is rethrown.
 */
async function definitionResolution(
  services: CommandServices,
  entry: CustomizationEntry & { source: 'project' | 'user' },
  parsed: ParsedCommand,
  context: CommandContext,
): Promise<CommandResolution> {
  let loaded: LoadedDefinition
  try {
    loaded = await services.customizations.load(entry, context.signal)
  }
  catch (error) {
    if (context.signal.aborted)
      throw error
    throw definitionUnavailable(parsed.name, error)
  }
  const definition = loaded.definition
  if (definition.kind !== 'command')
    throw definitionUnavailable(parsed.name, new HarnessError({ code: 'validation_error', message: 'The definition is not a command.' }))
  const fields = definition.fields
  const source: CommandSource = entry.source
  const modelRef = commandModelRef(fields.model)
  const allowedTools = commandAllowedTools(fields.allowedTools)
  const expansion = expandArguments(fields.body, parsed.input).text
  return promptResolution(parsed.name, parsed.input, expansion, {
    source,
    ...(modelRef === undefined ? {} : { modelRef }),
    ...(allowedTools === undefined ? {} : { allowedTools }),
  })
}

/**
 * The command invoked by `text`, or null when the text is not a harness command, a command of the run catalog or a
 * registered server-side command. Throws `validation_error` when a prompt expansion is larger than 64 KB, a `/compact`
 * focus longer than 1000 characters or a command definition can no longer be loaded, and the abort reason when the run
 * was stopped; a failing `run` is returned as `failed`.
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
  if (registered === undefined)
    return null
  const { name, input } = parsed
  const definition: CommandDefinition = registered.definition
  if (definition.template !== undefined)
    return promptResolution(name, input, expandTemplate(definition.template, input))
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
 * lists a disposed plugin's command does not bring it back); client and harness names are never taken. Every entry is
 * `kind: 'command'` (Phase 11).
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
  return [...HARNESS_COMMAND_SUMMARIES.map(summary => ({ ...summary })), ...byName.values()]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/**
 * True when `text` starts a server command in a chat of `projectId` (null = no project): the harness command
 * `/compact`, a command a plugin registered, and (Phase 10) every active command file or personal command of the
 * project's catalog (`deps.customizations.catalog`, cached). The queue marks such items `turnOnly` (never steered).
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
    return definitionCommand(catalog, parsed.name) !== null
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
