// stdio transport of MCP servers (PLUGINS.md 5 "stdio details"): the child is spawned without a shell, with a minimal
// inherited environment plus the declared `env` (`HF_*` variables and provider keys are never inherited), stdin/stdout
// carry newline-delimited JSON-RPC, and stderr lines go to the owning plugin's log (the stock
// `Experimental_StdioMCPTransport` inherits stderr and hides the child). Closing ends stdin, sends SIGTERM and SIGKILL
// after a grace period. On Windows, where `.cmd` shims (`npx`) need `cross-spawn`, the stock transport is used instead
// (stderr ignored).
//
// Process group (Phase 11, ADR-050, C38-T2; FROZEN after Gate P11-0b): on POSIX every server runs in its own process
// group (`detached: true`, `processGroup` default true), registered with the shell runner's exit handler
// (`trackProcessGroup`). The whole group is stopped with `killProcessGroup` (SIGTERM, SIGKILL after the grace period,
// repeated until it is gone) when the transport closes (a removed or disabled server, the manager's stop at shutdown,
// a reconnect), when the start fails (the client closes the transport after a failed or timed-out `initialize`) and
// when the server process exits by itself (whatever it started is stopped with it), so a grandchild never outlives its
// server. The spawn is still the same argument array without a shell; `processGroup: false` keeps the v1.6 behavior
// (signals to the child only).
import type { JSONRPCMessage, MCPTransport } from '@ai-sdk/mcp'
import type { Buffer } from 'node:buffer'
import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import process from 'node:process'
import { StringDecoder } from 'node:string_decoder'
import { validateJSONRPCMessage } from '@ai-sdk/mcp'
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio'
import { killProcessGroup, trackProcessGroup } from '../workspace/shell.ts'

/** Variables a stdio server inherits from the server process (same lists as `@ai-sdk/mcp`). */
const INHERITED_ENV_POSIX = ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER'] as const
const INHERITED_ENV_WINDOWS = [
  'APPDATA',
  'HOMEDRIVE',
  'HOMEPATH',
  'LOCALAPPDATA',
  'PATH',
  'PROCESSOR_ARCHITECTURE',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'USERNAME',
  'USERPROFILE',
] as const

/** Longest stdout line (one JSON-RPC message) accepted before the process is considered broken. */
export const STDIO_MAX_LINE_BYTES = 16 * 1024 * 1024
/** Longest stderr line forwarded to the log (longer lines are cut). */
export const STDERR_LINE_MAX_CHARS = 1000
/** Grace period between SIGTERM and SIGKILL. */
export const STDIO_KILL_GRACE_MS = 2000
/** How long the pipes may stay open after the process group is gone (a process that left it) before they are closed. */
const STDIO_PIPE_DRAIN_MS = 200

export interface StdioExit {
  code: number | null
  signal: NodeJS.Signals | null
}

export interface StdioServerOptions {
  command: string
  args: readonly string[]
  /** Declared (resolved) variables; merged over the minimal inherited set. */
  env: Readonly<Record<string, string>>
  cwd?: string
  /** One stderr line (without the newline), capped at `STDERR_LINE_MAX_CHARS`. */
  onStderr?: (line: string) => void
  /** JSON-RPC notifications from the server (not forwarded to the client, which rejects them). */
  onNotification?: (method: string, params: unknown) => void
  /** The process ended while the transport was open (not called after `close()`). */
  onExit?: (exit: StdioExit) => void
  /** Default `STDIO_KILL_GRACE_MS`. */
  killGraceMs?: number
  /** Default `process.env` (tests). */
  parentEnv?: Readonly<Record<string, string | undefined>>
  /** Default `process.platform` (tests). */
  platform?: NodeJS.Platform
  /**
   * Run the server in its own process group and stop the whole group (Phase 11; see the module comment). Default true;
   * ignored on Windows.
   */
  processGroup?: boolean
}

/** The environment of a stdio server: the inherited minimal set (values starting with `()` skipped) + `declared`. */
export function stdioEnvironment(
  declared: Readonly<Record<string, string>>,
  parentEnv: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const windows = platform === 'win32'
  const env: Record<string, string> = { ...declared }
  const declaredKeys = new Set(Object.keys(declared).map(key => (windows ? key.toUpperCase() : key)))
  for (const key of windows ? INHERITED_ENV_WINDOWS : INHERITED_ENV_POSIX) {
    if (declaredKeys.has(key))
      continue
    const value = parentEnv[key]
    if (value === undefined || value.startsWith('()'))
      continue
    env[key] = value
  }
  return env
}

/** Splits a text stream into lines; `onLine` receives each complete line. */
class LineSplitter {
  readonly #decoder = new StringDecoder('utf8')
  #pending = ''

  constructor(private readonly onLine: (line: string) => void, private readonly maxChars: number, private readonly onOverflow: () => void) {}

  push(chunk: Buffer | string): void {
    this.#pending += typeof chunk === 'string' ? chunk : this.#decoder.write(chunk)
    let index = this.#pending.indexOf('\n')
    while (index !== -1) {
      const line = this.#pending.slice(0, index).replace(/\r$/, '')
      this.#pending = this.#pending.slice(index + 1)
      this.onLine(line)
      index = this.#pending.indexOf('\n')
    }
    if (this.#pending.length > this.maxChars) {
      this.#pending = ''
      this.onOverflow()
    }
  }

  flush(): void {
    const rest = (this.#pending + this.#decoder.end()).replace(/\r$/, '')
    this.#pending = ''
    if (rest !== '')
      this.onLine(rest)
  }
}

/** Resolves true when `promise` settles within `ms`, false otherwise (the timer is cleared either way). */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(resolve, ms, false)
      }),
    ])
  }
  finally {
    clearTimeout(timer)
  }
}

/** An `MCPTransport` over a child process spawned with `node:child_process` (no shell). */
export class ChildProcessMcpTransport implements MCPTransport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void

  readonly #options: StdioServerOptions
  /** The server runs in its own process group (POSIX, `processGroup` not false). */
  readonly #processGroup: boolean
  #child: ChildProcess | null = null
  #closing = false
  #exited: Promise<void> | null = null
  /** The process group id (= the server's pid) while the group may still have members. */
  #group: number | null = null
  #groupKill: Promise<void> | null = null

  constructor(options: StdioServerOptions) {
    this.#options = options
    this.#processGroup = options.processGroup !== false && (options.platform ?? process.platform) !== 'win32'
  }

  /** Process id of the running child (tests), or null. */
  get pid(): number | null {
    return this.#child?.pid ?? null
  }

  /** The process group of the server while it may still have members (tests), or null (none, or gone). */
  get processGroupId(): number | null {
    return this.#group
  }

  /** Stops the whole process group once (SIGTERM, then SIGKILL after the grace period); a no-op without a group. */
  #killGroup(): Promise<void> {
    const group = this.#group
    if (group === null)
      return Promise.resolve()
    this.#groupKill ??= killProcessGroup(group, { graceMs: this.#options.killGraceMs ?? STDIO_KILL_GRACE_MS }).then((gone) => {
      if (gone && this.#group === group)
        this.#group = null
    })
    return this.#groupKill
  }

  start(): Promise<void> {
    if (this.#child !== null || this.#closing)
      return Promise.reject(new Error('The stdio transport was already started.'))
    const options = this.#options
    return new Promise<void>((resolve, reject) => {
      let spawned = false
      let child: ChildProcess
      try {
        child = spawn(options.command, [...options.args], {
          cwd: options.cwd,
          env: stdioEnvironment(options.env, options.parentEnv, options.platform),
          stdio: ['pipe', 'pipe', 'pipe'],
          // Phase 11: the leader of its own process group, so one signal reaches everything the server started.
          detached: this.#processGroup,
          shell: false,
          windowsHide: true,
        })
      }
      catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
        return
      }
      this.#child = child
      this.#exited = new Promise<void>((done) => {
        child.once('close', () => done())
      })
      // The pid is known as soon as the process exists (before 'spawn'), so a close() racing the start stops it too.
      if (this.#processGroup && child.pid !== undefined) {
        this.#group = child.pid
        trackProcessGroup(child.pid)
      }

      const stdout = new LineSplitter(line => this.#onStdoutLine(line), STDIO_MAX_LINE_BYTES, () => {
        this.onerror?.(new Error('The MCP server wrote a line longer than 16 MB to stdout.'))
        child.kill('SIGKILL')
      })
      const stderr = new LineSplitter((line) => {
        if (line.trim() !== '')
          options.onStderr?.(line.length > STDERR_LINE_MAX_CHARS ? `${line.slice(0, STDERR_LINE_MAX_CHARS)}...` : line)
      }, 64 * 1024, () => options.onStderr?.('(a stderr line longer than 64 KB was skipped)'))

      child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk))
      child.stdout?.on('error', error => this.onerror?.(error))
      child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))
      child.stderr?.on('end', () => stderr.flush())
      child.stdin?.on('error', error => this.onerror?.(error))

      child.once('spawn', () => {
        spawned = true
        resolve()
      })
      // The server is gone (it exited, crashed or was killed): whatever it started is stopped with it. Its pipes then
      // close, and 'close' follows.
      child.once('exit', () => {
        void this.#killGroup()
      })
      child.once('error', (error) => {
        if (!spawned) {
          this.#child = null
          reject(error)
          return
        }
        this.onerror?.(error)
      })
      child.once('close', (code, signal) => {
        stdout.flush()
        this.#child = null
        if (spawned && !this.#closing)
          options.onExit?.({ code, signal })
        if (spawned)
          this.onclose?.()
      })
    })
  }

  #onStdoutLine(line: string): void {
    if (line.trim() === '')
      return
    let message: JSONRPCMessage
    try {
      message = validateJSONRPCMessage(JSON.parse(line) as unknown)
    }
    catch (error) {
      this.onerror?.(new Error(`The MCP server wrote a line that is not JSON-RPC: ${error instanceof Error ? error.message : String(error)}`))
      return
    }
    if ('method' in message && !('id' in message)) {
      this.#options.onNotification?.(message.method, 'params' in message ? message.params : undefined)
      return
    }
    this.onmessage?.(message)
  }

  send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.#child?.stdin
    if (!stdin || stdin.destroyed || !stdin.writable)
      return Promise.reject(new Error('The MCP server process is not running.'))
    return new Promise<void>((resolve, reject) => {
      stdin.write(`${JSON.stringify(message)}\n`, error => (error ? reject(error) : resolve()))
    })
  }

  async close(): Promise<void> {
    this.#closing = true
    const child = this.#child
    const exited = this.#exited
    if (this.#processGroup) {
      child?.stdin?.end()
      // The group outlives its leader while a member is left (a grandchild): it is stopped whether or not the server
      // already exited.
      await this.#killGroup()
      if (child === null || exited === null || await settlesWithin(exited, STDIO_PIPE_DRAIN_MS))
        return
      // A process that left the group (setsid) may still hold the pipes: close them by force.
      child.stdin?.destroy()
      child.stdout?.destroy()
      child.stderr?.destroy()
      await settlesWithin(exited, STDIO_PIPE_DRAIN_MS)
      return
    }
    if (child === null || exited === null)
      return
    child.stdin?.end()
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGTERM')
    const grace = this.#options.killGraceMs ?? STDIO_KILL_GRACE_MS
    let timer: NodeJS.Timeout | undefined
    const timedOut = await Promise.race([
      exited.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(resolve, grace, true)
      }),
    ])
    clearTimeout(timer)
    if (timedOut) {
      child.kill('SIGKILL')
      await exited
    }
  }
}

/**
 * The transport of a stdio MCP server: `ChildProcessMcpTransport`, or on Windows the stock
 * `Experimental_StdioMCPTransport` (which resolves `.cmd` shims) with stderr ignored.
 */
export function createStdioTransport(options: StdioServerOptions): MCPTransport {
  if ((options.platform ?? process.platform) === 'win32') {
    return new Experimental_StdioMCPTransport({
      command: options.command,
      args: [...options.args],
      env: { ...options.env },
      cwd: options.cwd,
      stderr: 'ignore',
    }) as unknown as MCPTransport
  }
  return new ChildProcessMcpTransport(options)
}
