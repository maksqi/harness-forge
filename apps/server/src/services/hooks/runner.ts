// One command hook process (Phase 11, ADR-048; ARCHITECTURE.md 6.28 "Execution"). The hook runs ONLY through
// `runShellCommand` (`workspace/shell.ts`, still the only shell-string spawn): `<sh> -c <command>` in its own process
// group, the stdin payload as `input`, the minimal `shellEnvironment` plus the project / plugin folder variables as
// `env`, its own timeout. A timeout, an abort of the run and the service's `stop()` kill the process group (awaited by
// the shell runner before it settles). stdout keeps its first `LIMITS.hookStdoutBytes` (64 KiB; no tail, so a JSON
// answer is never cut in the middle by an omission marker), stderr its first `LIMITS.hookStderrBytes` (16 KiB).
import type { HookProcessResult } from '@harness-forge/shared'
import type { RunShellOptions, ShellRunResult } from '../../workspace/shell.ts'
import { Buffer } from 'node:buffer'
import { performance } from 'node:perf_hooks'
import { LIMITS } from '@harness-forge/shared'
import { runShellCommand } from '../../workspace/shell.ts'

/** The shell runner (tests may wrap the real one to watch the spawns). */
export type ShellRunner = (options: RunShellOptions) => Promise<ShellRunResult>

/** Text of a hook that could not be started (a missing working folder, a refused variable); safe to show. */
export const HOOK_START_ERROR = 'The hook could not be started.'

export interface CommandHookInput {
  readonly command: string
  /** Absolute working folder (the project root, else `<dataDir>/hooks`). */
  readonly cwd: string
  readonly timeoutMs: number
  /** The stdin JSON (`buildHookPayload`). */
  readonly payload: string
  /** Extra variables (`HARNESS_PROJECT_DIR`, `CLAUDE_PROJECT_DIR`, the plugin root variables). */
  readonly env: Readonly<Record<string, string>>
  /** The run's signal: an abort kills the group and rejects. */
  readonly signal: AbortSignal
}

export interface CommandHookOptions {
  /** Default `runShellCommand`. */
  readonly run?: ShellRunner
  /** Time between SIGTERM and SIGKILL of a killed group (default: the shell runner's 2 s). */
  readonly killGraceMs?: number
  /** Called with the shell's pid (its process group id) once it started. */
  readonly onSpawn?: (pid: number) => void
}

export interface CommandHookRun {
  /** What `readHookOutput` reads. */
  readonly process: HookProcessResult
  readonly durationMs: number
  /** `HOOK_START_ERROR` when the process never started, else null. */
  readonly startError: string | null
}

/** The first `maxBytes` bytes of `text` as UTF-8, never inside a character. */
export function utf8Head(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= maxBytes)
    return text
  let end = Math.max(0, maxBytes)
  // Step back over continuation bytes so the cut never splits a character.
  while (end > 0 && ((bytes[end] ?? 0) & 0xC0) === 0x80)
    end -= 1
  return bytes.subarray(0, end).toString('utf8')
}

/** The timeout of a hook: its own (seconds) or the default 60 s, at most 600 s. */
export function hookTimeoutMs(timeoutSec: number | null | undefined): number {
  const ms = typeof timeoutSec === 'number' && Number.isFinite(timeoutSec) && timeoutSec > 0
    ? Math.ceil(timeoutSec) * 1000
    : LIMITS.hookTimeoutDefaultMs
  return Math.min(ms, LIMITS.hookTimeoutMaxMs)
}

/**
 * Runs one command hook. Resolves with the exit status and the capped outputs (also after a timeout, and with
 * `startError` when the process could not start); rejects only when `input.signal` aborts (after the group is gone).
 */
export async function runCommandHook(input: CommandHookInput, options: CommandHookOptions = {}): Promise<CommandHookRun> {
  const run = options.run ?? runShellCommand
  const begin = performance.now()
  try {
    const result = await run({
      command: input.command,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      input: input.payload,
      env: input.env,
      headBytes: LIMITS.hookStdoutBytes,
      tailBytes: 0,
      ...(options.killGraceMs === undefined ? {} : { killGraceMs: options.killGraceMs }),
      ...(options.onSpawn === undefined ? {} : { onSpawn: options.onSpawn }),
    })
    return {
      process: {
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        stdout: result.stdout.head,
        stdoutTruncated: result.stdout.omittedBytes > 0,
        stderr: utf8Head(result.stderr.head, LIMITS.hookStderrBytes),
      },
      durationMs: result.durationMs,
      startError: null,
    }
  }
  catch (error) {
    if (input.signal.aborted)
      throw error
    return {
      process: { exitCode: null, timedOut: false, stdout: '', stdoutTruncated: false, stderr: '' },
      durationMs: Math.round(performance.now() - begin),
      startError: HOOK_START_ERROR,
    }
  }
}
