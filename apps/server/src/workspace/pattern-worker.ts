// Pattern matching of `find_files` and `search_files` off the main thread (Phase 7, ADR-032, ARCHITECTURE.md 6.13 /
// 10.9 "ReDoS"). A model-supplied regular expression or glob can backtrack for minutes on a crafted line or file name,
// and the server is a single process: the patterns are compiled on the main thread only to check their syntax, and
// every match runs in an eval `Worker` (`resourceLimits` 256 MB) that is terminated when the call ends, when the run is
// aborted, or after `SEARCH_WORKER_TIMEOUT_MS` (20 s) with "The search timed out — use a simpler pattern or a narrower
// path." The Worker never touches the filesystem: the main thread walks and reads (through the frozen path guard) and
// sends it paths and file texts.
//
// Globs (`compileGlob`): `picomatch` with dot files included; a pattern without `/` matches the file name at any depth
// (`*.ts`), else the path relative to the searched folder; a leading `./` or `/` is dropped.
// Regular expressions (`compileSearchRegex`): JavaScript syntax, with the `u` flag when the pattern allows it (else
// without), `i` when `case_sensitive` is false; `literal` escapes the pattern. Lines are matched one by one (a trailing
// `\r` dropped), and a match reports its 1-based line and the line cut at `WORKSPACE_LIMITS.lineMaxChars`.
import type { SearchFilesMatch } from '@harness-forge/shared'
import { Worker } from 'node:worker_threads'
import { HarnessError, WORKSPACE_LIMITS } from '@harness-forge/shared'
import picomatch from 'picomatch'

/** The Worker is terminated after this long. */
export const SEARCH_WORKER_TIMEOUT_MS = 20_000
/** `resourceLimits.maxOldGenerationSizeMb` of the Worker. */
export const SEARCH_WORKER_MEMORY_MB = 256

export const SEARCH_TIMEOUT_MESSAGE = 'The search timed out — use a simpler pattern or a narrower path.'
export const SEARCH_OUT_OF_MEMORY_MESSAGE = 'The search ran out of memory — use a simpler pattern or a narrower path.'
const WORKER_STOPPED_MESSAGE = 'The search worker stopped unexpectedly.'

/** A glob compiled by `picomatch` (sent to the Worker as source and flags). */
export interface CompiledGlob {
  readonly source: string
  readonly flags: string
  /** Match the file name only (the pattern has no `/`). */
  readonly basename: boolean
}

/** A search regular expression (sent to the Worker as source and flags). */
export interface CompiledRegex {
  readonly source: string
  readonly flags: string
}

/** A `validation_error` on an input field (the message is safe to show to the model). */
export function patternError(field: string, message: string): HarnessError {
  return new HarnessError({
    code: 'validation_error',
    message,
    details: { issues: [{ path: [field], message, code: 'custom' }] },
  })
}

/** Compiles a `find_files` / `search_files` glob (see the module comment). */
export function compileGlob(pattern: string, field = 'pattern'): CompiledGlob {
  let glob = pattern
  while (glob.startsWith('./'))
    glob = glob.slice(2)
  while (glob.startsWith('/'))
    glob = glob.slice(1)
  if (glob === '')
    throw patternError(field, 'The glob pattern is empty.')
  let regex: RegExp
  try {
    regex = picomatch.makeRe(glob, { dot: true, windows: false })
  }
  catch (error) {
    throw patternError(field, `Invalid glob pattern: ${error instanceof Error ? error.message : String(error)}`)
  }
  return { source: regex.source, flags: regex.flags, basename: !glob.includes('/') }
}

/** `text` with every regular expression syntax character escaped (valid with and without the `u` flag). */
export function escapeRegex(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&')
}

export interface SearchRegexOptions {
  literal?: boolean
  /** Default true. */
  caseSensitive?: boolean
}

function tryRegExp(source: string, flags: string): RegExp | Error {
  try {
    return new RegExp(source, flags)
  }
  catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}

/** Checks the syntax of a search pattern on the main thread and returns what the Worker compiles. */
export function compileSearchRegex(pattern: string, options: SearchRegexOptions = {}): CompiledRegex {
  const source = options.literal === true ? escapeRegex(pattern) : pattern
  const base = options.caseSensitive === false ? 'i' : ''
  if (tryRegExp(source, `${base}u`) instanceof RegExp)
    return { source, flags: `${base}u` }
  const plain = tryRegExp(source, base)
  if (plain instanceof RegExp)
    return { source, flags: base }
  throw patternError('pattern', `Invalid regular expression: ${plain.message}`)
}

/** The Worker program (plain CommonJS, evaluated with `eval: true`; no filesystem access). */
const WORKER_SOURCE = `'use strict'
const { parentPort, workerData } = require('node:worker_threads')
const glob = workerData.glob ? { re: new RegExp(workerData.glob.source, workerData.glob.flags), basename: workerData.glob.basename } : null
const regex = workerData.regex ? new RegExp(workerData.regex.source, workerData.regex.flags) : null
const lineMaxChars = workerData.lineMaxChars
function cut(line) {
  if (line.length <= lineMaxChars) return line
  let end = lineMaxChars
  const code = line.charCodeAt(end - 1)
  if (code >= 0xD800 && code <= 0xDBFF) end--
  return line.slice(0, end)
}
function globMatches(path) {
  if (glob === null) return true
  const subject = glob.basename ? path.slice(path.lastIndexOf('/') + 1) : path
  return glob.re.test(subject)
}
function searchText(path, text, matches, limit) {
  if (text === '') return false
  const body = text.endsWith('\\n') ? text.slice(0, -1) : text
  let start = 0
  let line = 0
  for (;;) {
    const newline = body.indexOf('\\n', start)
    const end = newline === -1 ? body.length : newline
    line++
    let value = body.slice(start, end)
    if (value.endsWith('\\r')) value = value.slice(0, -1)
    if (regex.test(value)) {
      matches.push({ path, line, text: cut(value) })
      if (matches.length >= limit) return true
    }
    if (newline === -1) return false
    start = newline + 1
  }
}
parentPort.on('message', (message) => {
  if (message.type === 'paths') {
    const keep = []
    for (let index = 0; index < message.paths.length; index++) {
      if (globMatches(message.paths[index])) keep.push(index)
    }
    parentPort.postMessage({ id: message.id, keep })
    return
  }
  if (message.type === 'texts') {
    const matches = []
    for (const file of message.files) {
      if (searchText(file.path, file.text, matches, message.limit)) break
    }
    parentPort.postMessage({ id: message.id, matches })
  }
})
`

export interface PatternWorkerOptions {
  glob?: CompiledGlob | null
  regex?: CompiledRegex | null
  /** Default `SEARCH_WORKER_TIMEOUT_MS`: the whole life of the Worker. */
  timeoutMs?: number
  signal?: AbortSignal
}

/** A file text sent to the Worker. */
export interface PatternWorkerText {
  path: string
  text: string
}

/** A running pattern Worker; `close()` terminates it (always call it). */
export interface PatternWorker {
  /** Indexes of the paths the glob matches (all of them without a glob). */
  filterPaths: (paths: readonly string[]) => Promise<number[]>
  /** Matching lines of the texts, in order, at most `limit`. */
  searchTexts: (files: readonly PatternWorkerText[], limit: number) => Promise<SearchFilesMatch[]>
  close: () => Promise<void>
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

/** Starts the Worker for one tool call (see the module comment). */
export function startPatternWorker(options: PatternWorkerOptions): PatternWorker {
  const { signal } = options
  signal?.throwIfAborted()
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: { glob: options.glob ?? null, regex: options.regex ?? null, lineMaxChars: WORKSPACE_LIMITS.lineMaxChars },
    resourceLimits: { maxOldGenerationSizeMb: SEARCH_WORKER_MEMORY_MB },
    stdout: false,
    stderr: false,
  })
  const pending = new Map<number, PendingRequest>()
  let nextId = 1
  let failure: unknown = null
  let closed = false

  const fail = (error: unknown): void => {
    if (failure !== null)
      return
    failure = error
    for (const request of pending.values())
      request.reject(error)
    pending.clear()
    cleanup()
    void worker.terminate().catch(() => {})
  }

  const timer = setTimeout(() => fail(patternError('pattern', SEARCH_TIMEOUT_MESSAGE)), options.timeoutMs ?? SEARCH_WORKER_TIMEOUT_MS)
  const onAbort = (): void => fail(signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'))
  signal?.addEventListener('abort', onAbort, { once: true })

  function cleanup(): void {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }

  worker.on('message', (message: { id: number }) => {
    const request = pending.get(message.id)
    if (request === undefined)
      return
    pending.delete(message.id)
    request.resolve(message)
  })
  worker.on('error', (error: Error & { code?: string }) => {
    fail(error.code === 'ERR_WORKER_OUT_OF_MEMORY'
      ? patternError('pattern', SEARCH_OUT_OF_MEMORY_MESSAGE)
      : new HarnessError({ code: 'internal_error', message: WORKER_STOPPED_MESSAGE }, { cause: error }))
  })
  worker.on('exit', () => {
    if (!closed)
      fail(new HarnessError({ code: 'internal_error', message: WORKER_STOPPED_MESSAGE }))
  })

  function request<T>(message: Record<string, unknown>): Promise<T> {
    if (failure !== null)
      return Promise.reject(failure)
    if (closed)
      return Promise.reject(new HarnessError({ code: 'internal_error', message: WORKER_STOPPED_MESSAGE }))
    const id = nextId++
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      worker.postMessage({ ...message, id })
    })
  }

  return {
    async filterPaths(paths) {
      const reply = await request<{ keep: number[] }>({ type: 'paths', paths })
      return reply.keep
    },
    async searchTexts(files, limit) {
      const reply = await request<{ matches: SearchFilesMatch[] }>({ type: 'texts', files, limit })
      return reply.matches
    },
    async close() {
      if (closed)
        return
      closed = true
      cleanup()
      for (const pendingRequest of pending.values())
        pendingRequest.reject(new HarnessError({ code: 'internal_error', message: WORKER_STOPPED_MESSAGE }))
      pending.clear()
      await worker.terminate().catch(() => {})
    },
  }
}
