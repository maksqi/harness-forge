// `` !`cmd` `` spans of a command (Phase 11, ADR-052; ARCHITECTURE.md 6.32 "Execution"). Owner: W11.5.
//
// The spans run one after another through `runShellCommand` (the only shell-string spawn: its own process group, the
// minimal `shellEnvironment`, no stdin) in the project root with `HARNESS_PROJECT_DIR` / `CLAUDE_PROJECT_DIR` set to it:
// each at most `LIMITS.commandShellTimeoutMs` (30 s), all together at most `LIMITS.commandShellTotalMs` (60 s); a span
// gets what is left of the total when that is less, and the spans after the budget is used up do not start (`skipped:
// 'time-limit'`, `[skipped: time limit]`). Each stream keeps at most 16 KiB (its start and its end); stdout then stderr
// form the span's output, which `formatShellSpanOutput` cuts to `LIMITS.commandShellOutputBytes` and annotates. A shell
// that cannot start is a failed span (a note instead of output). The run's abort kills the process group and rejects
// (`AbortError`). Span outputs are not journaled (like a command typed in a terminal) and never logged; commands are
// never logged.
import type { ShellSpanResult } from '@harness-forge/shared'
import type { RunShellOptions, ShellRunResult } from '../../workspace/shell.ts'
import { performance } from 'node:perf_hooks'
import { LIMITS } from '@harness-forge/shared'
import { capturedText, runShellCommand } from '../../workspace/shell.ts'

/** Bytes kept of the start of each stream of a span (with `SPAN_TAIL_BYTES`: 16 KiB, the output cap). */
const SPAN_HEAD_BYTES = 12_288
/** Bytes kept of the end of each stream of a span. */
const SPAN_TAIL_BYTES = 4096
/** The output of a span whose shell could not start. */
export const SPAN_START_FAILED = 'The shell could not be started.'

/** Options of `runCommandSpans`. */
export interface CommandSpanOptions {
  /** The project root (a canonical realpath): the working folder of every span. */
  readonly root: string
  /** The run's signal: aborts the running span (its group is killed) and rejects. */
  readonly signal: AbortSignal
  /** Timeout of one span; default `LIMITS.commandShellTimeoutMs`. */
  readonly spanTimeoutMs?: number
  /** Time all spans may take together; default `LIMITS.commandShellTotalMs`. */
  readonly totalMs?: number
  /** The runner (tests); default `runShellCommand`. */
  readonly run?: (options: RunShellOptions) => Promise<ShellRunResult>
  /** Monotonic clock in ms (tests); default `performance.now`. */
  readonly now?: () => number
  /** Grace between SIGTERM and SIGKILL of a timed-out span (tests); default the runner's. */
  readonly killGraceMs?: number
}

/** What `runCommandSpans` did. */
export interface CommandSpanRun {
  /** One result per span, in order (`skipped: 'time-limit'` for the spans that did not start). */
  readonly results: ShellSpanResult[]
  /** Spans whose shell started (the `inlined.shell` count). */
  readonly ran: number
  /** Spans that timed out, exited non-zero or could not start (for the log line). */
  readonly failed: number
  /** Time all spans took together. */
  readonly durationMs: number
}

/** The variables every span gets on top of `shellEnvironment`. */
export function spanEnvironment(root: string): Record<string, string> {
  return { HARNESS_PROJECT_DIR: root, CLAUDE_PROJECT_DIR: root }
}

/** The span result of a finished shell: stdout, then stderr (when not empty). */
export function spanResultOf(result: ShellRunResult): ShellSpanResult {
  const stdout = capturedText(result.stdout).replace(/\n+$/, '')
  const stderr = capturedText(result.stderr).replace(/\n+$/, '')
  const output = stderr === '' ? stdout : stdout === '' ? stderr : `${stdout}\n${stderr}`
  return {
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    output,
    truncated: result.stdout.omittedBytes > 0 || result.stderr.omittedBytes > 0,
  }
}

const SKIPPED: ShellSpanResult = Object.freeze({ exitCode: null, timedOut: false, output: '', truncated: false, skipped: 'time-limit' })

/** Runs the span commands one after another (see the module comment). */
export async function runCommandSpans(commands: readonly string[], options: CommandSpanOptions): Promise<CommandSpanRun> {
  const run = options.run ?? runShellCommand
  const now = options.now ?? (() => performance.now())
  const spanTimeoutMs = options.spanTimeoutMs ?? LIMITS.commandShellTimeoutMs
  const totalMs = options.totalMs ?? LIMITS.commandShellTotalMs
  const started = now()
  const results: ShellSpanResult[] = []
  let ran = 0
  let failed = 0
  for (const command of commands.slice(0, LIMITS.commandShellSpansMax)) {
    const remaining = totalMs - (now() - started)
    if (remaining <= 0) {
      results.push(SKIPPED)
      continue
    }
    let result: ShellRunResult
    try {
      result = await run({
        command,
        cwd: options.root,
        timeoutMs: Math.max(1, Math.min(spanTimeoutMs, Math.floor(remaining))),
        signal: options.signal,
        env: spanEnvironment(options.root),
        headBytes: SPAN_HEAD_BYTES,
        tailBytes: SPAN_TAIL_BYTES,
        ...(options.killGraceMs === undefined ? {} : { killGraceMs: options.killGraceMs }),
      })
    }
    catch (error) {
      if (options.signal.aborted)
        throw error
      failed += 1
      results.push({ exitCode: null, timedOut: false, output: SPAN_START_FAILED, truncated: false })
      continue
    }
    ran += 1
    const span = spanResultOf(result)
    if (span.timedOut || span.exitCode !== 0)
      failed += 1
    results.push(span)
  }
  return { results, ran, failed, durationMs: Math.max(0, Math.round(now() - started)) }
}
