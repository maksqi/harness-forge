// The `shell` tool of `core-workspace` (ADR-033; policy `ask`, access `execute`, guard timeout 600 s). The definition
// and the `createShellTool(options)` signature come from the P7-0b skeleton (C14); `execute` and `toModelOutput` run
// the command through the shell runner `workspace/shell.ts` (`bash -c`, else `sh -c`; a minimal environment; its own
// process group; capped output). `cwd` is a project-relative folder resolved through the frozen path guard (default the
// project folder); `timeout_ms` defaults to 120 s and caps at 590 s, so it always fires before the guard timeout and a
// timeout is a normal result. Not registered on Windows (`createWorkspaceTools` in ./index.ts); never offered while
// `HF_WORKSPACE_SHELL=0` (the chat pipeline drops `execute` tools).
//
// The text the model sees (`shellModelText`, built only from the stored output and the input; an output that does not
// parse with `shellToolOutputSchema` is sent as JSON):
//
//   Exit code: 0                      or "Stopped after 120 s (timeout)", or "Terminated by signal SIGKILL"
//   stdout:
//   <stdout, or "(empty)">
//   stderr:                           only when stderr is not empty
//   <stderr>
//
// `mockShellStdout` of the `mock:workspace` model (../mock/workspace.ts) reads exactly this shape: the text after the
// `stdout:` label line up to the `stderr:` label line.
import type { Logger, ToolCallContext, ToolDefinition, ToolResultOutput } from '@harness-forge/plugin-sdk'
import type { ShellToolInput, ShellToolOutput } from '@harness-forge/shared'
import type { ResolvedWorkspacePath } from '../../workspace/paths.ts'
import type { CapturedOutput } from '../../workspace/shell.ts'
import { Buffer } from 'node:buffer'
import { stat } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { HarnessError, shellToolInputSchema, shellToolOutputSchema, WORKSPACE_LIMITS, WORKSPACE_TOOL_ACCESS } from '@harness-forge/shared'
import { resolveWorkspacePath } from '../../workspace/paths.ts'
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

/** The output in the order of `shellToolOutputSchema`. */
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

/** The text the model sees for a stored `shell` output (see the module comment). */
export function shellModelText(output: ShellToolOutput, input?: Partial<Pick<ShellToolInput, 'timeout_ms'>>): string {
  const stdout = output.stdout.replace(/\n+$/, '')
  const stderr = output.stderr.replace(/\n+$/, '')
  const lines = [shellStatusLine(output, input?.timeout_ms), 'stdout:', stdout === '' ? SHELL_EMPTY_STDOUT : stdout]
  if (stderr !== '')
    lines.push('stderr:', stderr)
  return lines.join('\n')
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError'
}

export function createShellTool(options: ShellToolOptions): ToolDefinition<ShellToolInput, ShellToolOutput> {
  const { logger } = options
  return {
    name: SHELL_TOOL_NAME,
    description: 'Run a shell command (bash, else sh) in the project folder, or in cwd inside it. Each call is a new process: cd does not persist, there is no stdin, and background processes are stopped when the command ends. timeout_ms defaults to 120000 (at most 590000). Returns the exit code, stdout and stderr (long output keeps its start and end). Use description to say in a few words what the command does.',
    inputSchema: shellToolInputSchema,
    policy: 'ask',
    timeoutMs: SHELL_TOOL_TIMEOUT_MS,
    workspace: WORKSPACE_TOOL_ACCESS.shell,
    async execute(input: ShellToolInput, c: ToolCallContext): Promise<ShellToolOutput> {
      const workspace = requireWorkspace(c)
      const cwd = await resolveShellCwd(workspace.root, input.cwd)
      const timeoutMs = shellTimeoutMs(input.timeout_ms)
      const context = { chatId: c.chatId, toolCallId: c.toolCallId }
      logger.debug('shell command', { ...context, cwd: cwd.rel, timeoutMs, command: redactShellCommand(input.command) })
      const begin = performance.now()
      let result
      try {
        result = await runShellCommand({ command: input.command, cwd: cwd.absolute, timeoutMs, signal: c.signal })
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
      })
      return fitShellOutput({
        command: input.command,
        cwd: cwd.rel,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        stdoutBytes: result.stdout.totalBytes,
        stderrBytes: result.stderr.totalBytes,
      }, result.stdout, result.stderr)
    },
    toModelOutput(output: ShellToolOutput, c: { toolCallId: string, input: ShellToolInput }): ToolResultOutput {
      // An output that does not parse (an older format, or the host's truncation marker) goes to the model as JSON.
      return textModelOutput(shellToolOutputSchema, output, value => shellModelText(value, c.input))
    },
  }
}
