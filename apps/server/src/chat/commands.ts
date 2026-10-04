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
// Phase 10 (C31 seams, ADR-045; W10.2 implements them): `resolveCommand(…, { catalog })` gets the run's catalog
// snapshot (command files and personal commands: client → harness → project `.harness` → `.claude` → personal → plugin;
// until W10.2 only the harness command and the plugin registry resolve), `isServerCommandFor(deps, projectId, text)`
// tells the queue which queued texts are server commands of the chat's project (`turnOnly`), and
// `turnToolRestriction(history)` reads the `allowed-tools` of the turn's command (`PreparedRun.turnRestriction`; null
// until W10.2).
import type { CommandDefinition, CommandRunResult } from '@harness-forge/plugin-sdk'
import type { CommandInvocation, CommandSummary, HarnessUIMessage } from '@harness-forge/shared'
import type { PluginHost } from '../plugins/types.ts'
import type { Registry } from '../registry/types.ts'
import type { CustomizationCatalog, CustomizationService } from '../services/customizations/types.ts'
import type { AppDeps } from '../types.ts'
import { Buffer } from 'node:buffer'
import { COMMAND_NAME_PATTERN, HarnessError, isClientCommand, isHarnessCommand, isHarnessError, LIMITS } from '@harness-forge/shared'
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
  Object.freeze({ name: 'compact', description: 'Summarize the conversation to free up context', source: 'harness', pluginId: 'core-agent' }),
])

export interface CommandServices {
  registry: Pick<Registry, 'commands'>
  plugins: Pick<PluginHost, 'guard'>
  /** Phase 10: the bodies of command files and personal commands (`load(entry, signal)`, W10.2). */
  customizations: Pick<CustomizationService, 'load'>
}

/** The call-specific values of `resolveCommand`. */
export interface CommandContext {
  chatId: string
  /** The run signal (a guarded `run`, a body load). */
  signal: AbortSignal
  /**
   * The run's catalog snapshot (Phase 10, `PreparedRun.catalog`): the command files of the chat's project and the
   * personal commands, by precedence (W10.2). Absent = the harness command and the plugin registry only.
   */
  catalog?: CustomizationCatalog
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

function promptResolution(name: string, input: string, expansion: string): CommandResolution {
  if (Buffer.byteLength(expansion, 'utf8') > LIMITS.commandExpansionBytes)
    throw tooLong(name)
  return { kind: 'prompt', invocation: { name, input, type: 'prompt', expansion } }
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

/**
 * The command invoked by `text`, or null when the text is not a harness command or a registered server-side command.
 * Throws `validation_error` when a prompt expansion is larger than 64 KB or a `/compact` focus longer than 1000
 * characters, and the abort reason when the run was stopped; a failing `run` is returned as `failed`.
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
 * True when `text` starts a server command in a chat of `projectId` (null = no project): the harness command
 * `/compact`, a command a plugin registered, and (Phase 10, W10.2) every effective command file or personal command of
 * the project's catalog. The queue marks such items `turnOnly` (never steered). Client commands (`/model`) are never
 * server commands. P10-0b: the harness command and the plugin registry only (the v1.5 `isServerCommand`).
 */
export async function isServerCommandFor(deps: Pick<AppDeps, 'registry' | 'customizations'>, projectId: string | null, text: string): Promise<boolean> {
  void projectId
  const parsed = parseSlashCommand(text)
  if (parsed === null || isClientCommand(parsed.name))
    return false
  return isHarnessCommand(parsed.name) || deps.registry.commands.get(parsed.name) !== undefined
}

/**
 * The tool restriction of the turn a run answers (Phase 10, ADR-045; `PreparedRun.turnRestriction`): the
 * `metadata.command.allowedTools` of the turn's user message (the last user message of `history`), so an approval
 * continuation and a regenerate of the turn keep it; null = no restriction (`assembleTools({ allowedTools })`).
 * P10-0b stub: always null (W10.2 implements it).
 */
export function turnToolRestriction(history: readonly HarnessUIMessage[]): readonly string[] | null {
  void history
  return null
}
