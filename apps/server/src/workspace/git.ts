// The hardened git runner (Phase 8, ADR-037, ARCHITECTURE.md 6.17 "The git runner"). This is the ONLY module of the
// server that runs git: argument arrays, no shell, a scrubbed environment and fixed `-c` overrides, so a repository
// (its config, attributes and hooks, which an agent or a downloaded project may control) cannot make git run a program.
// Complete and frozen after Gate P8-0b (C21); the changes panel (W8.2, W8.3) builds on the helpers below.
//
// Every call:
//   - Only read-only plumbing (`GIT_ALLOWED_COMMANDS`: rev-parse, symbolic-ref, status, ls-tree, ls-files, cat-file,
//     check-attr; plus the internal `config --get-regexp` below). `git diff` is never run (diffs are the HEAD blob
//     against the disk) and nothing writes the index, the refs or the work tree.
//   - `spawn('git', [...GIT_FIXED_ARGS, ...driverOverrides, ...args], { cwd, env, shell: false, detached: true,
//     stdio: ['ignore', 'pipe', 'pipe'] })`: git leads its own process group, which `killProcessGroup` (./shell.ts)
//     stops on the timeout (`LIMITS.gitTimeoutMs`, 15 s: `timeout`), on the abort signal (the promise rejects with an
//     `AbortError` once the group is gone) and when stdout passes `LIMITS.gitOutputMaxBytes` (8 MiB: `failed`); stderr
//     keeps its first `GIT_STDERR_MAX_BYTES`. A group still alive after git exited is stopped as well, and a
//     process-exit handler SIGKILLs every live group.
//   - Environment (`gitEnvironment`): the shell allowlist (./shell-env.ts: HOME, USER, PATH, LANG, TZ, TMPDIR, ...) plus
//     `GIT_ENV_FIXED` (`GIT_OPTIONAL_LOCKS=0`: status never writes the index; `GIT_CONFIG_NOSYSTEM=1`;
//     `GIT_TERMINAL_PROMPT=0`; `GIT_PAGER=cat`; `LC_ALL=C`: stable messages; `GIT_LITERAL_PATHSPECS=1`: a path is never
//     a glob or a `:(magic)` pathspec; `GIT_NO_LAZY_FETCH=1`: a partial clone never fetches) and
//     `GIT_CEILING_DIRECTORIES=dirname(<allowed root>)`, so git never discovers a repository above the allowed workspace
//     root (in development never the harness-forge repository that holds `data/workspaces`). Every inherited `GIT_*`
//     variable (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_CONFIG_*`, `GIT_EXEC_PATH`, `GIT_TRACE*`, ...) stays out.
//   - Fixed arguments (`GIT_FIXED_ARGS`): `--no-pager -c core.fsmonitor=false -c core.hooksPath=/dev/null
//     -c diff.external= -c core.pager=cat -c color.ui=false -c core.quotepath=false -c protocol.allow=never
//     -c safe.bareRepository=explicit` (the last one: a folder that merely looks like a bare repository is refused
//     instead of trusted; `safe.directory` is NOT overridden, so git's "dubious ownership" check stays on: `refused`).
//   - Filter and diff drivers: before each command, `git config -z --name-only --get-regexp '^(filter|diff)\.'` lists
//     the drivers of every config scope git reads (global, repository, worktree, include chains), and each one is
//     neutralized with `-c filter.<n>.clean= -c filter.<n>.smudge= -c filter.<n>.process= -c filter.<n>.required=false`
//     and `-c diff.<n>.textconv= -c diff.<n>.command=` (command-line config wins over every file). Verified with git
//     2.54 (control runs without the overrides fire every program): an empty `clean` / `smudge` / `process` value runs
//     no program, `required=false` is needed because a required driver without a program makes `status` die, and an
//     empty `textconv` / `command` makes git fail with "cannot run" instead of running anything. A driver name that `-c`
//     cannot express (it contains `=`), more than `GIT_DRIVERS_MAX` drivers or an unreadable configuration answer
//     `refused`: git is not run when the neutralization cannot be guaranteed.
//
// The global configuration (`~/.gitconfig`) is read on purpose (no `GIT_CONFIG_GLOBAL=/dev/null`): it belongs to the
// server user, it is where the documented Docker fix (`git config --global --add safe.directory ...`) lives, and its
// `core.excludesFile` keeps the Git view equal to the user's own `git status`; everything in it that could run a
// program during these commands is neutralized exactly like the repository's configuration.
//
// Accepted risk: the driver list is read right before each command, so a process that rewrites the configuration in
// between could add a driver; such a process already runs code as the server user (ARCHITECTURE.md 10.9).
import type { GitUnavailableReason } from '@harness-forge/shared'
import type { ChildProcess } from 'node:child_process'
import type { Readable } from 'node:stream'
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { LIMITS, workspaceToolPathSchema } from '@harness-forge/shared'
import { isWithin } from '../plugins/scaffold/paths.ts'
import { OUTSIDE_PROJECT_MESSAGE, resolveWorkspacePath, toWorkspaceRel, workspacePathError } from './paths.ts'
import { shellEnvironment } from './shell-env.ts'
import { killProcessGroup } from './shell.ts'

// ---------- constants ----------

/** Arguments that start every git command (before the driver overrides and the command). */
export const GIT_FIXED_ARGS: readonly string[] = Object.freeze([
  '--no-pager',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'diff.external=',
  '-c',
  'core.pager=cat',
  '-c',
  'color.ui=false',
  '-c',
  'core.quotepath=false',
  '-c',
  'protocol.allow=never',
  '-c',
  'safe.bareRepository=explicit',
])

/** Variables every git command gets (plus `GIT_CEILING_DIRECTORIES`). */
export const GIT_ENV_FIXED = Object.freeze({
  GIT_OPTIONAL_LOCKS: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
  LC_ALL: 'C',
  GIT_LITERAL_PATHSPECS: '1',
  GIT_NO_LAZY_FETCH: '1',
} as const satisfies Record<string, string>)

/** How long a failed start (`ENOENT`: no git on `PATH`) is remembered per `PATH`. */
export const GIT_MISSING_CACHE_MS = 60_000
/** Bytes of stderr kept (the start of the stream). */
export const GIT_STDERR_MAX_BYTES = 16 * 1024
/** Filter + diff drivers that can be neutralized; a configuration with more is `refused`. */
export const GIT_DRIVERS_MAX = 64
/** The commands `runGit` accepts as `args[0]`: read-only plumbing (never `diff`, `checkout` or a write). */
export const GIT_ALLOWED_COMMANDS = Object.freeze(['rev-parse', 'symbolic-ref', 'status', 'ls-tree', 'ls-files', 'cat-file', 'check-attr'] as const)
/** Paths per `check-attr` command (the rest goes into further commands). */
export const GIT_ATTR_PATHS_PER_CALL = 256
/** Time between `SIGTERM` and `SIGKILL` of a git process group. */
export const GIT_KILL_GRACE_MS = 1000
/** How long the pipes may stay open after git exited before its process group is stopped. */
const PIPE_GRACE_MS = 500
/** How long the pipes may stay open after the group is gone before they are closed by force. */
const PIPE_DRAIN_MS = 200

const IS_WINDOWS = process.platform === 'win32'
const OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const MODE_PATTERN = /^[0-7]{6}$/

// ---------- result types ----------

/** Why git could not answer: the `GitStatus.reason` values that come from the runner (API.md, `GET /chats/:id/git`). */
export type GitFailureReason = Extract<GitUnavailableReason, 'git-missing' | 'not-a-repo' | 'refused' | 'timeout' | 'failed'>

/** A git command that did not give a usable answer. */
export interface GitFailure {
  readonly ok: false
  readonly reason: GitFailureReason
  /** A short English explanation without file contents (diagnostics; the DTO carries only `reason`). */
  readonly message: string
  /** The first line of git's stderr, at most 300 characters; may name paths: debug logs only. */
  readonly detail?: string
}

/** A successful answer of a helper: `{ ok: true, ...value }`, or a `GitFailure`. */
export type GitResult<T extends object> = ({ readonly ok: true } & Readonly<T>) | GitFailure

/** A git command that ran to completion with an accepted exit code. */
export interface GitOutput {
  readonly ok: true
  readonly exitCode: number
  /** The whole stdout (at most the output cap). */
  readonly stdout: Buffer
  /** The start of stderr (`GIT_STDERR_MAX_BYTES`), decoded as UTF-8. */
  readonly stderr: string
}

/** Result of `runGit`. */
export type GitRunResult = GitOutput | GitFailure

/** Branch, HEAD and the place of the project folder in its repository. */
export interface GitRepoInfo {
  /** The current branch (`symbolic-ref --short HEAD`); null for a detached HEAD. */
  readonly branch: string | null
  /** The HEAD commit id; null for an unborn HEAD (no commit yet). */
  readonly head: string | null
  /** The project folder relative to the repository's work tree, POSIX, without a trailing slash; `''` at the top. */
  readonly prefix: string
}

/** Columns shared by the tracked entries of `git status --porcelain=v2`. */
interface GitTrackedEntryBase {
  /** Project-relative POSIX path (the repository prefix removed). */
  readonly path: string
  /** Index (X) and work tree (Y) status letters: `.` unchanged, `M`, `T` (type change), `A`, `D`, `R`, `C`, `U`. */
  readonly xy: string
  /** `N...` for a normal file, `S<c><m><u>` for a submodule. */
  readonly submodule: string
}

/** `1`: an ordinary changed entry. Modes are octal strings (`100644`, `100755`, `120000`, `160000`, `000000`). */
export interface GitOrdinaryEntry extends GitTrackedEntryBase {
  readonly type: 'ordinary'
  readonly modeHead: string
  readonly modeIndex: string
  readonly modeWorktree: string
  readonly oidHead: string
  readonly oidIndex: string
}

/** `2`: a rename (or copy) between HEAD and the index. */
export interface GitRenamedEntry extends Omit<GitOrdinaryEntry, 'type'> {
  readonly type: 'renamed'
  /** `R<similarity>` for a rename, `C<similarity>` for a copy (e.g. `R100`). */
  readonly score: string
  /** The path at HEAD, project-relative; null when it lies outside the project folder. */
  readonly origPath: string | null
}

/** `u`: an unmerged (conflicted) entry, with the modes and ids of the three stages. */
export interface GitUnmergedEntry extends GitTrackedEntryBase {
  readonly type: 'unmerged'
  readonly modeStage1: string
  readonly modeStage2: string
  readonly modeStage3: string
  readonly modeWorktree: string
  readonly oidStage1: string
  readonly oidStage2: string
  readonly oidStage3: string
}

/** `?`: an untracked file (an untracked nested repository appears once, with a trailing `/`). */
export interface GitUntrackedEntry {
  readonly type: 'untracked'
  readonly path: string
}

/** One raw entry of `git status --porcelain=v2 -z` (W8.3 maps them onto `GitStatusFile`). */
export type GitStatusEntry = GitOrdinaryEntry | GitRenamedEntry | GitUnmergedEntry | GitUntrackedEntry

/** `gitStatus`: the repository info and the entries inside the project folder. */
export interface GitStatusSnapshot extends GitRepoInfo {
  /** Sorted by path; at most `LIMITS.gitStatusFilesMax`. */
  readonly entries: readonly GitStatusEntry[]
  /** More entries than `LIMITS.gitStatusFilesMax` (the first ones by path are kept). */
  readonly truncated: boolean
}

/** What a HEAD tree entry is. */
export type GitBlobKind = 'file' | 'executable' | 'symlink' | 'submodule'

/** A file at HEAD (`gitHeadBlob`). */
export interface GitHeadBlob {
  /** The tree mode: `100644`, `100755`, `120000` (symbolic link), `160000` (submodule). */
  readonly mode: string
  readonly kind: GitBlobKind
  /** The blob id (the commit id for a submodule). */
  readonly oid: string
  /** Bytes of the blob; null for a submodule. */
  readonly size: number | null
  /** The blob's bytes (a symbolic link: its target); null for a submodule and when the blob is over the cap. */
  readonly content: Buffer | null
  /** The blob is larger than the cap (`content` is null). */
  readonly tooLarge: boolean
}

// ---------- options ----------

/** Options of `runGit`. */
export interface RunGitOptions {
  /** Working folder: absolute, inside `allowedRoot` (the project folder or a folder below it). */
  readonly cwd: string
  /** The allowed workspace root (an `HF_WORKSPACE_ROOTS` entry) that holds `cwd`: git never looks above it. */
  readonly allowedRoot: string
  /** Aborts the command: its process group is stopped and the promise rejects with an `AbortError`. */
  readonly signal?: AbortSignal
  /** Exit codes that count as success (default `[0]`); any other exit code is `failed`. */
  readonly okExitCodes?: readonly number[]
  /** Default `LIMITS.gitTimeoutMs` (per command). */
  readonly timeoutMs?: number
  /** Default (and maximum) `LIMITS.gitOutputMaxBytes`. */
  readonly maxOutputBytes?: number
  /** The environment the allowlist reads from; default `process.env` (tests point `HOME` / `PATH` elsewhere). */
  readonly parentEnv?: Readonly<Record<string, string | undefined>>
  /** Default `GIT_KILL_GRACE_MS` (tests). */
  readonly killGraceMs?: number
}

/** Options of the helpers (`gitRepoInfo`, `gitStatus`, `gitHeadBlob`, `gitFilterAttr`). */
export interface GitHelperOptions {
  /**
   * The allowed workspace roots (`ProjectService.roots()`: canonical realpaths). The outermost root that holds the
   * project folder bounds the repository discovery (`GIT_CEILING_DIRECTORIES`); a project outside every root is
   * `refused`.
   */
  readonly workspaceRoots: readonly string[]
  readonly signal?: AbortSignal
  /** Default `LIMITS.gitTimeoutMs` (per command). */
  readonly timeoutMs?: number
  /** Default `process.env` (tests). */
  readonly parentEnv?: Readonly<Record<string, string | undefined>>
  /** Default `GIT_KILL_GRACE_MS` (tests). */
  readonly killGraceMs?: number
}

// ---------- environment ----------

/**
 * The environment of a git command: the shell allowlist of `parentEnv` (`shellEnvironment`, without `SHELL` and
 * without any `GIT_*` variable), `GIT_ENV_FIXED` and `GIT_CEILING_DIRECTORIES = dirname(allowedRoot)`.
 */
export function gitEnvironment(
  allowedRoot: string,
  parentEnv: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const base = shellEnvironment('/bin/sh', parentEnv)
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (key !== 'SHELL' && !key.startsWith('GIT_'))
      env[key] = value
  }
  Object.assign(env, GIT_ENV_FIXED)
  env.GIT_CEILING_DIRECTORIES = dirname(allowedRoot)
  return env
}

/** The filter and diff drivers a configuration defines (by name). */
export interface GitConfigDrivers {
  /** `filter.<name>.*`: clean / smudge / process programs. */
  readonly filters: readonly string[]
  /** `diff.<name>.*`: textconv and external diff (`command`) programs. */
  readonly diffs: readonly string[]
}

/**
 * The `-c` arguments that neutralize `drivers`: `filter.<n>.clean= filter.<n>.smudge= filter.<n>.process=
 * filter.<n>.required=false` and `diff.<n>.textconv= diff.<n>.command=`. An empty program value runs nothing (a
 * textconv or diff command then fails with "cannot run"; `required=false` keeps `status` working without the filter).
 */
export function gitDriverOverrides(drivers: GitConfigDrivers): string[] {
  const args: string[] = []
  for (const name of drivers.filters) {
    for (const setting of ['clean=', 'smudge=', 'process=', 'required=false'])
      args.push('-c', `filter.${name}.${setting}`)
  }
  for (const name of drivers.diffs) {
    for (const setting of ['textconv=', 'command='])
      args.push('-c', `diff.${name}.${setting}`)
  }
  return args
}

/** The configuration keys the driver discovery lists (`git config --get-regexp`). */
export const GIT_DRIVER_KEYS_PATTERN = '^(filter|diff)\\.'

/**
 * The drivers in the output of `git config -z --name-only --get-regexp '^(filter|diff)\.'` (`<section>.<name>.<key>`,
 * NUL-separated; a name may contain dots, spaces and quotes; `diff.external` and other keys without a name are not
 * drivers), or the first name that `-c` cannot express (it contains `=` or a newline).
 */
export function parseConfigDrivers(output: string): GitConfigDrivers | { unsupported: string } {
  const filters = new Set<string>()
  const diffs = new Set<string>()
  for (const key of output.split('\0')) {
    const section = key.slice(0, key.indexOf('.') + 1).toLowerCase()
    const names = section === 'filter.' ? filters : section === 'diff.' ? diffs : null
    if (names === null)
      continue
    const last = key.lastIndexOf('.')
    // `<section>.<key>` without a subsection names no driver.
    if (last < section.length)
      continue
    const name = key.slice(section.length, last)
    if (name.includes('=') || name.includes('\n'))
      return { unsupported: name }
    names.add(name)
  }
  return { filters: [...filters], diffs: [...diffs] }
}

// ---------- process groups ----------

/** Process groups of git commands that are still running (the exit handler SIGKILLs them). */
const liveGroups = new Set<number>()
let exitHandlerInstalled = false

/** SIGKILLs every live git process group (the process-exit handler; synchronous). */
export function killLiveGitGroups(): void {
  for (const pgid of liveGroups) {
    try {
      process.kill(-pgid, 'SIGKILL')
    }
    catch {
      // Gone already.
    }
  }
}

/** Process group ids of git commands still alive (tests, diagnostics). */
export function liveGitGroups(): number[] {
  return [...liveGroups]
}

function trackGroup(pgid: number): void {
  liveGroups.add(pgid)
  if (!exitHandlerInstalled) {
    exitHandlerInstalled = true
    process.on('exit', killLiveGitGroups)
  }
}

/** True while the process group `pgid` has members (EPERM: a member changed its user; treated as alive). */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  }
  catch (error) {
    return errorCode(error) !== 'ESRCH'
  }
}

// ---------- git missing ----------

/** `PATH` value -> time until which git counts as missing. */
const missingUntil = new Map<string, number>()

/** Forgets every cached "git is missing" answer (tests). */
export function clearGitMissingCache(): void {
  missingUntil.clear()
}

function missingCached(path: string): boolean {
  const until = missingUntil.get(path)
  if (until === undefined)
    return false
  if (Date.now() < until)
    return true
  missingUntil.delete(path)
  return false
}

// ---------- spawning ----------

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined
}

function failure(reason: GitFailureReason, message: string, stderr?: string): GitFailure {
  const line = stderr?.split('\n').find(text => text.trim() !== '')?.trim()
  return line === undefined ? { ok: false, reason, message } : { ok: false, reason, message, detail: line.slice(0, 300) }
}

/** True when `signal` has aborted (a function: TypeScript keeps no narrowing across the awaits of a spawn). */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/** The error of an aborted command: the signal's reason when it is an `AbortError`, else a new one. */
function gitAbortError(signal?: AbortSignal): Error {
  const reason: unknown = signal?.reason
  if (reason instanceof Error && reason.name === 'AbortError')
    return reason
  return new DOMException('The git command was stopped.', 'AbortError') as Error
}

/** Resolves when the stream closed (end of data, error or destroy). */
function closed(stream: Readable | null): Promise<void> {
  if (stream === null || stream.closed || stream.destroyed)
    return Promise.resolve()
  return new Promise((done) => {
    stream.once('close', () => done())
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
  return new Promise((done, fail) => {
    function onSpawn(): void {
      child.off('error', onError)
      if (child.pid === undefined)
        fail(new Error('git has no process id.'))
      else
        done(child.pid)
    }
    function onError(error: Error): void {
      child.off('spawn', onSpawn)
      fail(error)
    }
    child.once('spawn', onSpawn)
    child.once('error', onError)
  })
}

/** What happened to one spawned git command. */
type ExecOutcome
  = | { readonly kind: 'start-error', readonly code: string | undefined }
    | {
      readonly kind: 'done'
      readonly exitCode: number | null
      readonly signal: NodeJS.Signals | null
      readonly timedOut: boolean
      readonly overflow: boolean
      readonly stdout: Buffer
      readonly stderr: string
    }

interface ExecLimits {
  readonly timeoutMs: number
  readonly maxOutputBytes: number
  readonly killGraceMs: number
  readonly signal?: AbortSignal
}

/** Spawns git once (see the module comment); rejects only with an `AbortError`. */
async function execGit(argv: readonly string[], cwd: string, env: Record<string, string>, limits: ExecLimits): Promise<ExecOutcome> {
  const { signal } = limits
  if (signal?.aborted === true)
    throw gitAbortError(signal)
  let child: ChildProcess
  try {
    child = spawn('git', [...argv], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: !IS_WINDOWS,
      shell: false,
      windowsHide: true,
    })
  }
  catch (error) {
    return { kind: 'start-error', code: errorCode(error) }
  }
  // Later 'error' events (a failed kill) must not crash the process.
  child.on('error', () => {})

  const stdoutChunks: Buffer[] = []
  let stdoutBytes = 0
  let overflow = false
  const stderrChunks: Buffer[] = []
  let stderrBytes = 0
  const pipesClosed = Promise.all([closed(child.stdout), closed(child.stderr)])
  const exited = new Promise<{ code: number | null, signal: NodeJS.Signals | null }>((done) => {
    child.once('exit', (code, exitSignal) => done({ code, signal: exitSignal }))
  })

  let pid: number
  try {
    pid = await started(child)
  }
  catch (error) {
    child.stdout?.destroy()
    child.stderr?.destroy()
    return { kind: 'start-error', code: errorCode(error) }
  }
  if (!IS_WINDOWS)
    trackGroup(pid)

  let killing: Promise<unknown> | null = null
  const stopGroup = (): Promise<unknown> => {
    if (killing === null) {
      if (IS_WINDOWS) {
        child.kill('SIGKILL')
        killing = Promise.resolve(true)
      }
      else {
        killing = killProcessGroup(pid, { graceMs: limits.killGraceMs }).then((gone) => {
          if (gone)
            liveGroups.delete(pid)
          return gone
        })
      }
    }
    return killing
  }

  child.stdout?.on('data', (chunk: Buffer) => {
    if (overflow)
      return
    stdoutBytes += chunk.length
    if (stdoutBytes > limits.maxOutputBytes) {
      overflow = true
      stdoutChunks.length = 0
      void stopGroup()
      return
    }
    stdoutChunks.push(chunk)
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    if (stderrBytes >= GIT_STDERR_MAX_BYTES)
      return
    const take = chunk.subarray(0, GIT_STDERR_MAX_BYTES - stderrBytes)
    stderrChunks.push(take)
    stderrBytes += take.length
  })

  let timedOut = false
  let aborted = false
  const timer = setTimeout(() => {
    timedOut = true
    void stopGroup()
  }, Math.max(0, limits.timeoutMs))
  timer.unref()
  const onAbort = (): void => {
    aborted = true
    void stopGroup()
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  // Aborted while git was starting (the check above ran before the spawn).
  if (isAborted(signal))
    onAbort()

  try {
    const exit = await exited
    clearTimeout(timer)
    // Something git started still holds the pipes or sits in the group: stop it.
    const pipesDone = await within(pipesClosed, PIPE_GRACE_MS)
    if (killing === null && (!pipesDone || (!IS_WINDOWS && groupAlive(pid))))
      void stopGroup()
    if (killing !== null)
      await killing
    else
      liveGroups.delete(pid)
    if (!await within(pipesClosed, PIPE_DRAIN_MS)) {
      child.stdout?.destroy()
      child.stderr?.destroy()
      await pipesClosed
    }
    if (aborted)
      throw gitAbortError(signal)
    return {
      kind: 'done',
      exitCode: exit.code,
      signal: exit.signal,
      timedOut,
      overflow,
      stdout: Buffer.concat(stdoutChunks),
      stderr: Buffer.concat(stderrChunks).toString('utf8'),
    }
  }
  finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

// ---------- the runner ----------

/** A prepared place to run git: the folder, the environment and the driver overrides of its configuration. */
interface GitContext {
  readonly cwd: string
  readonly env: Record<string, string>
  readonly overrides: readonly string[]
  readonly limits: ExecLimits
}

/** The subcommand of an argument list (the first argument that is not an option), for messages. */
function subcommandOf(args: readonly string[]): string {
  return args.find(arg => !arg.startsWith('-')) ?? 'command'
}

/** Maps a finished command onto a result: timeouts, the cap, refusals, "not a repository", exit codes. */
function classify(outcome: Extract<ExecOutcome, { kind: 'done' }>, args: readonly string[], limits: ExecLimits, okExitCodes: readonly number[]): GitRunResult {
  const name = subcommandOf(args)
  if (outcome.timedOut)
    return failure('timeout', `git ${name} did not finish within ${Math.round(limits.timeoutMs / 1000)} s.`)
  if (outcome.overflow)
    return failure('failed', `The output of git ${name} is larger than ${limits.maxOutputBytes} bytes.`)
  const { stderr } = outcome
  if (outcome.exitCode !== 0) {
    if (/detected dubious ownership/i.test(stderr))
      return failure('refused', 'git refused the repository: it is owned by another user (safe.directory is not overridden).', stderr)
    if (/cannot use bare repository/i.test(stderr))
      return failure('refused', 'git refused the repository: the project folder lies inside a bare repository.', stderr)
    if (/not a git repository/i.test(stderr))
      return failure('not-a-repo', 'The project folder is not inside a git work tree.', stderr)
  }
  if (outcome.exitCode === null || !okExitCodes.includes(outcome.exitCode)) {
    const how = outcome.exitCode === null ? `was stopped by ${outcome.signal ?? 'a signal'}` : `failed (exit code ${outcome.exitCode})`
    return failure('failed', `git ${name} ${how}.`, stderr)
  }
  return { ok: true, exitCode: outcome.exitCode, stdout: outcome.stdout, stderr }
}

/** Runs one prepared command; a start error is `git-missing` (`ENOENT` in an existing folder, cached) or `failed`. */
async function runIn(context: GitContext, args: readonly string[], okExitCodes: readonly number[] = [0]): Promise<GitRunResult> {
  const pathValue = context.env.PATH ?? ''
  if (missingCached(pathValue))
    return failure('git-missing', 'git is not installed (not found on PATH).')
  const outcome = await execGit([...GIT_FIXED_ARGS, ...context.overrides, ...args], context.cwd, context.env, context.limits)
  if (outcome.kind === 'done')
    return classify(outcome, args, context.limits, okExitCodes)
  if (outcome.code === 'ENOENT') {
    // ENOENT also means a missing working folder: only an existing one proves that git is missing.
    const folder = await stat(context.cwd).catch(() => null)
    if (folder === null || !folder.isDirectory())
      return failure('failed', 'The working folder of git does not exist.')
    missingUntil.set(pathValue, Date.now() + GIT_MISSING_CACHE_MS)
    return failure('git-missing', 'git is not installed (not found on PATH).')
  }
  return failure('failed', `git could not be started (${outcome.code ?? 'unknown error'}).`)
}

interface PrepareOptions {
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
  readonly parentEnv?: Readonly<Record<string, string | undefined>>
  readonly killGraceMs?: number
}

/**
 * Checks the folders, builds the environment and neutralizes the filter and diff drivers of the configuration git
 * will read in `cwd`; a `GitFailure` when git cannot (or may not) run there.
 */
async function prepare(cwd: string, allowedRoot: string, options: PrepareOptions): Promise<GitContext | GitFailure> {
  if (options.signal?.aborted === true)
    throw gitAbortError(options.signal)
  if (!isAbsolute(cwd) || !isAbsolute(allowedRoot))
    return failure('failed', 'git needs absolute folders.')
  let realCwd: string
  let realRoot: string
  try {
    realCwd = await realpath(cwd)
    realRoot = await realpath(allowedRoot)
  }
  catch {
    return failure('failed', 'The folder is not available.')
  }
  if (!isWithin(realRoot, realCwd))
    return failure('refused', 'The folder is outside the workspace folders.')
  const ceiling = dirname(realRoot)
  // `GIT_CEILING_DIRECTORIES` is a colon-separated list (`;` on Windows): a folder with one cannot be expressed.
  if (ceiling.includes(IS_WINDOWS ? ';' : ':'))
    return failure('refused', 'The path of the workspace folder cannot be passed to git (it contains a path separator).')
  const limits: ExecLimits = {
    timeoutMs: options.timeoutMs ?? LIMITS.gitTimeoutMs,
    maxOutputBytes: Math.min(options.maxOutputBytes ?? LIMITS.gitOutputMaxBytes, LIMITS.gitOutputMaxBytes),
    killGraceMs: options.killGraceMs ?? GIT_KILL_GRACE_MS,
    signal: options.signal,
  }
  const base: GitContext = { cwd: realCwd, env: gitEnvironment(realRoot, options.parentEnv), overrides: [], limits }

  // Exit 1 = no such key at all.
  const listed = await runIn(base, ['config', '-z', '--name-only', '--get-regexp', GIT_DRIVER_KEYS_PATTERN], [0, 1])
  if (!listed.ok) {
    if (listed.reason === 'failed')
      return failure('refused', 'The git configuration cannot be read, so its driver programs cannot be disabled.', listed.detail)
    return listed
  }
  const drivers = parseConfigDrivers(listed.exitCode === 0 ? listed.stdout.toString('utf8') : '')
  if ('unsupported' in drivers)
    return failure('refused', 'The git configuration has a driver whose name cannot be disabled on the command line.')
  if (drivers.filters.length + drivers.diffs.length > GIT_DRIVERS_MAX)
    return failure('refused', `The git configuration has more than ${GIT_DRIVERS_MAX} filter and diff drivers.`)
  return { ...base, overrides: gitDriverOverrides(drivers) }
}

/**
 * Runs `git <GIT_FIXED_ARGS> <driver overrides> <args>` in `cwd` (see the module comment): the configuration's filter
 * and diff drivers are listed and neutralized first (one more git command). `args[0]` must be one of
 * `GIT_ALLOWED_COMMANDS` (read-only plumbing; anything else throws: `diff`, `checkout` and every write are never run).
 * Resolves with the output when git exited with one of `okExitCodes`, else with a `GitFailure` (`git-missing`,
 * `not-a-repo`, `refused`, `timeout`, `failed`); rejects only with an `AbortError` when `signal` aborts. Put every path
 * after `--`, made project-relative with `gitPathOf` (which resolves it through `resolveWorkspacePath`).
 */
export async function runGit(args: readonly string[], options: RunGitOptions): Promise<GitRunResult> {
  const command = args[0] ?? ''
  if (!(GIT_ALLOWED_COMMANDS as readonly string[]).includes(command))
    throw new Error(`runGit: "${command}" is not an allowed git command (${GIT_ALLOWED_COMMANDS.join(', ')}).`)
  const context = await prepare(options.cwd, options.allowedRoot, options)
  if (!('cwd' in context))
    return context
  return runIn(context, args, options.okExitCodes)
}

// ---------- helpers ----------

/** The outermost allowed root that holds `root`, or null. */
function outermostRoot(root: string, roots: readonly string[]): string | null {
  let best: string | null = null
  for (const candidate of roots) {
    if (isAbsolute(candidate) && isWithin(candidate, root) && (best === null || candidate.length < best.length))
      best = candidate
  }
  return best
}

/** A prepared context for the project folder `root` (a canonical realpath that is a directory). */
async function openProject(root: string, options: GitHelperOptions): Promise<GitContext | GitFailure> {
  if (options.signal?.aborted === true)
    throw gitAbortError(options.signal)
  // `rev-parse --show-prefix` prints lines: a folder name with a newline would be ambiguous.
  if (!isAbsolute(root) || root.includes('\n'))
    return failure('failed', 'The project folder cannot be used with git.')
  try {
    if (await realpath(root) !== root || !(await stat(root)).isDirectory())
      return failure('failed', 'The project folder is not available.')
  }
  catch {
    return failure('failed', 'The project folder is not available.')
  }
  const allowedRoot = outermostRoot(root, options.workspaceRoots)
  if (allowedRoot === null)
    return failure('refused', 'The project folder is outside the workspace folders.')
  return prepare(root, allowedRoot, options)
}

/** `rev-parse` + `symbolic-ref` in a prepared project context. */
async function repoInfoIn(context: GitContext): Promise<GitResult<GitRepoInfo>> {
  // Exit 1: `--verify -q` found no commit (an unborn HEAD); the first two lines are still printed.
  const parsed = await runIn(context, ['rev-parse', '--is-inside-work-tree', '--show-prefix', '--verify', '-q', 'HEAD^{commit}'], [0, 1])
  if (!parsed.ok)
    return parsed
  const lines = parsed.stdout.toString('utf8').split('\n')
  if (lines[0] !== 'true')
    return failure('not-a-repo', 'The project folder is not inside a git work tree.')
  const prefix = (lines[1] ?? '').replace(/\/$/, '')
  let head: string | null = null
  if (parsed.exitCode === 0) {
    head = lines[2] ?? ''
    if (!OID_PATTERN.test(head))
      return failure('failed', 'git rev-parse printed an unexpected commit id.')
  }
  // Exit 1: HEAD is detached.
  const symbolic = await runIn(context, ['symbolic-ref', '-q', '--short', 'HEAD'], [0, 1])
  if (!symbolic.ok)
    return symbolic
  const branchLine = symbolic.stdout.toString('utf8').split('\n')[0] ?? ''
  const branch = symbolic.exitCode === 0 && branchLine !== '' ? branchLine : null
  return { ok: true, branch, head, prefix }
}

/**
 * Branch, HEAD and prefix of the repository that holds the project folder `root` (a canonical realpath).
 * `not-a-repo` when no work tree holds it below the allowed root; rejects only with an `AbortError`.
 */
export async function gitRepoInfo(root: string, options: GitHelperOptions): Promise<GitResult<GitRepoInfo>> {
  const context = await openProject(root, options)
  if (!('cwd' in context))
    return context
  return repoInfoIn(context)
}

// ---------- status parsing ----------

const utf8 = new TextDecoder('utf-8', { fatal: true })

/** `buffer` split on NUL bytes (the empty record after the last NUL dropped). */
function splitNul(buffer: Buffer): Buffer[] {
  const records: Buffer[] = []
  let start = 0
  for (;;) {
    const end = buffer.indexOf(0, start)
    if (end === -1)
      break
    records.push(buffer.subarray(start, end))
    start = end + 1
  }
  if (start < buffer.length)
    records.push(buffer.subarray(start))
  return records
}

/** The first `count` space-separated ASCII fields of `record` and the bytes after them (the path), or null. */
function splitFields(record: Buffer, count: number): { fields: string[], rest: Buffer } | null {
  const fields: string[] = []
  let start = 0
  for (let index = 0; index < count; index++) {
    const space = record.indexOf(0x20, start)
    if (space === -1)
      return null
    fields.push(record.subarray(start, space).toString('latin1'))
    start = space + 1
  }
  return { fields, rest: record.subarray(start) }
}

/** A repository path as a project-relative path: null when it is not valid UTF-8 or lies outside the prefix. */
function projectPath(bytes: Buffer, prefix: string): string | null {
  let path: string
  try {
    path = utf8.decode(bytes)
  }
  catch {
    return null
  }
  if (prefix === '')
    return path === '' ? null : path
  if (!path.startsWith(`${prefix}/`) || path.length === prefix.length + 1)
    return null
  return path.slice(prefix.length + 1)
}

function validModes(...modes: string[]): boolean {
  return modes.every(mode => MODE_PATTERN.test(mode))
}

function validOids(...oids: string[]): boolean {
  return oids.every(oid => OID_PATTERN.test(oid))
}

/**
 * Parses the output of `git status --porcelain=v2 -z` (records `1`, `2` + the original path, `u`, `?`; headers and
 * ignored entries are skipped). Repository paths become project paths through `prefix` (no trailing slash); entries
 * outside it and paths that are not valid UTF-8 are dropped. Null when a record is malformed.
 */
export function parseGitStatus(output: Buffer, prefix: string): GitStatusEntry[] | null {
  const records = splitNul(output)
  const entries: GitStatusEntry[] = []
  for (let index = 0; index < records.length; index++) {
    const record = records[index] ?? Buffer.alloc(0)
    const kind = String.fromCharCode(record[0] ?? 0)
    if (record.length < 2 || record[1] !== 0x20) {
      if (record.length === 0)
        continue
      return null
    }
    if (kind === '#' || kind === '!')
      continue
    if (kind === '?') {
      const path = projectPath(record.subarray(2), prefix)
      if (path !== null)
        entries.push({ type: 'untracked', path })
      continue
    }
    if (kind === '1') {
      const split = splitFields(record, 8)
      if (split === null)
        return null
      const [, xy = '', submodule = '', modeHead = '', modeIndex = '', modeWorktree = '', oidHead = '', oidIndex = ''] = split.fields
      if (xy.length !== 2 || !validModes(modeHead, modeIndex, modeWorktree) || !validOids(oidHead, oidIndex))
        return null
      const path = projectPath(split.rest, prefix)
      if (path !== null)
        entries.push({ type: 'ordinary', path, xy, submodule, modeHead, modeIndex, modeWorktree, oidHead, oidIndex })
      continue
    }
    if (kind === '2') {
      const split = splitFields(record, 9)
      const orig = records[index + 1]
      index++
      if (split === null || orig === undefined)
        return null
      const [, xy = '', submodule = '', modeHead = '', modeIndex = '', modeWorktree = '', oidHead = '', oidIndex = '', score = ''] = split.fields
      if (xy.length !== 2 || !validModes(modeHead, modeIndex, modeWorktree) || !validOids(oidHead, oidIndex) || !/^[RC]\d{1,3}$/.test(score))
        return null
      const path = projectPath(split.rest, prefix)
      if (path !== null) {
        const origPath = projectPath(orig, prefix)
        entries.push({ type: 'renamed', path, origPath, xy, submodule, modeHead, modeIndex, modeWorktree, oidHead, oidIndex, score })
      }
      continue
    }
    if (kind === 'u') {
      const split = splitFields(record, 10)
      if (split === null)
        return null
      const [, xy = '', submodule = '', modeStage1 = '', modeStage2 = '', modeStage3 = '', modeWorktree = '', oidStage1 = '', oidStage2 = '', oidStage3 = ''] = split.fields
      if (xy.length !== 2 || !validModes(modeStage1, modeStage2, modeStage3, modeWorktree) || !validOids(oidStage1, oidStage2, oidStage3))
        return null
      const path = projectPath(split.rest, prefix)
      if (path !== null)
        entries.push({ type: 'unmerged', path, xy, submodule, modeStage1, modeStage2, modeStage3, modeWorktree, oidStage1, oidStage2, oidStage3 })
      continue
    }
    return null
  }
  return entries
}

/**
 * `git status --porcelain=v2 -z --untracked-files=all --ignore-submodules=all --find-renames -- .` in the project
 * folder `root`, with the repository info: raw entries (ordinary, renamed with `origPath`, unmerged, untracked) with
 * project-relative paths, sorted by path, at most `LIMITS.gitStatusFilesMax` (`truncated`). Never writes the index.
 */
export async function gitStatus(root: string, options: GitHelperOptions): Promise<GitResult<GitStatusSnapshot>> {
  const context = await openProject(root, options)
  if (!('cwd' in context))
    return context
  const info = await repoInfoIn(context)
  if (!info.ok)
    return info
  const status = await runIn(context, ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignore-submodules=all', '--find-renames', '--', '.'])
  if (!status.ok)
    return status
  const entries = parseGitStatus(status.stdout, info.prefix)
  if (entries === null)
    return failure('failed', 'git status printed an unexpected line.')
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const max = LIMITS.gitStatusFilesMax
  return {
    ok: true,
    branch: info.branch,
    head: info.head,
    prefix: info.prefix,
    entries: entries.slice(0, max),
    truncated: entries.length > max,
  }
}

// ---------- paths ----------

/**
 * A project-relative POSIX path for git: `input` must name an entry below `root` (not the root itself), and the
 * folder that holds it must resolve inside the project through `resolveWorkspacePath` (missing folders allowed: the
 * file may exist only at HEAD). The last component is not followed: git reads a symbolic link as a link.
 * Throws the `validation_error` of the path guard.
 */
export async function gitPathOf(root: string, input: string): Promise<string> {
  if (typeof input !== 'string' || !workspaceToolPathSchema.safeParse(input).success)
    throw workspacePathError(`Expected a path of 1 to ${LIMITS.workspacePathMaxChars} characters without control characters.`)
  const lexical = resolve(root, input)
  if (!isWithin(root, lexical))
    throw workspacePathError(OUTSIDE_PROJECT_MESSAGE)
  const rel = toWorkspaceRel(root, lexical)
  if (rel === '.')
    throw workspacePathError('The path names the project folder, not a file.')
  const slash = rel.lastIndexOf('/')
  // Also checks that the project folder still is its own realpath and that no link leads the folder out of it.
  await resolveWorkspacePath(root, slash === -1 ? '.' : rel.slice(0, slash), { allowMissing: true })
  return rel
}

// ---------- HEAD blobs ----------

/** One record of `ls-tree -l -z`: `<mode> <type> <oid> <size>\t<path>`. */
function parseLsTreeRecord(record: Buffer): { mode: string, type: string, oid: string, size: string, path: Buffer } | null {
  const tab = record.indexOf(0x09)
  if (tab === -1)
    return null
  const fields = record.subarray(0, tab).toString('latin1').trim().split(/ +/)
  if (fields.length !== 4)
    return null
  const [mode = '', type = '', oid = '', size = ''] = fields
  return { mode, type, oid, size, path: record.subarray(tab + 1) }
}

function blobKind(mode: string): GitBlobKind | null {
  if (mode === '120000')
    return 'symlink'
  if (mode === '160000')
    return 'submodule'
  if (/^100[0-7]{3}$/.test(mode))
    return (Number.parseInt(mode, 8) & 0o111) !== 0 ? 'executable' : 'file'
  return null
}

/**
 * The file `path` (project-relative, see `gitPathOf`) at HEAD: `ls-tree -z -l HEAD -- <path>` for mode, id and size,
 * then `cat-file blob <oid>` when the size is at most `maxBytes` (default and maximum `LIMITS.gitOutputMaxBytes`).
 * `blob: null` when HEAD has no such file (also for an unborn HEAD and for a folder); symbolic links (`120000`) carry
 * their target as content; submodules (`160000`) carry no content. Throws the path guard's `validation_error`.
 */
export async function gitHeadBlob(root: string, path: string, options: GitHelperOptions & { readonly maxBytes?: number }): Promise<GitResult<{ blob: GitHeadBlob | null }>> {
  const rel = await gitPathOf(root, path)
  const context = await openProject(root, options)
  if (!('cwd' in context))
    return context
  const listed = await runIn(context, ['ls-tree', '-z', '-l', 'HEAD', '--', rel], [0, 128])
  if (!listed.ok)
    return listed
  if (listed.exitCode !== 0) {
    // 128: no HEAD tree. Only an unborn HEAD (no commit yet) means "absent"; anything else failed.
    const head = await runIn(context, ['rev-parse', '-q', '--verify', 'HEAD^{commit}'], [0, 1])
    if (!head.ok)
      return head
    if (head.exitCode === 1)
      return { ok: true, blob: null }
    return failure('failed', 'git ls-tree failed (exit code 128).', listed.stderr)
  }
  let entry: ReturnType<typeof parseLsTreeRecord> = null
  for (const record of splitNul(listed.stdout)) {
    const parsed = parseLsTreeRecord(record)
    if (parsed === null)
      return failure('failed', 'git ls-tree printed an unexpected line.')
    if (parsed.path.equals(Buffer.from(rel, 'utf8')))
      entry = parsed
  }
  if (entry === null)
    return { ok: true, blob: null }
  const kind = blobKind(entry.mode)
  if (kind === null || !OID_PATTERN.test(entry.oid))
    return { ok: true, blob: null }
  if (kind === 'submodule')
    return { ok: true, blob: { mode: entry.mode, kind, oid: entry.oid, size: null, content: null, tooLarge: false } }
  if (entry.type !== 'blob' || !/^\d+$/.test(entry.size))
    return failure('failed', 'git ls-tree printed an unexpected entry.')
  const size = Number.parseInt(entry.size, 10)
  const maxBytes = Math.min(Math.max(0, options.maxBytes ?? LIMITS.gitOutputMaxBytes), LIMITS.gitOutputMaxBytes)
  if (size > maxBytes)
    return { ok: true, blob: { mode: entry.mode, kind, oid: entry.oid, size, content: null, tooLarge: true } }
  const read = await runIn({ ...context, limits: { ...context.limits, maxOutputBytes: maxBytes } }, ['cat-file', 'blob', entry.oid])
  if (!read.ok)
    return read
  if (read.stdout.length !== size)
    return failure('failed', 'git cat-file returned a blob of an unexpected size.')
  return { ok: true, blob: { mode: entry.mode, kind, oid: entry.oid, size, content: read.stdout, tooLarge: false } }
}

// ---------- attributes ----------

/**
 * The `filter` attribute of each path (`check-attr -z filter -- <paths>`; project-relative, see `gitPathOf`): the
 * driver name (or `set`) when the attribute is set (Git LFS: `lfs`), null when it is unspecified or unset. Keys are
 * the normalized project-relative paths. Throws the path guard's `validation_error`.
 */
export async function gitFilterAttr(root: string, paths: readonly string[], options: GitHelperOptions): Promise<GitResult<{ filters: Map<string, string | null> }>> {
  const rels: string[] = []
  for (const path of paths) {
    const rel = await gitPathOf(root, path)
    if (!rels.includes(rel))
      rels.push(rel)
  }
  const filters = new Map<string, string | null>()
  if (rels.length === 0)
    return { ok: true, filters }
  const context = await openProject(root, options)
  if (!('cwd' in context))
    return context
  for (let start = 0; start < rels.length; start += GIT_ATTR_PATHS_PER_CALL) {
    const chunk = rels.slice(start, start + GIT_ATTR_PATHS_PER_CALL)
    const checked = await runIn(context, ['check-attr', '-z', 'filter', '--', ...chunk])
    if (!checked.ok)
      return checked
    const fields = splitNul(checked.stdout).map(field => field.toString('utf8'))
    if (fields.length !== chunk.length * 3)
      return failure('failed', 'git check-attr printed an unexpected answer.')
    chunk.forEach((rel, index) => {
      const value = fields[index * 3 + 2] ?? 'unspecified'
      filters.set(rel, value === 'unspecified' || value === 'unset' ? null : value)
    })
  }
  return { ok: true, filters }
}
