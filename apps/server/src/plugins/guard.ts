// Guarded execution of plugin code and the per-plugin log (PLUGINS.md 11 "Guards", ARCHITECTURE.md 12). Owner: W1.3
// (W1.3-T3).
//
// `guardCall(...)` runs plugin code with a timeout. A throw or timeout becomes a `plugin_error` (`details: { pluginId,
// phase }`) plus an `error` entry in the plugin log; on timeout the signal passed to the code aborts and the host stops
// waiting (in-process code cannot be killed). Tool and hook calls also stop when the plugin is disabled: they reject
// with "Tool unavailable" instead of waiting for the disposed code.
//
// `createPluginLogStore(...)` keeps the last 500 entries per plugin (message <= 4 KB, data redacted and JSON-only),
// mirrors every entry to the process log with `pluginId`, and publishes it as a `plugin.log` event (at most 20 events
// per second per plugin; the excess is summarized by one "entries not streamed" entry).
import type { LogLevel, PluginErrorPhase, PluginLogEntry } from '@harness-forge/shared'
import type { Logger } from '../logger.ts'
import type { Redactor } from '../security/types.ts'
import type { GuardOptions } from './types.ts'
import { Buffer } from 'node:buffer'
import { HarnessError, isHarnessError } from '@harness-forge/shared'

// ---------- timeouts (PLUGINS.md 11 "Guards") ----------

export const GUARD_TIMEOUTS = {
  /** Module evaluation + `setup`. */
  setup: 10_000,
  dispose: 5000,
  /** Hook handlers, policy functions, `toModelOutput`, `settings.onChange` callbacks. */
  hook: 3000,
  /** Default of tool `execute` (`timeoutMs`, max 600 s). */
  tool: 60_000,
  /** Command `run`. */
  command: 30_000,
  /** esbuild compile / import scan. */
  build: 60_000,
} as const

/** Upper bound of any guard timeout. */
export const GUARD_TIMEOUT_MAX_MS = 600_000

// ---------- errors ----------

/** The cause of a guard timeout (`isGuardTimeout`). */
export class PluginTimeoutError extends Error {
  override readonly name = 'PluginTimeoutError'
  constructor(readonly pluginId: string, readonly phase: PluginErrorPhase, readonly timeoutMs: number, label?: string) {
    super(`Timed out after ${formatDuration(timeoutMs)} (${describeCall(phase, label)}).`)
  }
}

/** True for a guard timeout: the `PluginTimeoutError` itself or a `plugin_error` caused by it. */
export function isGuardTimeout(error: unknown): boolean {
  if (error instanceof PluginTimeoutError)
    return true
  return error instanceof Error && error.cause instanceof PluginTimeoutError
}

/** `1500` -> `1.5 s`, `800` -> `800 ms`. */
export function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${Number((ms / 1000).toFixed(1))} s`
}

function describeCall(phase: PluginErrorPhase, label: string | undefined): string {
  return label ? `${phase} ${label}` : phase
}

/** Maximum length of a `plugin_error` message built from plugin code. */
const ERROR_MESSAGE_MAX_CHARS = 1000

/** A readable message of anything thrown (never empty). */
export function thrownMessage(error: unknown): string {
  let message: string
  if (error instanceof Error)
    message = error.message
  else if (typeof error === 'string')
    message = error
  else if (typeof error === 'number' || typeof error === 'boolean' || typeof error === 'bigint')
    message = String(error)
  else
    message = ''
  message = message.trim()
  if (message === '')
    message = error instanceof Error && error.name && error.name !== 'Error' ? error.name : 'Unknown error'
  return message.length > ERROR_MESSAGE_MAX_CHARS ? `${message.slice(0, ERROR_MESSAGE_MAX_CHARS)}...` : message
}

/** A `plugin_error` with `details: { pluginId, phase }` (+ `extra`). */
export function pluginError(pluginId: string, phase: PluginErrorPhase, message: string, cause?: unknown, extra: Record<string, unknown> = {}): HarnessError {
  return new HarnessError(
    { code: 'plugin_error', message, details: { pluginId, phase, ...extra } },
    cause === undefined ? {} : { cause },
  )
}

// ---------- guard ----------

export interface GuardServices {
  /** Plugin log (`PluginHost.log`). */
  readonly log: (pluginId: string, level: LogLevel, message: string, data?: unknown) => void
  /** Masks secrets in messages that leave the guard. */
  readonly redactText: (text: string) => string
  /** Aborted when the loaded plugin is disposed; undefined when the plugin is not loaded or unknown. */
  readonly lifecycleSignal: (pluginId: string) => AbortSignal | undefined
  /** True when the plugin is known to the host and not active (tool calls fail fast with "Tool unavailable"). */
  readonly isInactive: (pluginId: string) => boolean
}

function clampTimeout(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs))
    return GUARD_TIMEOUTS.tool
  return Math.min(Math.max(Math.floor(timeoutMs), 1), GUARD_TIMEOUT_MAX_MS)
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')
}

function unavailableError(pluginId: string, phase: PluginErrorPhase): HarnessError {
  const message = phase === 'tool'
    ? `Tool unavailable: the plugin "${pluginId}" was disabled.`
    : `The plugin "${pluginId}" was disabled while the call was running.`
  return pluginError(pluginId, phase, message)
}

/** Tool and hook calls end when their plugin is disposed. */
function followsLifecycle(phase: PluginErrorPhase): boolean {
  return phase === 'tool' || phase === 'hook'
}

/**
 * Runs `fn` with a timeout (`options.timeoutMs`, clamped to 1 ms..600 s) and an abort signal. Resolves with its value;
 * a throw or timeout rejects with a `plugin_error` (message: the thrown message, or "Timed out after ...") and logs an
 * `error` entry. An abort of `options.signal` (user stop) rejects with the abort reason and is not logged as a failure.
 */
export function guardCall<T>(
  services: GuardServices,
  pluginId: string,
  fn: (signal: AbortSignal) => T | Promise<T>,
  options: GuardOptions,
): Promise<T> {
  const { phase, label } = options
  const timeoutMs = clampTimeout(options.timeoutMs)
  const external = options.signal
  if (external?.aborted)
    return Promise.reject(abortReason(external))
  const lifecycle = followsLifecycle(phase) ? services.lifecycleSignal(pluginId) : undefined
  if (followsLifecycle(phase) && (lifecycle?.aborted === true || (phase === 'tool' && services.isInactive(pluginId))))
    return Promise.reject(unavailableError(pluginId, phase))

  const controller = new AbortController()
  const signals = [controller.signal, ...(external ? [external] : []), ...(lifecycle ? [lifecycle] : [])]
  const signal = signals.length === 1 ? controller.signal : AbortSignal.any(signals)
  const call = describeCall(phase, label)

  return new Promise<T>((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const cleanup = (): void => {
      settled = true
      if (timer !== undefined)
        clearTimeout(timer)
      external?.removeEventListener('abort', onExternalAbort)
      lifecycle?.removeEventListener('abort', onLifecycleAbort)
    }
    const fail = (error: unknown): void => {
      if (settled)
        return
      cleanup()
      const message = services.redactText(thrownMessage(error))
      services.log(pluginId, 'error', `${call} failed: ${message}`, { phase, label, error })
      reject(pluginError(pluginId, phase, message, error))
    }
    function onExternalAbort(): void {
      if (settled || !external)
        return
      cleanup()
      controller.abort(abortReason(external))
      reject(abortReason(external))
    }
    function onLifecycleAbort(): void {
      if (settled)
        return
      cleanup()
      const error = unavailableError(pluginId, phase)
      controller.abort(error)
      reject(error)
    }

    external?.addEventListener('abort', onExternalAbort, { once: true })
    lifecycle?.addEventListener('abort', onLifecycleAbort, { once: true })
    timer = setTimeout(() => {
      if (settled)
        return
      cleanup()
      const timeout = new PluginTimeoutError(pluginId, phase, timeoutMs, label)
      controller.abort(timeout)
      services.log(pluginId, 'error', timeout.message, { phase, label, timeoutMs })
      reject(pluginError(pluginId, phase, timeout.message, timeout))
    }, timeoutMs)

    let result: T | Promise<T>
    try {
      result = fn(signal)
    }
    catch (error) {
      fail(error)
      return
    }
    Promise.resolve(result).then(
      (value) => {
        if (settled)
          return
        cleanup()
        resolve(value)
      },
      fail,
    )
  })
}

/** Rethrows `error` as is when it is already a `plugin_error` of `pluginId`, else wraps it. */
export function asPluginError(pluginId: string, phase: PluginErrorPhase, error: unknown): HarnessError {
  if (isHarnessError(error) && error.code === 'plugin_error')
    return error
  return pluginError(pluginId, phase, thrownMessage(error), error)
}

// ---------- plugin log ----------

/** Entries kept per plugin. */
export const PLUGIN_LOG_CAPACITY = 500
/** Maximum UTF-8 bytes of an entry message. */
export const PLUGIN_LOG_MESSAGE_MAX_BYTES = 4096
/** Maximum serialized bytes of an entry's `data` (larger data is replaced by a preview). */
export const PLUGIN_LOG_DATA_MAX_BYTES = 16_384
/** `plugin.log` events per second and plugin; the excess is summarized. */
export const PLUGIN_LOG_EVENTS_PER_SECOND = 20

const TRUNCATED = ' [truncated]'

/** Cuts `text` to at most `maxBytes` UTF-8 bytes (on a code point boundary) with a marker. */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes)
    return text
  const budget = maxBytes - Buffer.byteLength(TRUNCATED, 'utf8')
  let bytes = 0
  let end = 0
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8')
    if (bytes + size > budget)
      break
    bytes += size
    end += char.length
  }
  return `${text.slice(0, end)}${TRUNCATED}`
}

export interface PluginLogQuery {
  /** Only entries with `seq > after`. */
  after?: number
  /** At most this many entries (default 200). */
  limit?: number
}

export interface PluginLogStoreOptions {
  readonly logger: Logger
  readonly redactor: Redactor
  /** Publishes a `plugin.log` event. */
  readonly publish: (pluginId: string, entry: PluginLogEntry) => void
  readonly now?: () => number
}

export interface PluginLogStore {
  /** Appends an entry (redacted, capped), mirrors it to the process log and publishes it (rate limited). */
  readonly append: (pluginId: string, level: LogLevel, message: string, data?: unknown) => PluginLogEntry
  /**
   * Entries oldest first. With `after`: the first `limit` entries with `seq > after` (paging forward). Without: the
   * newest `limit` entries.
   */
  readonly entries: (pluginId: string, query?: PluginLogQuery) => PluginLogEntry[]
  /** Drops the buffer and counters of a plugin (uninstall). */
  readonly clear: (pluginId: string) => void
  /** Cancels pending "entries not streamed" timers. */
  readonly stop: () => void
}

interface LogBuffer {
  seq: number
  entries: PluginLogEntry[]
}

interface RateWindow {
  start: number
  sent: number
  dropped: number
  timer: ReturnType<typeof setTimeout> | undefined
}

export function createPluginLogStore(options: PluginLogStoreOptions): PluginLogStore {
  const { logger, redactor, publish } = options
  const now = options.now ?? Date.now
  const buffers = new Map<string, LogBuffer>()
  const windows = new Map<string, RateWindow>()

  function buffer(pluginId: string): LogBuffer {
    let value = buffers.get(pluginId)
    if (!value) {
      value = { seq: 0, entries: [] }
      buffers.set(pluginId, value)
    }
    return value
  }

  function sanitizeData(data: unknown): unknown {
    if (data === undefined)
      return undefined
    let json: string | undefined
    try {
      json = JSON.stringify(redactor.redact(data))
    }
    catch {
      json = undefined
    }
    if (json === undefined)
      return { unserializable: typeof data }
    if (Buffer.byteLength(json, 'utf8') > PLUGIN_LOG_DATA_MAX_BYTES)
      return { truncated: true, preview: truncateUtf8(json, 1024) }
    return JSON.parse(json) as unknown
  }

  function record(pluginId: string, level: LogLevel, message: string, data: unknown): PluginLogEntry {
    const target = buffer(pluginId)
    target.seq += 1
    const entry: PluginLogEntry = {
      seq: target.seq,
      at: now(),
      level,
      message: truncateUtf8(redactor.redactText(message), PLUGIN_LOG_MESSAGE_MAX_BYTES),
    }
    const clean = sanitizeData(data)
    if (clean !== undefined)
      entry.data = clean
    target.entries.push(entry)
    if (target.entries.length > PLUGIN_LOG_CAPACITY)
      target.entries.splice(0, target.entries.length - PLUGIN_LOG_CAPACITY)
    logger.child({ pluginId })[level](entry.message, entry.data === undefined ? undefined : { data: entry.data })
    return entry
  }

  function safePublish(pluginId: string, entry: PluginLogEntry): void {
    try {
      publish(pluginId, entry)
    }
    catch (error) {
      logger.warn('plugin.log publish failed', { pluginId, err: error })
    }
  }

  function flushDropped(pluginId: string, window: RateWindow): void {
    if (window.timer !== undefined) {
      clearTimeout(window.timer)
      window.timer = undefined
    }
    if (window.dropped === 0)
      return
    const count = window.dropped
    window.dropped = 0
    const notice = record(
      pluginId,
      'warn',
      `${count} log ${count === 1 ? 'entry was' : 'entries were'} not streamed live (limit: ${PLUGIN_LOG_EVENTS_PER_SECOND} per second); reload the logs to see them.`,
      undefined,
    )
    safePublish(pluginId, notice)
  }

  function stream(pluginId: string, entry: PluginLogEntry): void {
    const time = now()
    let window = windows.get(pluginId)
    if (!window || time - window.start >= 1000) {
      if (window)
        flushDropped(pluginId, window)
      window = { start: time, sent: 0, dropped: 0, timer: undefined }
      windows.set(pluginId, window)
    }
    if (window.sent < PLUGIN_LOG_EVENTS_PER_SECOND) {
      window.sent += 1
      safePublish(pluginId, entry)
      return
    }
    window.dropped += 1
    if (window.timer === undefined) {
      const current = window
      current.timer = setTimeout(() => {
        current.timer = undefined
        flushDropped(pluginId, current)
      }, Math.max(1, 1000 - (time - current.start)))
      current.timer.unref?.()
    }
  }

  return {
    append: (pluginId, level, message, data) => {
      const entry = record(pluginId, level, typeof message === 'string' ? message : String(message), data)
      stream(pluginId, entry)
      return entry
    },
    entries: (pluginId, query = {}) => {
      const all = buffers.get(pluginId)?.entries ?? []
      const limit = Math.max(1, Math.min(query.limit ?? 200, PLUGIN_LOG_CAPACITY))
      if (query.after === undefined)
        return all.slice(-limit)
      const after = query.after
      return all.filter(entry => entry.seq > after).slice(0, limit)
    },
    clear: (pluginId) => {
      buffers.delete(pluginId)
      const window = windows.get(pluginId)
      if (window?.timer !== undefined)
        clearTimeout(window.timer)
      windows.delete(pluginId)
    },
    stop: () => {
      for (const window of windows.values()) {
        if (window.timer !== undefined)
          clearTimeout(window.timer)
        window.timer = undefined
      }
    },
  }
}
