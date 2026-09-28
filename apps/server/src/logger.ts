// Structured JSON-lines logger (ARCHITECTURE.md 12): `{ time, level, msg, reqId?, pluginId?, chatId?, ...fields }`.
// Every record passes through the redactor: messages via `redactText`, fields via `redact` (sensitive keys masked).
import type { LogLevel } from '@harness-forge/shared'
import type { Redactor } from './security/types.ts'
import process from 'node:process'
import { createRedactor } from './security/redact.ts'

export type { LogLevel } from '@harness-forge/shared'

/** Log levels from the most to the least verbose. */
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const satisfies readonly LogLevel[]

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

/** Structured fields of a record (`reqId`, `pluginId`, `chatId`, `err`, ...). */
export type LogFields = Record<string, unknown>

/** One emitted record (already redacted). */
export interface LogRecord {
  /** ISO 8601 timestamp. */
  time: string
  level: LogLevel
  msg: string
  [field: string]: unknown
}

/** Receives every record at or above the logger level. */
export type LogSink = (record: LogRecord) => void

/** Server logger; compatible with the plugin SDK `Logger` (`ctx.logger` wraps a child of it). */
export interface Logger {
  readonly level: LogLevel
  readonly debug: (msg: string, fields?: LogFields) => void
  readonly info: (msg: string, fields?: LogFields) => void
  readonly warn: (msg: string, fields?: LogFields) => void
  readonly error: (msg: string, fields?: LogFields) => void
  /** A logger whose records carry `bindings` (e.g. `{ reqId }`, `{ pluginId }`). */
  readonly child: (bindings: LogFields) => Logger
  readonly isLevelEnabled: (level: LogLevel) => boolean
}

export interface LoggerOptions {
  /** Minimum level; default `info`. */
  level?: LogLevel
  /** Default: one JSON line per record on stdout. */
  sink?: LogSink
  /** Default: a fresh redactor (pass the app redactor so registered secrets are masked). */
  redactor?: Redactor
  /** Fields added to every record. */
  bindings?: LogFields
}

/** Writes one JSON line per record to stdout. */
export function stdoutSink(record: LogRecord): void {
  let line: string
  try {
    line = JSON.stringify(record)
  }
  catch {
    line = JSON.stringify({ time: record.time, level: record.level, msg: record.msg, logError: 'unserializable fields' })
  }
  process.stdout.write(`${line}\n`)
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info'
  const sink = options.sink ?? stdoutSink
  const redactor = options.redactor ?? createRedactor()
  return buildLogger(level, sink, redactor, options.bindings ?? {})
}

function buildLogger(level: LogLevel, sink: LogSink, redactor: Redactor, bindings: LogFields): Logger {
  const threshold = LEVEL_RANK[level]

  function write(recordLevel: LogLevel, msg: string, fields?: LogFields): void {
    if (LEVEL_RANK[recordLevel] < threshold)
      return
    const data = redactor.redact({ ...bindings, ...fields }) as LogFields
    const record: LogRecord = { time: new Date().toISOString(), level: recordLevel, msg: redactor.redactText(msg) }
    for (const [key, value] of Object.entries(data)) {
      if (key !== 'time' && key !== 'level' && key !== 'msg' && value !== undefined)
        record[key] = value
    }
    try {
      sink(record)
    }
    catch {
      // A failing sink must never break the caller.
    }
  }

  return {
    level,
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
    child: extra => buildLogger(level, sink, redactor, { ...bindings, ...extra }),
    isLevelEnabled: candidate => LEVEL_RANK[candidate] >= threshold,
  }
}

/** A logger that keeps records in memory (tests assert on `records`). */
export interface MemoryLogger {
  logger: Logger
  records: LogRecord[]
  /** Every record serialized as one string (for "never logged" assertions). */
  text: () => string
}

export function createMemoryLogger(options: Omit<LoggerOptions, 'sink'> = {}): MemoryLogger {
  const records: LogRecord[] = []
  const logger = createLogger({ level: 'debug', ...options, sink: record => records.push(record) })
  return { logger, records, text: () => records.map(record => JSON.stringify(record)).join('\n') }
}

/** A logger that drops everything. */
export function createSilentLogger(): Logger {
  return createLogger({ level: 'error', sink: () => {} })
}
