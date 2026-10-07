// Command extras (Phase 11, ADR-052; ARCHITECTURE.md 6.32): what a trusted command body inlines before the model call:
// the output of its `` !`cmd` `` spans and the project files of its `@path` references. Owner: W11.5. Called by
// `chat/commands.ts` (`definitionResolution`, plugin templates) with the plan of the shared `planCommandExpansion(body)`
// (the body is scanned BEFORE the arguments are expanded, so an argument is never inside a span) and the
// `CommandExpansionHost` of the turn (`prepare.ts`).
//
// Spans, in this order of checks (nothing runs and nothing is stored when one fails):
//   1. a chat without a project → 400 `validation_error` on `['message', 'parts']`;
//   2. the shell off (`HF_WORKSPACE_SHELL=0`) → 409 `conflict` `disabled`;
//   3. the project folder must open (else 400 `validation_error`);
//   4. a trusted source: a personal command (`user`) and a loaded plugin's template (`plugin`) are trusted; a project
//      command file only when the sha256 of its trust item (`commandTrustSubject` of `services/project-config`, the
//      rule the trust listing uses: the name, the spans and the script files they name, read now, so this is the
//      verify-before-run) is approved for the project → else 409 `conflict` `untrusted`;
//   5. the spans run one after another in the project root (`inline/shell.ts`), in every permission mode (sending the
//      command is the approval).
// A 409 of 2 or 4 (`isSpanRefusal`) also removes the chat row the request created (`prepare.ts`, like a hook block).
// W11.17: `prepareCommandPlan` runs the checks 1 – 4 only and returns the runner of the spans and file reads, so
// `prepare.ts` runs the prompt hooks (`SessionStart`, `UserPromptSubmit`) in between: nothing runs and no file is read
// before they passed. The runner checks a project command file's trust hash again right before its spans run
// (verify-before-run: time passed since the check). `expandCommandPlan` does both at once.
// `@path` references are inlined in project chats only (`inline/files.ts`; a refused, missing or unreadable file keeps
// its text); without a project they stay text. The result (`renderCommandExpansion`) is checked against the 64 KB
// expansion cap by the caller and frozen in `metadata.command.expansion` with `inlined { shell, files }`, so a regenerate
// or a continuation never runs a span again. The log gets counts and durations only (never a command, an output, a path
// or a content).
// Phase 12 (ADR-053 / ADR-058; W12.7): `ExpandCommandPlanInput.arguments` are the `expandArguments` options of the body
// (`argumentOptions` of `commands.ts`: named arguments, the argument base, the `${…}` variables), applied to every text
// part, also to a part without an argument placeholder (its variables and `\$` escapes; `renderExpansion`); `spanEnv`
// adds a plugin's variables to the spans' environment (`spanEnvironment(root, spanEnv)`: `CLAUDE_PLUGIN_ROOT`,
// `CLAUDE_PLUGIN_DATA` of a markdown plugin command, a trusted plugin source).
import type { CommandTemplatePlan, ExpandArgumentsOptions, FileBlock, ShellSpanResult } from '@harness-forge/shared'
import type { Logger } from '../../logger.ts'
import type { OpenWorkspace } from '../../services/projects/types.ts'
import type { CommandExpansionHost } from '../commands.ts'
import { argumentBase, expandArguments, formatShellSpanOutput, HarnessError, renderCommandExpansion } from '@harness-forge/shared'
import { commandTrustSubject } from '../../services/project-config/index.ts'
import { readCommandFiles } from './files.ts'
import { runCommandSpans } from './shell.ts'

/** Where the expanded body comes from (who may run its spans). */
export type CommandBodySource = 'user' | 'project' | 'plugin'

/** What a command body inlined (`metadata.command.inlined`). */
export interface CommandInlined {
  /** Spans whose shell started. */
  readonly shell: number
  /** The project-relative `@path` files that were read, in reference order. */
  readonly files: string[]
}

/** The rendered expansion of a command body and what it inlined (absent when nothing was). */
export interface CommandBodyExpansion {
  readonly text: string
  readonly inlined?: CommandInlined
}

/** Input of `expandCommandPlan`. */
export interface ExpandCommandPlanInput {
  /** The command name (no slash): the error messages and the trust item. */
  readonly name: string
  /** The trimmed text after `/name`. */
  readonly input: string
  readonly plan: CommandTemplatePlan
  readonly source: CommandBodySource
  readonly host: CommandExpansionHost
  readonly signal: AbortSignal
  readonly logger?: Logger
  /** Phase 12: the `expandArguments` options of the body (`argumentOptions`); absent = the Phase 10 expansion. */
  readonly arguments?: ExpandArgumentsOptions
  /** Phase 12: extra variables of the spans' environment (a plugin's `CLAUDE_PLUGIN_ROOT` / `CLAUDE_PLUGIN_DATA`). */
  readonly spanEnv?: Readonly<Record<string, string>>
}

function issue(message: string): HarnessError {
  return new HarnessError({ code: 'validation_error', message, details: { issues: [{ path: ['message', 'parts'], message, code: 'custom' }] } })
}

/** The refusals of `spansShellDisabled` / `spansUntrusted` (`isSpanRefusal`). */
const refusals = new WeakSet<HarnessError>()

function refusal(error: HarnessError): HarnessError {
  refusals.add(error)
  return error
}

/**
 * True for the 409 of a command whose spans may not run (`untrusted`, `disabled`): `prepareRun` then removes the chat
 * row the request created (nothing is stored, like a hook block).
 */
export function isSpanRefusal(error: unknown): boolean {
  return error instanceof HarnessError && refusals.has(error)
}

/** Spans of a command sent in a chat without a project (400). */
export function spansNeedProject(name: string): HarnessError {
  return issue(`The /${name} command runs shell lines, which need a chat in a project.`)
}

/** Spans while the shell is off (409 `disabled`). */
export function spansShellDisabled(name: string): HarnessError {
  return refusal(new HarnessError({
    code: 'conflict',
    message: `The /${name} command runs shell lines, but shell commands are turned off on this server (HF_WORKSPACE_SHELL=0).`,
    details: { reason: 'disabled' },
  }))
}

/** Spans of a chat whose project folder does not open (400). */
export function spansFolderUnavailable(name: string): HarnessError {
  return issue(`The /${name} command runs shell lines, but the project folder of this chat is not available.`)
}

/** Spans of a project command file whose trust item is not approved (409 `untrusted`). */
export function spansUntrusted(name: string): HarnessError {
  return refusal(new HarnessError({
    code: 'conflict',
    message: `/${name} runs shell lines you haven't approved. Review the project's files to run it.`,
    details: { reason: 'untrusted' },
  }))
}

/** True when the plan has something to inline: spans, or references in a project chat. */
export function needsInlining(plan: CommandTemplatePlan, host: CommandExpansionHost): boolean {
  return plan.shellCommands.length > 0 || (plan.filePaths.length > 0 && host.projectId !== null)
}

/**
 * The text of the plan with every span empty and no file block: the smallest the expansion can be (the caller refuses
 * a command above the 64 KB cap before anything runs).
 */
export function minimalExpansion(plan: CommandTemplatePlan, input: string): string {
  const shell: ShellSpanResult[] = plan.shellCommands.map(() => ({ exitCode: 0, timedOut: false, output: '', truncated: false }))
  return renderCommandExpansion(plan, { shell, files: [] }, input).text
}

/** Check 4 of the module comment: a project command file's trust item is approved (else 409 `untrusted`). */
async function assertTrusted(request: ExpandCommandPlanInput, workspace: OpenWorkspace, projectId: string): Promise<void> {
  if (request.source !== 'project')
    return
  const subject = await commandTrustSubject(workspace.root, request.name, request.plan.shellCommands, request.signal)
  if (!await request.host.trusted(projectId, subject.sha256))
    throw spansUntrusted(request.name)
}

/** The project folder for the spans: checks 1 – 4 of the module comment. */
async function spanWorkspace(request: ExpandCommandPlanInput): Promise<OpenWorkspace> {
  const { host, name } = request
  const projectId = host.projectId
  if (projectId === null)
    throw spansNeedProject(name)
  if (!host.shellEnabled)
    throw spansShellDisabled(name)
  const workspace = await host.workspace()
  request.signal.throwIfAborted()
  if (workspace === null)
    throw spansFolderUnavailable(name)
  await assertTrusted(request, workspace, projectId)
  return workspace
}

/** Runs the spans (in the checked `workspace`) and reads the referenced files of `plan`, then renders the expansion. */
async function runCommandPlan(request: ExpandCommandPlanInput, checked: OpenWorkspace | null, verify: boolean): Promise<CommandBodyExpansion> {
  const { plan, host, signal } = request
  signal.throwIfAborted()
  let shell: ShellSpanResult[] = []
  let ran = 0
  let workspace = checked
  if (checked !== null && plan.shellCommands.length > 0) {
    if (verify && host.projectId !== null)
      await assertTrusted(request, checked, host.projectId)
    const spans = await runCommandSpans(plan.shellCommands, { root: checked.root, signal, ...(request.spanEnv === undefined ? {} : { env: request.spanEnv }) })
    shell = spans.results
    ran = spans.ran
    request.logger?.info('command shell lines ran', { spans: plan.shellCommands.length, ran: spans.ran, failed: spans.failed, durationMs: spans.durationMs })
  }
  let files: (FileBlock | null)[] = []
  if (plan.filePaths.length > 0 && host.projectId !== null) {
    workspace ??= await host.workspace()
    signal.throwIfAborted()
    if (workspace !== null)
      files = await readCommandFiles(workspace.root, plan.filePaths, signal)
  }
  const read = plan.filePaths.filter((_path, index) => files[index] !== null && files[index] !== undefined)
  const text = renderExpansion(plan, { shell, files }, request.input, request.arguments)
  return ran === 0 && read.length === 0 ? { text } : { text, inlined: { shell: ran, files: read } }
}

/**
 * The rendered expansion (Phase 12): `renderCommandExpansion` without options (the Phase 10 / 11 rendering); with
 * options, the same rendering with every text part expanded, also one without an argument placeholder (only its
 * variables and escapes apply then: `expandArguments` with no input), so `${CLAUDE_…}` and `\$` work next to spans.
 */
export function renderExpansion(
  plan: CommandTemplatePlan,
  results: { readonly shell: readonly ShellSpanResult[], readonly files: readonly (FileBlock | null)[] },
  input: string,
  options?: ExpandArgumentsOptions,
): string {
  if (options === undefined)
    return renderCommandExpansion(plan, results, input).text
  const parts = plan.parts
  const base = options.base ?? argumentBase(parts.filter(part => part.kind === 'text').map(part => part.text).join(''), options.names)
  const partOptions: ExpandArgumentsOptions = { ...options, base }
  const trimmed = input.trim()
  let usedPlaceholder = false
  let text = ''
  for (const part of parts) {
    if (part.kind === 'text') {
      const expanded = expandArguments(part.text, trimmed, partOptions)
      if (expanded.usedPlaceholder) {
        usedPlaceholder = true
        text += expanded.text
      }
      else {
        text += expandArguments(part.text, '', partOptions).text
      }
    }
    else if (part.kind === 'shell') {
      const result = results.shell[part.index]
      text += result === undefined ? '[skipped]' : formatShellSpanOutput(result)
    }
    else {
      text += part.raw
    }
  }
  if (!usedPlaceholder && trimmed !== '')
    text = `${text}\n\n${trimmed}`
  // The file blocks exactly as the shared renderer writes them (a plan of the files alone renders "\n\n" + the blocks).
  const blocks = renderCommandExpansion({ parts: [], shellCommands: [], filePaths: plan.filePaths, diagnostics: [] }, { shell: [], files: results.files }, '').text
  return blocks === '' ? text : `${text}${blocks}`
}

/** The spans and file reads of a checked plan (`prepareCommandPlan`); rejects like `expandCommandPlan`. */
export type CommandPlanRunner = () => Promise<CommandBodyExpansion>

/**
 * Checks `plan` (checks 1 – 4 of the module comment; nothing runs, no referenced file is read) and returns the runner of
 * its spans and file reads (W11.17: `prepare.ts` runs the prompt hooks in between). The runner checks a project command
 * file's trust hash again before its spans run. Throws the errors of the checks, and the abort of a stopped run.
 */
export async function prepareCommandPlan(request: ExpandCommandPlanInput): Promise<CommandPlanRunner> {
  const workspace = request.plan.shellCommands.length > 0 ? await spanWorkspace(request) : null
  return () => runCommandPlan(request, workspace, true)
}

/**
 * Runs the spans and reads the referenced files of `plan` (see the module comment) and renders the expansion. Throws
 * the errors of the checks, and the abort of a stopped run.
 */
export async function expandCommandPlan(request: ExpandCommandPlanInput): Promise<CommandBodyExpansion> {
  const workspace = request.plan.shellCommands.length > 0 ? await spanWorkspace(request) : null
  return runCommandPlan(request, workspace, false)
}
