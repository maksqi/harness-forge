// The `shell` tool of `core-workspace` (ADR-033, ADR-038; policy function `shellPolicy`, access `execute`, guard timeout
// 600 s). The definition and the `createShellTool(options)` signature come from the P7-0b skeleton (C14); `execute` and
// `toModelOutput` run the command through the shell runner `workspace/shell.ts` (`bash -c`, else `sh -c`; a minimal
// environment; its own process group; capped output). `timeout_ms` defaults to 120 s and caps at 590 s, so it always
// fires before the guard timeout and a timeout is a normal result. Not registered on Windows (`createWorkspaceTools` in
// ./index.ts); never offered while `HF_WORKSPACE_SHELL=0` (the chat pipeline drops `execute` tools).
//
// Sticky working folder (Phase 8, ADR-038, `workspace/shell-cwd.ts`): a call starts in its explicit `cwd` (resolved
// through the frozen path guard; a refused one is `validation_error` on `['cwd']`), else in the run's remembered folder
// (`runScopeOf(c).shellCwd.current`, re-checked: a folder that is gone means the project folder plus a `cwdNote`), else
// in the project folder. The runner reports the folder the command ended in (`reportCwd`); it is clamped to the project
// (outside or not a folder: `.` plus `SHELL_CWD_OUTSIDE_NOTE`), stored as `endCwd` and becomes the remembered folder
// (the call that finishes last wins). Environment variables never carry over.
//
// Shell rules (Phase 8, ADR-038): `shellPolicy` answers `safe` when the run's rules (`runScopeOf(c).shellRules`) match
// every segment of the command (`matchShellRules` of the shared parser) and every `cd` target enters a folder inside the
// project, else `ask`; the output then carries `allowedBy` (the matched prefixes).
//
// The text the model sees (`shellModelText`, built only from the stored output and the input; an output that does not
// parse with `shellToolOutputSchema` is sent as JSON):
//
//   Exit code: 0                      or "Stopped after 120 s (timeout)", or "Terminated by signal SIGKILL"
//   <cwdNote>                         only with a note
//   The working folder is now sub (the next call starts there).      only when the folder changed
//   stdout:
//   <stdout, or "(empty)">
//   stderr:                           only when stderr is not empty
//   <stderr>
//
// `mockShellStdout` of the `mock:workspace` model (../mock/workspace.ts) reads exactly this shape: the text after the
// `stdout:` label line up to the `stderr:` label line.
import type { Logger, ToolCallContext, ToolDefinition, ToolPolicy, ToolResultOutput } from '@harness-forge/plugin-sdk'
import type { ShellToolInput, ShellToolOutput } from '@harness-forge/shared'
import type { ResolvedWorkspacePath } from '../../workspace/paths.ts'
import type { WorkspaceRunScope } from '../../workspace/run-scope.ts'
import type { CapturedOutput } from '../../workspace/shell.ts'
import { Buffer } from 'node:buffer'
import { stat } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { HarnessError, matchShellRules, shellToolInputSchema, shellToolOutputSchema, WORKSPACE_LIMITS, WORKSPACE_TOOL_ACCESS } from '@harness-forge/shared'
import { resolveWorkspacePath } from '../../workspace/paths.ts'
import { runScopeOf } from '../../workspace/run-scope.ts'
import { cdTargetsInside, checkShellFolder, clampEndCwd, SHELL_CWD_OUTSIDE_NOTE, shellCwdGoneNote, shellFolderLabel } from '../../workspace/shell-cwd.ts'
import { capturedText, redactShellCommand, runShellCommand, shrinkCaptured } from '../../workspace/shell.ts'
import { requireWorkspace, SHELL_TOOL_TIMEOUT_MS, textModelOutput } from './common.ts'

export const SHELL_TOOL_NAME = 'shell'

/** The stdout placeholder of the model text when the command printed nothing. */
export const SHELL_EMPTY_STDOUT = '(empty)'

export interface ShellToolOptions {
  /**
   * The plugin logger (`ctx.logger` of `core-workspace`): one `info` line per call (exit code, signal, timed out,
   * duration, byte counts), the command text only at `debug`, redacted; never the output.
   */
  logger: Logger
}

/** `timeout_ms` of a call: the default when absent, clamped to the shared bounds. */
export function shellTimeoutMs(timeoutMs: number | undefined): number {
  const value = timeoutMs ?? WORKSPACE_LIMITS.shellTimeoutDefaultMs
  if (!Number.isFinite(value))
    return WORKSPACE_LIMITS.shellTimeoutDefaultMs
  return Math.min(Math.max(Math.floor(value), WORKSPACE_LIMITS.shellTimeoutMinMs), WORKSPACE_LIMITS.shellTimeoutMaxMs)
}

/** A refused `cwd`: `validation_error` with the issue path `['cwd']`; the message is shown to the model. */
function cwdError(message: string): HarnessError {
  return new HarnessError({
    code: 'validation_error',
    message,
    details: { issues: [{ path: ['cwd'], message, code: 'custom' }] },
  })
}

/** The working folder of a call: `cwd` (default `.`) through the path guard; it must be a folder. */
export async function resolveShellCwd(root: string, cwd: string | undefined): Promise<ResolvedWorkspacePath> {
  let resolved: ResolvedWorkspacePath
  try {
    resolved = await resolveWorkspacePath(root, cwd ?? '.')
  }
  catch (error) {
    if (error instanceof HarnessError && error.code === 'validation_error')
      throw cwdError(error.message)
    throw error
  }
  const info = await stat(resolved.absolute)
  if (!info.isDirectory())
    throw cwdError(`"${resolved.rel}" is not a folder.`)
  return resolved
}

/** The folder a call starts in, and why it is not the remembered one. */
export interface ShellStartFolder {
  folder: ResolvedWorkspacePath
  /** Set when the remembered folder could not be used (`shellCwdGoneNote`): the call runs in the project folder. */
  note: string | null
}

/**
 * The start folder of a call: the explicit `cwd` (refused: `validation_error` on `['cwd']`, as `resolveShellCwd`), else
 * the remembered folder `remembered` re-checked through the path guard (gone or refused: the project folder with a
 * note), else the project folder.
 */
export async function shellStartFolder(root: string, cwd: string | undefined, remembered: string | undefined): Promise<ShellStartFolder> {
  if (cwd !== undefined || remembered === undefined || remembered === '.')
    return { folder: await resolveShellCwd(root, cwd), note: null }
  const check = await checkShellFolder(root, remembered)
  if (check.ok)
    return { folder: check.folder, note: null }
  return { folder: await resolveShellCwd(root, undefined), note: shellCwdGoneNote(remembered, check.problem) }
}

/** The shell rules verdict of a command (`shellPolicy`, `allowedBy`). */
export interface ShellRulesVerdict {
  /** Every segment matched a rule or is a `cd` into a folder inside the project. */
  allowed: boolean
  /** The canonical prefixes of the matching rules, in first-match order (empty when not allowed). */
  matched: string[]
}

const NOT_ALLOWED: ShellRulesVerdict = { allowed: false, matched: [] }

/**
 * Matches `command` against the rule prefixes (`matchShellRules`, which fails closed) and checks its `cd` targets in
 * order from `start` (the call's absolute start folder): allowed only when both pass.
 */
export async function evaluateShellRules(command: string, prefixes: readonly string[], root: string, start: string): Promise<ShellRulesVerdict> {
  const match = matchShellRules(command, prefixes)
  if (!match.allowed || match.reason !== null)
    return NOT_ALLOWED
  if (match.cdTargets.length > 0 && !await cdTargetsInside(root, start, match.cdTargets))
    return NOT_ALLOWED
  return { allowed: true, matched: match.matched }
}

/** The rule prefixes a call may use: the run's set when it belongs to the call's project, else none. */
function scopeRules(scope: WorkspaceRunScope | null, projectId: string): readonly string[] | null {
  if (scope === null || scope.projectId !== projectId)
    return null
  return scope.shellRules.prefixes
}

/**
 * The policy function of `shell` (ADR-038, ARCHITECTURE.md 6.2 "Shell rules"): `safe` when the run's shell rules match
 * the whole command (`evaluateShellRules`, from the call's start folder), else `ask`; `ask` without a run scope, without
 * a workspace, for an input that does not validate and on any error (the host evaluates it with the raw input under a
 * 3 s guard, where a throw would count as `always`).
 */
export async function shellPolicy(input: unknown, c: ToolCallContext): Promise<ToolPolicy> {
  try {
    const workspace = c.workspace
    const scope = runScopeOf(c)
    const prefixes = workspace === undefined ? null : scopeRules(scope, workspace.projectId)
    const parsed = shellToolInputSchema.safeParse(input)
    if (workspace === undefined || scope === null || prefixes === null || !parsed.success)
      return 'ask'
    const start = await shellStartFolder(workspace.root, parsed.data.cwd, scope.shellCwd.current)
    const verdict = await evaluateShellRules(parsed.data.command, prefixes, workspace.root, start.folder.absolute)
    return verdict.allowed ? 'safe' : 'ask'
  }
  catch {
    return 'ask'
  }
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

/** At most `maxBytes` UTF-8 bytes of `text` (a whole code point at the end), with `...` when it was cut. */
function cutText(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= maxBytes)
    return text
  return `${bytes.subarray(0, Math.max(0, maxBytes)).toString('utf8').replace(/\uFFFD+$/, '')}...`
}

type ShellOutputBase = Omit<ShellToolOutput, 'stdout' | 'stderr'>

/** The output in the order of `shellToolOutputSchema` (the Phase 8 fields only when set). */
function assemble(base: ShellOutputBase, command: string, stdout: string, stderr: string): ShellToolOutput {
  return {
    command,
    cwd: base.cwd,
    exitCode: base.exitCode,
    signal: base.signal,
    timedOut: base.timedOut,
    durationMs: base.durationMs,
    stdout,
    stderr,
    stdoutBytes: base.stdoutBytes,
    stderrBytes: base.stderrBytes,
    ...(base.endCwd === undefined ? {} : { endCwd: base.endCwd }),
    ...(base.cwdNote === undefined ? {} : { cwdNote: base.cwdNote }),
    ...(base.allowedBy === undefined ? {} : { allowedBy: base.allowedBy }),
  }
}

/** Extra bytes removed per cut (marker digits, rounding). */
const FIT_SLACK_BYTES = 64

/** UTF-8 bytes of the kept text of a captured stream. */
function keptBytes(output: CapturedOutput): number {
  return Buffer.byteLength(output.head, 'utf8') + Buffer.byteLength(output.tail, 'utf8')
}

/** `output` cut by about `jsonExcess` bytes of its JSON form (escaped characters count more than once). */
function shrinkByJson(output: CapturedOutput, text: string, jsonExcess: number): CapturedOutput {
  const raw = keptBytes(output)
  if (raw === 0 || jsonExcess <= 0)
    return output
  const ratio = raw / Math.max(1, jsonBytes(text))
  return shrinkCaptured(output, Math.ceil(jsonExcess * ratio) + FIT_SLACK_BYTES)
}

/**
 * The stored output: `base` plus the stream texts, trimmed to `maxBytes` of serialized JSON
 * (`WORKSPACE_LIMITS.outputMaxBytes`): both streams lose bytes from their middle, in proportion to their size (their
 * omission markers grow); the command is cut only when both streams are empty.
 */
export function fitShellOutput(
  base: ShellOutputBase,
  stdout: CapturedOutput,
  stderr: CapturedOutput,
  maxBytes: number = WORKSPACE_LIMITS.outputMaxBytes,
): ShellToolOutput {
  let out = stdout
  let err = stderr
  let command = base.command
  for (let attempt = 0; attempt < 16; attempt++) {
    const output = assemble(base, command, capturedText(out), capturedText(err))
    const excess = jsonBytes(output) - maxBytes
    if (excess <= 0)
      return output
    const outRaw = keptBytes(out)
    const errRaw = keptBytes(err)
    if (outRaw === 0 && errRaw === 0) {
      command = cutText(command, Math.max(0, Buffer.byteLength(command, 'utf8') - excess - FIT_SLACK_BYTES))
      continue
    }
    const outJson = outRaw === 0 ? 0 : jsonBytes(output.stdout)
    const errJson = errRaw === 0 ? 0 : jsonBytes(output.stderr)
    out = shrinkByJson(out, output.stdout, excess * outJson / (outJson + errJson))
    err = shrinkByJson(err, output.stderr, excess * errJson / (outJson + errJson))
  }
  // Unreachable with the shared limits (16 KiB command, 20 KiB per stream); keeps the cap whatever happens.
  return assemble(base, cutText(command, 1024), '', '')
}

/** Seconds for the status line: whole seconds, else one decimal. */
function formatSeconds(ms: number): string {
  const seconds = ms / 1000
  return Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1)
}

/** The first line of the model text: the exit code, the timeout or the signal. */
export function shellStatusLine(output: ShellToolOutput, timeoutMs?: number): string {
  if (output.timedOut)
    return `Stopped after ${formatSeconds(shellTimeoutMs(timeoutMs))} s (timeout)`
  if (output.exitCode !== null)
    return `Exit code: ${output.exitCode}`
  if (output.signal !== null)
    return `Terminated by signal ${output.signal}`
  return 'Exit code: unknown'
}

/** The folder line of the model text: "The working folder is now packages/web (the next call starts there)." */
export function shellFolderLine(endCwd: string): string {
  return `The working folder is now ${shellFolderLabel(endCwd)} (the next call starts there).`
}

/**
 * The lines between the status line and `stdout:`: the `cwdNote`, then the folder line when the next call starts
 * somewhere else than this one did (the end folder differs from the start folder, the call had an explicit `cwd`, or
 * the remembered folder was gone); none when the folder was not reported or the note already says where the next call
 * starts.
 */
export function shellFolderLines(output: ShellToolOutput, input?: Partial<Pick<ShellToolInput, 'cwd'>>): string[] {
  const lines: string[] = []
  if (output.cwdNote !== undefined)
    lines.push(output.cwdNote)
  if (output.endCwd === undefined || output.cwdNote?.includes(SHELL_CWD_OUTSIDE_NOTE) === true)
    return lines
  if (output.endCwd !== output.cwd || input?.cwd !== undefined || output.cwdNote !== undefined)
    lines.push(shellFolderLine(output.endCwd))
  return lines
}

/** The text the model sees for a stored `shell` output (see the module comment). */
export function shellModelText(output: ShellToolOutput, input?: Partial<Pick<ShellToolInput, 'timeout_ms' | 'cwd'>>): string {
  const stdout = output.stdout.replace(/\n+$/, '')
  const stderr = output.stderr.replace(/\n+$/, '')
  const lines = [shellStatusLine(output, input?.timeout_ms), ...shellFolderLines(output, input), 'stdout:', stdout === '' ? SHELL_EMPTY_STDOUT : stdout]
  if (stderr !== '')
    lines.push('stderr:', stderr)
  return lines.join('\n')
}

/** `shellToolOutputSchema.cwdNote` max. */
const CWD_NOTE_MAX_CHARS = 500

/** Both notes of a call (the start and the end folder), within the schema's 500 characters. */
function joinNotes(...notes: Array<string | null>): string | undefined {
  const text = notes.filter((note): note is string => note !== null).join(' ')
  if (text === '')
    return undefined
  return text.length > CWD_NOTE_MAX_CHARS ? `${text.slice(0, CWD_NOTE_MAX_CHARS - 3)}...` : text
}

/** `{ [key]: value }`, or `{}` for `undefined` (optional output fields stay absent, not `undefined`). */
function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return value === undefined ? {} : { [key]: value } as { [P in K]?: V }
}

/** The description the model sees (at most 1024 characters). */
export const SHELL_TOOL_DESCRIPTION = 'Run a shell command (bash, else sh) in the working folder, or in cwd inside the project folder. Each call is a new process: the working folder carries over to the next call (cd persists inside the project folder; the first call starts in the project folder), environment variables do not, there is no stdin, and background processes are stopped when the command ends. timeout_ms defaults to 120000 (at most 590000). Returns the exit code, stdout and stderr (long output keeps its start and end). Use description to say in a few words what the command does.'

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError'
}

export function createShellTool(options: ShellToolOptions): ToolDefinition<ShellToolInput, ShellToolOutput> {
  const { logger } = options
  return {
    name: SHELL_TOOL_NAME,
    description: SHELL_TOOL_DESCRIPTION,
    inputSchema: shellToolInputSchema,
    policy: shellPolicy,
    timeoutMs: SHELL_TOOL_TIMEOUT_MS,
    workspace: WORKSPACE_TOOL_ACCESS.shell,
    async execute(input: ShellToolInput, c: ToolCallContext): Promise<ShellToolOutput> {
      const workspace = requireWorkspace(c)
      const scope = runScopeOf(c)
      const start = await shellStartFolder(workspace.root, input.cwd, scope?.shellCwd.current)
      const cwd = start.folder
      const prefixes = scopeRules(scope, workspace.projectId)
      const verdict = prefixes === null ? NOT_ALLOWED : await evaluateShellRules(input.command, prefixes, workspace.root, cwd.absolute)
      const allowedBy = verdict.allowed && verdict.matched.length > 0 ? verdict.matched : undefined
      const timeoutMs = shellTimeoutMs(input.timeout_ms)
      const context = { chatId: c.chatId, toolCallId: c.toolCallId }
      logger.debug('shell command', { ...context, cwd: cwd.rel, timeoutMs, command: redactShellCommand(input.command) })
      const begin = performance.now()
      let result
      try {
        result = await runShellCommand({ command: input.command, cwd: cwd.absolute, timeoutMs, signal: c.signal, reportCwd: true })
      }
      catch (error) {
        const durationMs = Math.round(performance.now() - begin)
        if (isAbortError(error))
          logger.info('shell command stopped', { ...context, aborted: true, durationMs })
        else
          logger.warn('shell command failed to start', { ...context, durationMs, error: error instanceof Error ? error.message : String(error) })
        throw error
      }
      logger.info('shell command finished', {
        ...context,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        stdoutBytes: result.stdout.totalBytes,
        stderrBytes: result.stderr.totalBytes,
        ...(allowedBy === undefined ? {} : { allowedByRule: true }),
      })
      // The end folder: reported -> clamped to the project; not reported -> the folder stays as it was (the project
      // folder when the remembered one was gone).
      const end = result.endCwd === null ? null : await clampEndCwd(workspace.root, result.endCwd)
      if (scope !== null) {
        if (end !== null)
          scope.shellCwd.current = end.endCwd
        else if (start.note !== null)
          scope.shellCwd.current = '.'
      }
      return fitShellOutput({
        command: input.command,
        cwd: cwd.rel,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        stdoutBytes: result.stdout.totalBytes,
        stderrBytes: result.stderr.totalBytes,
        ...(end === null ? {} : { endCwd: end.endCwd }),
        ...optional('cwdNote', joinNotes(start.note, end?.note ?? null)),
        ...optional('allowedBy', allowedBy),
      }, result.stdout, result.stderr)
    },
    toModelOutput(output: ShellToolOutput, c: { toolCallId: string, input: ShellToolInput }): ToolResultOutput {
      // An output that does not parse (an older format, or the host's truncation marker) goes to the model as JSON.
      return textModelOutput(shellToolOutputSchema, output, value => shellModelText(value, c.input))
    },
  }
}
