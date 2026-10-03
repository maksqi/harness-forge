// The shell runner of the `shell` tool (ADR-033, ARCHITECTURE.md 6.13 "The shell runner"). This is the ONLY place in
// the server that starts a shell: everything else spawns argument arrays without a shell.
//
// `runShellCommand({ command, cwd, timeoutMs, signal })`:
//   - `spawn(sh, ['-c', command], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true, shell: false })`, `sh`
//     = `/bin/bash` when executable, else `/bin/sh`; `env` = `shellEnvironment` (./shell-env.ts: an allowlist, never
//     `HF_*`, provider keys or `NODE_ENV`); no stdin. `detached` makes the shell the leader of its own process group,
//     so one signal reaches everything it started.
//   - The kill (`killProcessGroup`): `process.kill(-pid, 'SIGTERM')`, then `SIGKILL` after 2 s, repeated until the
//     group is gone (ESRCH; repeating catches processes forked meanwhile). It fires on the timeout (a normal result with
//     `timedOut: true`), on the abort signal (the promise rejects with an `AbortError` once the group is gone), and when
//     the shell exits while its pipes stay open for 500 ms or its group still has members (background processes: they
//     are stopped). A process-exit handler SIGKILLs every live group, because detached groups outlive the server.
//   - Output: each stream keeps its first 4 KiB and its last 16 KiB (`WORKSPACE_LIMITS`) with "[… N bytes omitted …]"
//     between them; ANSI escape sequences and other control characters are stripped, `\r\n` becomes `\n`, and a line
//     rewritten with `\r` (a progress bar) keeps only its last segment. The byte counts are those of the raw streams.
//
// Accepted risk (ADR-033): a process that calls `setsid` leaves the group and escapes the kill; its pipes are then
// closed by force so the call still ends.
import type { ChildProcess } from 'node:child_process'
import type { Readable } from 'node:stream'
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { WORKSPACE_LIMITS } from '@harness-forge/shared'
import { createRedactor } from '../security/redact.ts'
import { shellEnvironment } from './shell-env.ts'

/** Time between `SIGTERM` and the first `SIGKILL` of a process group. */
export const SHELL_KILL_GRACE_MS = 2000
/** How long the pipes may stay open after the shell exited before its background processes are stopped. */
export const SHELL_PIPE_GRACE_MS = 500
/** Interval of the `SIGKILL` repeats while the group still has members. */
export const SHELL_KILL_REPEAT_MS = 200
/** `SIGKILL` repeats before the kill gives up (a process stuck in the kernel); the exit handler tries once more. */
export const SHELL_KILL_MAX_REPEATS = 25
/** Interval of the "is the group gone" checks. */
const KILL_POLL_MS = 25
/** How long the pipes may stay open after the group is gone (a process that left the group) before they are closed. */
const PIPE_DRAIN_MS = 200
/** Characters of a command written to the debug log. */
export const SHELL_LOG_COMMAND_MAX_CHARS = 1000

const BASH = '/bin/bash'
const SH = '/bin/sh'

// ---------- shell binary ----------

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  }
  catch {
    return false
  }
}

/** `/bin/bash` when it is executable, else `/bin/sh`. */
export function pickShell(canExecute: (path: string) => boolean = isExecutable): string {
  return canExecute(BASH) ? BASH : SH
}

let cachedShell: string | undefined

/** The shell binary of this host (`pickShell`, checked once). */
export function shellBinary(): string {
  cachedShell ??= pickShell()
  return cachedShell
}

// ---------- text ----------

/**
 * ANSI escape sequences: OSC (`ESC ]` … BEL or `ESC \`), CSI (`ESC [` or U+009B, parameters, intermediates, final),
 * DCS / SOS / PM / APC strings, and the other two- and three-byte escapes (character sets, keypad modes, reset).
 */
const ANSI_PATTERN = new RegExp([
  String.raw`\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)`,
  String.raw`(?:\u001B\[|\u009B)[\u0030-\u003F]*[\u0020-\u002F]*[\u0040-\u007E]`,
  String.raw`\u001B[PX^_][^\u001B]*\u001B\\`,
  String.raw`\u001B[\u0020-\u002F]*[\u0030-\u007E]`,
].join('|'), 'g')

/** Control characters (Unicode `Cc`: C0, DEL, C1) except tab and newline: a lone ESC, BEL, backspace, NUL, ... */
const CONTROL_PATTERN = /[^\P{Cc}\t\n]/gu

/** The last non-empty segment of a line rewritten with `\r` (what a terminal would show last). */
function lastSegment(line: string): string {
  if (!line.includes('\r'))
    return line
  const segments = line.split('\r')
  for (let index = segments.length - 1; index >= 0; index--) {
    const segment = segments[index] ?? ''
    if (segment !== '')
      return segment
  }
  return ''
}

/**
 * Terminal output as plain text: ANSI escape sequences stripped, `\r\n` (and `\r\r\n`) -> `\n`, a `\r` progress line
 * reduced to its last segment, other control characters (except tab and newline) removed.
 */
export function normalizeTerminalText(text: string): string {
  const plain = text.replace(ANSI_PATTERN, '').replace(/\r+\n/g, '\n')
  const collapsed = plain.includes('\r') ? plain.split('\n').map(lastSegment).join('\n') : plain
  return collapsed.replace(CONTROL_PATTERN, '')
}

/** The marker between the kept start and end of a long stream. */
export function omissionMarker(bytes: number): string {
  return `[… ${bytes} bytes omitted …]`
}

/** Length of the longest prefix of `bytes` that does not end inside a UTF-8 sequence. */
function utf8PrefixEnd(bytes: Uint8Array): number {
  let index = bytes.length - 1
  let continuation = 0
  while (index >= 0 && continuation < 3 && ((bytes[index] ?? 0) & 0xC0) === 0x80) {
    index--
    continuation++
  }
  if (index < 0)
    return bytes.length
  const lead = bytes[index] ?? 0
  const needed = lead >= 0xF0 ? 4 : lead >= 0xE0 ? 3 : lead >= 0xC0 ? 2 : 1
  return bytes.length - index >= needed ? bytes.length : index
}

/** Offset of the first byte of `bytes` that does not continue a UTF-8 sequence started before it. */
function utf8SuffixStart(bytes: Uint8Array): number {
  let index = 0
  while (index < bytes.length && index < 3 && ((bytes[index] ?? 0) & 0xC0) === 0x80)
    index++
  return index
}

/** At most the first `max` bytes of `bytes`, cut on a UTF-8 boundary. */
function utf8Head(bytes: Buffer, max: number): Buffer {
  const head = bytes.subarray(0, Math.max(0, max))
  return head.subarray(0, utf8PrefixEnd(head))
}

/** At most the last `max` bytes of `bytes`, cut on a UTF-8 boundary. */
function utf8Tail(bytes: Buffer, max: number): Buffer {
  const tail = bytes.subarray(bytes.length - Math.min(bytes.length, Math.max(0, max)))
  return tail.subarray(utf8SuffixStart(tail))
}

// ---------- captured output ----------

/** One captured stream: the kept start and end as normalized text, and what was dropped between them. */
export interface CapturedOutput {
  /** The start of the stream (the whole stream when nothing was omitted). */
  readonly head: string
  /** The end of the stream; '' when nothing was omitted. */
  readonly tail: string
  /** Bytes dropped between `head` and `tail` (0 = `head` is the whole stream). */
  readonly omittedBytes: number
  /** Bytes the stream produced in total (raw, before trimming and normalization). */
  readonly totalBytes: number
}

/** The text of a captured stream: `head`, then the omission marker on its own line and `tail` when bytes were dropped. */
export function capturedText(output: CapturedOutput): string {
  if (output.omittedBytes <= 0)
    return output.head + output.tail
  const head = output.head === '' || output.head.endsWith('\n') ? output.head : `${output.head}\n`
  return `${head}${omissionMarker(output.omittedBytes)}\n${output.tail}`
}

/** Share of the kept bytes that stays at the start when a stream is cut (4 KiB of 20 KiB, as in the capture). */
const HEAD_SHARE = WORKSPACE_LIMITS.shellStreamHeadBytes / (WORKSPACE_LIMITS.shellStreamHeadBytes + WORKSPACE_LIMITS.shellStreamTailBytes)

/**
 * `output` with about `removeBytes` more bytes dropped from its middle (one fifth from the end of the start, the rest
 * from the start of the end), for an output that must fit a size cap. The omitted count grows by the bytes removed.
 */
export function shrinkCaptured(output: CapturedOutput, removeBytes: number): CapturedOutput {
  const contiguous = output.omittedBytes <= 0
  const head = Buffer.from(contiguous ? output.head + output.tail : output.head, 'utf8')
  const tail = Buffer.from(contiguous ? '' : output.tail, 'utf8')
  const kept = head.length + tail.length
  const target = Math.max(0, kept - Math.max(0, Math.ceil(removeBytes)))
  let headKeep = Math.min(head.length, Math.floor(target * HEAD_SHARE))
  let tailKeep = target - headKeep
  let newHead: Buffer
  let newTail: Buffer
  if (contiguous) {
    newHead = utf8Head(head, headKeep)
    newTail = utf8Tail(head.subarray(newHead.length), tailKeep)
  }
  else {
    if (tailKeep > tail.length) {
      headKeep = Math.min(head.length, headKeep + tailKeep - tail.length)
      tailKeep = tail.length
    }
    newHead = utf8Head(head, headKeep)
    newTail = utf8Tail(tail, tailKeep)
  }
  const removed = kept - newHead.length - newTail.length
  if (removed <= 0)
    return output
  return {
    head: newHead.toString('utf8'),
    tail: newTail.toString('utf8'),
    omittedBytes: Math.max(0, output.omittedBytes) + removed,
    totalBytes: output.totalBytes,
  }
}

/** Keeps the first `headMax` and the last `tailMax` bytes of a stream and counts the rest. */
export class StreamCapture {
  readonly #headMax: number
  readonly #tailMax: number
  readonly #head: Buffer[] = []
  #headLength = 0
  #tail: Buffer = Buffer.alloc(0)
  #total = 0

  constructor(headMax: number = WORKSPACE_LIMITS.shellStreamHeadBytes, tailMax: number = WORKSPACE_LIMITS.shellStreamTailBytes) {
    this.#headMax = Math.max(0, headMax)
    this.#tailMax = Math.max(0, tailMax)
  }

  /** Bytes received so far. */
  get totalBytes(): number {
    return this.#total
  }

  push(chunk: Buffer | string): void {
    let rest = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    this.#total += rest.length
    if (this.#headLength < this.#headMax) {
      const take = Math.min(this.#headMax - this.#headLength, rest.length)
      this.#head.push(Buffer.from(rest.subarray(0, take)))
      this.#headLength += take
      rest = rest.subarray(take)
    }
    if (rest.length === 0 || this.#tailMax === 0)
      return
    if (rest.length >= this.#tailMax) {
      this.#tail = Buffer.from(rest.subarray(rest.length - this.#tailMax))
      return
    }
    const combined = Buffer.concat([this.#tail, rest])
    this.#tail = combined.length > this.#tailMax ? Buffer.from(combined.subarray(combined.length - this.#tailMax)) : combined
  }

  /** The captured stream as normalized text (`CapturedOutput`). */
  finish(): CapturedOutput {
    const head = Buffer.concat(this.#head)
    const tail = this.#tail
    if (this.#total === head.length + tail.length)
      return { head: normalizeTerminalText(Buffer.concat([head, tail]).toString('utf8')), tail: '', omittedBytes: 0, totalBytes: this.#total }
    const keptHead = head.subarray(0, utf8PrefixEnd(head))
    const keptTail = tail.subarray(utf8SuffixStart(tail))
    return {
      head: normalizeTerminalText(keptHead.toString('utf8')),
      tail: normalizeTerminalText(keptTail.toString('utf8')),
      omittedBytes: this.#total - keptHead.length - keptTail.length,
      totalBytes: this.#total,
    }
  }
}

// ---------- process groups ----------

/** Process groups started by this process and not yet known to be gone. */
const liveGroups = new Set<number>()
let exitHandlerInstalled = false

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined
}

/** Sends `signal` to the process group `pgid` (0 = only check it); false when the group is gone (ESRCH). */
function signalGroup(pgid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pgid, signal)
    return true
  }
  catch (error) {
    // EPERM: a member exists but changed its user (a setuid program); treat the group as alive.
    return errorCode(error) !== 'ESRCH'
  }
}

/** Resolves true as soon as the group is gone, false when it still exists after `ms`. */
async function waitForGroupGone(pgid: number, ms: number): Promise<boolean> {
  const deadline = performance.now() + ms
  for (;;) {
    if (!signalGroup(pgid, 0))
      return true
    const left = deadline - performance.now()
    if (left <= 0)
      return false
    await delay(Math.min(KILL_POLL_MS, left))
  }
}

export interface KillProcessGroupOptions {
  /** Time between `SIGTERM` and the first `SIGKILL`; default `SHELL_KILL_GRACE_MS`. */
  graceMs?: number
  /** Interval of the `SIGKILL` repeats; default `SHELL_KILL_REPEAT_MS`. */
  repeatMs?: number
  /** `SIGKILL` repeats before giving up; default `SHELL_KILL_MAX_REPEATS`. */
  maxRepeats?: number
}

/**
 * Stops the process group `pgid`: `SIGTERM`, then `SIGKILL` after the grace period, repeated until the group is gone.
 * Resolves true when it is gone, false when it gave up (the group then stays in the exit handler's list).
 */
export async function killProcessGroup(pgid: number, options: KillProcessGroupOptions = {}): Promise<boolean> {
  const graceMs = options.graceMs ?? SHELL_KILL_GRACE_MS
  const repeatMs = options.repeatMs ?? SHELL_KILL_REPEAT_MS
  const maxRepeats = options.maxRepeats ?? SHELL_KILL_MAX_REPEATS
  let gone = !signalGroup(pgid, 'SIGTERM') || await waitForGroupGone(pgid, graceMs)
  for (let repeat = 0; !gone && repeat < maxRepeats; repeat++)
    gone = !signalGroup(pgid, 'SIGKILL') || await waitForGroupGone(pgid, repeatMs)
  if (gone)
    liveGroups.delete(pgid)
  return gone
}

/** SIGKILLs every live shell process group (the process-exit handler; synchronous). */
export function killLiveShellGroups(): void {
  for (const pgid of liveGroups) {
    try {
      process.kill(-pgid, 'SIGKILL')
    }
    catch {
      // Gone already, or not ours to signal any more.
    }
  }
}

/** Process group ids of the shell commands still alive (tests, diagnostics). */
export function liveShellGroups(): number[] {
  return [...liveGroups]
}

function trackGroup(pgid: number): void {
  liveGroups.add(pgid)
  if (!exitHandlerInstalled) {
    exitHandlerInstalled = true
    process.on('exit', killLiveShellGroups)
  }
}

// ---------- the runner ----------

export interface RunShellOptions {
  /** The command line, run with `<sh> -c`. */
  command: string
  /** Absolute working folder (resolved and checked by the caller). */
  cwd: string
  /** Stop the command after this many milliseconds (a normal result with `timedOut: true`). */
  timeoutMs: number
  /** Aborts the command: the group is killed and the promise rejects with an `AbortError`. */
  signal?: AbortSignal
  /** Shell binary; default `shellBinary()`. */
  shell?: string
  /** Environment the allowlist reads from; default `process.env`. */
  parentEnv?: Readonly<Record<string, string | undefined>>
  /** Default `SHELL_KILL_GRACE_MS` (tests inject shorter ones). */
  killGraceMs?: number
  /** Default `SHELL_PIPE_GRACE_MS`. */
  pipeGraceMs?: number
  /** Bytes kept of the start and of the end of each stream; default `WORKSPACE_LIMITS.shellStream{Head,Tail}Bytes`. */
  headBytes?: number
  tailBytes?: number
  /** Called with the shell's pid (= its process group id) once it started. */
  onSpawn?: (pid: number) => void
}

export interface ShellRunResult {
  /** Exit code of the shell; null when it was ended by a signal. */
  exitCode: number | null
  /** The signal that ended the shell, else null. */
  signal: NodeJS.Signals | null
  /** Stopped after `timeoutMs`. */
  timedOut: boolean
  /** Background processes were still running (or holding the output open) when the shell exited, and were stopped. */
  stoppedBackground: boolean
  /** From the start of the shell to its exit. */
  durationMs: number
  stdout: CapturedOutput
  stderr: CapturedOutput
}

/** The error of an aborted command: the signal's reason when it is an `AbortError`, else a new one. */
export function shellAbortError(signal?: AbortSignal): Error {
  const reason: unknown = signal?.reason
  if (reason instanceof Error && reason.name === 'AbortError')
    return reason
  return new DOMException('The shell command was stopped.', 'AbortError') as Error
}

function startError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  return new Error(`The shell could not be started: ${message}`, { cause: error })
}

/** Resolves when the stream closed (end of data, error or destroy). */
function closed(stream: Readable | null): Promise<void> {
  if (stream === null || stream.closed || stream.destroyed)
    return Promise.resolve()
  return new Promise((resolve) => {
    stream.once('close', () => resolve())
  })
}

/** Resolves true when `promise` settles within `ms`, false otherwise. */
async function within(promise: Promise<unknown>, ms: number): Promise<boolean> {
  const controller = new AbortController()
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      delay(ms, false, { signal: controller.signal }).catch(() => false),
    ])
  }
  finally {
    controller.abort()
  }
}

/** Resolves with the pid once the child started; rejects with its start error. */
function started(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    function onSpawn(): void {
      child.off('error', onError)
      if (child.pid === undefined)
        reject(new Error('The shell has no process id.'))
      else
        resolve(child.pid)
    }
    function onError(error: Error): void {
      child.off('spawn', onSpawn)
      reject(error)
    }
    child.once('spawn', onSpawn)
    child.once('error', onError)
  })
}

/**
 * Runs `command` with `<sh> -c` in `cwd` (see the module comment). Resolves with the exit status and the captured
 * output, also after a timeout (`timedOut: true`); rejects with an `AbortError` when `signal` aborts (after the
 * process group is gone), and with an error when the shell cannot start.
 */
export async function runShellCommand(options: RunShellOptions): Promise<ShellRunResult> {
  if (process.platform === 'win32')
    throw new Error('The shell tool needs a POSIX system (process groups).')
  const { signal } = options
  if (signal?.aborted)
    throw shellAbortError(signal)
  const sh = options.shell ?? shellBinary()
  const killOptions: KillProcessGroupOptions = { graceMs: options.killGraceMs }
  const stdout = new StreamCapture(options.headBytes, options.tailBytes)
  const stderr = new StreamCapture(options.headBytes, options.tailBytes)

  const begin = performance.now()
  let child: ChildProcess
  try {
    child = spawn(sh, ['-c', options.command], {
      cwd: options.cwd,
      env: shellEnvironment(sh, options.parentEnv),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      shell: false,
      windowsHide: true,
    })
  }
  catch (error) {
    throw startError(error)
  }
  // Later 'error' events (a failed kill) must not crash the process; the kill checks the group itself.
  child.on('error', () => {})
  child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk))
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))
  const pipesClosed = Promise.all([closed(child.stdout), closed(child.stderr)])
  const exited = new Promise<{ code: number | null, signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, exitSignal) => resolve({ code, signal: exitSignal }))
  })

  let pid: number
  try {
    pid = await started(child)
  }
  catch (error) {
    child.stdout?.destroy()
    child.stderr?.destroy()
    throw startError(error)
  }
  trackGroup(pid)
  options.onSpawn?.(pid)

  let timedOut = false
  let aborted = false
  let killing: Promise<boolean> | null = null
  const stopGroup = (): Promise<boolean> => {
    killing ??= killProcessGroup(pid, killOptions)
    return killing
  }
  const timer = setTimeout(() => {
    timedOut = true
    void stopGroup()
  }, Math.max(0, options.timeoutMs))
  const onAbort = (): void => {
    aborted = true
    void stopGroup()
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  // Aborted while the shell was starting.
  if (signal?.aborted === true)
    onAbort()

  try {
    const exit = await exited
    const durationMs = Math.round(performance.now() - begin)
    clearTimeout(timer)

    // Background processes: they keep the pipes open, or they still sit in the group after the shell exited.
    let stoppedBackground = false
    const pipesDone = await within(pipesClosed, options.pipeGraceMs ?? SHELL_PIPE_GRACE_MS)
    if (killing === null && (!pipesDone || signalGroup(pid, 0))) {
      stoppedBackground = true
      void stopGroup()
    }
    if (killing !== null)
      await killing
    else
      liveGroups.delete(pid)

    // A process that left the group (setsid) may still hold the pipes: close them by force.
    if (!await within(pipesClosed, PIPE_DRAIN_MS)) {
      child.stdout?.destroy()
      child.stderr?.destroy()
      await pipesClosed
    }

    if (aborted)
      throw shellAbortError(signal)
    return {
      exitCode: exit.code,
      signal: exit.signal,
      timedOut: timedOut && !aborted,
      stoppedBackground,
      durationMs,
      stdout: stdout.finish(),
      stderr: stderr.finish(),
    }
  }
  finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

// ---------- logging ----------

/** Pattern-based redaction for the debug log (the plugin log redacts registered secrets as well). */
const logRedactor = createRedactor()

/** The command for the debug log: cut to `SHELL_LOG_COMMAND_MAX_CHARS` and redacted. Never logged at `info`. */
export function redactShellCommand(command: string): string {
  const cut = command.length > SHELL_LOG_COMMAND_MAX_CHARS ? `${command.slice(0, SHELL_LOG_COMMAND_MAX_CHARS)}...` : command
  return logRedactor.redactText(cut)
}
