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
// `@path` references are inlined in project chats only (`inline/files.ts`; a refused, missing or unreadable file keeps
// its text); without a project they stay text. The result (`renderCommandExpansion`) is checked against the 64 KB
// expansion cap by the caller and frozen in `metadata.command.expansion` with `inlined { shell, files }`, so a regenerate
// or a continuation never runs a span again. The log gets counts and durations only (never a command, an output, a path
// or a content).
import type { CommandTemplatePlan, FileBlock, ShellSpanResult } from '@harness-forge/shared'
import type { Logger } from '../../logger.ts'
import type { OpenWorkspace } from '../../services/projects/types.ts'
import type { CommandExpansionHost } from '../commands.ts'
import { HarnessError, renderCommandExpansion } from '@harness-forge/shared'
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
  if (request.source === 'project') {
    const subject = await commandTrustSubject(workspace.root, name, request.plan.shellCommands, request.signal)
    if (!await host.trusted(projectId, subject.sha256))
      throw spansUntrusted(name)
  }
  return workspace
}

/**
 * Runs the spans and reads the referenced files of `plan` (see the module comment) and renders the expansion. Throws
 * the errors of the checks, and the abort of a stopped run.
 */
export async function expandCommandPlan(request: ExpandCommandPlanInput): Promise<CommandBodyExpansion> {
  const { plan, host, signal } = request
  let shell: ShellSpanResult[] = []
  let ran = 0
  let workspace: OpenWorkspace | null = null
  if (plan.shellCommands.length > 0) {
    workspace = await spanWorkspace(request)
    const spans = await runCommandSpans(plan.shellCommands, { root: workspace.root, signal })
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
  const text = renderCommandExpansion(plan, { shell, files }, request.input).text
  return ran === 0 && read.length === 0 ? { text } : { text, inlined: { shell: ran, files: read } }
}
