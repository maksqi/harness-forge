// Hook transcripts (Phase 12, ADR-057; ARCHITECTURE.md 6.37 "Transcripts"). Owner: W12.5.
//
// The payload field `transcript_path` of a hook = `<dataDir>/transcripts/<chatId>.jsonl`: the chat's active path as a
// Claude Code-compatible JSON Lines file, written LAZILY by the snapshot (`snapshot.run`, before the payload is built)
// only when a matching command or prompt hook will run, and rebuilt only when the chat's leaf (or its update time, or
// the hook's working folder) changed since the last write. The folder is created with mode 0700, each file is written
// to a temporary file (mode 0600, exclusive) and renamed over the transcript.
//
// Lines (one per message, a Claude Code subset): `{ type: 'user' | 'assistant', uuid (the message id), parentUuid (the
// previous line, null first), sessionId (the chat id), timestamp (ISO, the message's `startedAt`), cwd, isSidechain:
// false, userType: 'external', version: 'harness-forge/<version>', message: { role, content } }`; `content` holds text
// blocks and, for assistant messages, `tool_use` blocks (`{ id, name (the Claude Code name: shell → Bash), input }`);
// the results of a reply's tool calls follow it as one user line (`uuid` = `<message id>:tool-results`) of `tool_result`
// blocks (`{ tool_use_id, content, is_error? }`, at most `LIMITS.transcriptToolResultBytes` each). Reasoning, files,
// sources, step markers and every `data-*` part (hook records included) are left out; a text or a tool input larger
// than `LIMITS.transcriptPartBytes` is cut; when the file would exceed `LIMITS.transcriptBytesMax` the oldest lines are
// dropped first (the first kept line gets `parentUuid: null`).
//
// Removed on `chat.deleted` (`remove`, also for every chat of a delete-all) and by a sweep of orphaned files (a chat
// that no longer exists) at the first use after a start. Never in a backup (the backup writer lists its files
// explicitly). Any failure answers null: the payload then has no `transcript_path`, and the hook runs anyway. Nothing
// here logs a line, a text or a path below the data folder at `info`.
import type { HarnessUIMessage } from '@harness-forge/shared'
import type { Logger } from '../../logger.ts'
import type { ChatsService } from '../chats/types.ts'
import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, open, readdir, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { claudeToolName, LIMITS } from '@harness-forge/shared'
import { appVersion } from '../../paths.ts'

/** The file name suffix of a transcript. */
export const TRANSCRIPT_SUFFIX = '.jsonl'
/** A chat id that may become a file name (uuidv7; anything else never gets a transcript). */
const CHAT_FILE_ID = /^[\w-]{1,64}$/
/** Chats whose last written state is remembered. */
const KNOWN_CHATS_MAX = 500
const TOOL_RESULTS_SUFFIX = ':tool-results'

/** What the writer needs (the hook service passes its deps). */
export interface TranscriptWriterOptions {
  /** `<dataDir>/transcripts` (`env.paths.transcripts`). */
  readonly dir: string
  readonly chats: Pick<ChatsService, 'find' | 'listPath' | 'allIds'>
  readonly logger: Logger
  /** `harness-forge/<version>` of every line (default from `appVersion()`). */
  readonly version?: string
  /** Clock of lines without a start time (epoch ms; default `Date.now`). */
  readonly now?: () => number
}

export interface TranscriptWriter {
  /**
   * The transcript of `chatId` as of now, written when needed (see the module comment), for a hook that runs in `cwd`;
   * null when the chat is gone or the file could not be written. Rejects only when `signal` aborts.
   */
  readonly ensure: (chatId: string, cwd: string, signal?: AbortSignal) => Promise<string | null>
  /** Removes the transcript of a deleted chat (and forgets it). Never rejects. */
  readonly remove: (chatId: string) => Promise<void>
  /** The path a chat's transcript has (whether it exists or not); null for an id that cannot be a file name. */
  readonly pathOf: (chatId: string) => string | null
  /** Stops writing (later calls answer null) and waits for the writes in flight. Idempotent. */
  readonly stop: () => Promise<void>
}

/** One content block of a line. */
type Block
  = | { readonly type: 'text', readonly text: string }
    | { readonly type: 'tool_use', readonly id: string, readonly name: string, readonly input: unknown }
    | { readonly type: 'tool_result', readonly tool_use_id: string, readonly content: string, readonly is_error?: true }

interface DraftLine {
  readonly type: 'user' | 'assistant'
  readonly uuid: string
  readonly timestamp: string
  readonly role: 'user' | 'assistant'
  readonly content: readonly Block[]
}

type LoosePart = Record<string, unknown> & { readonly type: string }

function loose(part: unknown): LoosePart | null {
  return typeof part === 'object' && part !== null && typeof (part as { type?: unknown }).type === 'string' ? part as LoosePart : null
}

/** `text` cut to at most `maxBytes` UTF-8 bytes (never inside a character). */
export function cutUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= maxBytes)
    return text
  let end = Math.max(0, maxBytes)
  while (end > 0 && ((bytes[end] ?? 0) & 0xC0) === 0x80)
    end -= 1
  return bytes.subarray(0, end).toString('utf8')
}

/** A tool input as JSON within the part cap; an input too large becomes a short object that says so. */
function cappedInput(input: unknown): unknown {
  let json: string | undefined
  try {
    json = JSON.stringify(input ?? {})
  }
  catch {
    return {}
  }
  if (json === undefined)
    return {}
  if (Buffer.byteLength(json, 'utf8') <= LIMITS.transcriptPartBytes)
    return input ?? {}
  return { truncated: true, preview: cutUtf8(json, Math.max(0, LIMITS.transcriptPartBytes - 64)) }
}

/** A tool result as text within the result cap. */
function resultText(value: unknown): string {
  let text: string
  if (typeof value === 'string') {
    text = value
  }
  else {
    try {
      text = JSON.stringify(value) ?? ''
    }
    catch {
      text = ''
    }
  }
  return cutUtf8(text, LIMITS.transcriptToolResultBytes)
}

/** The harness tool name of a tool part (`tool-<name>`, or `dynamic-tool`'s `toolName`), or null. */
function toolNameOf(part: LoosePart): string | null {
  if (part.type === 'dynamic-tool')
    return typeof part.toolName === 'string' && part.toolName !== '' ? part.toolName : null
  return part.type.startsWith('tool-') && part.type.length > 5 ? part.type.slice(5) : null
}

/** The ISO time of a message (`metadata.startedAt`), else of `fallback`. */
function timestampOf(message: HarnessUIMessage, fallback: number): string {
  const metadata = message.metadata as { startedAt?: unknown } | undefined
  const at = typeof metadata?.startedAt === 'number' && Number.isFinite(metadata.startedAt) ? metadata.startedAt : fallback
  try {
    return new Date(at).toISOString()
  }
  catch {
    return new Date(fallback).toISOString()
  }
}

/** The lines of one message (a reply with tool results gives two). */
export function messageLines(message: HarnessUIMessage, fallbackTime: number): DraftLine[] {
  if (message.role !== 'user' && message.role !== 'assistant')
    return []
  const timestamp = timestampOf(message, fallbackTime)
  const content: Block[] = []
  const results: Block[] = []
  for (const raw of message.parts) {
    const part = loose(raw)
    if (part === null)
      continue
    if (part.type === 'text') {
      const text = typeof part.text === 'string' ? cutUtf8(part.text, LIMITS.transcriptPartBytes) : ''
      if (text !== '')
        content.push({ type: 'text', text })
      continue
    }
    if (message.role !== 'assistant')
      continue
    const name = toolNameOf(part)
    const callId = typeof part.toolCallId === 'string' ? part.toolCallId : ''
    if (name === null || callId === '')
      continue
    content.push({ type: 'tool_use', id: callId, name: claudeToolName(name) ?? name, input: cappedInput(part.input) })
    switch (part.state) {
      case 'output-available':
        results.push({ type: 'tool_result', tool_use_id: callId, content: resultText(part.output) })
        break
      case 'output-error':
        results.push({ type: 'tool_result', tool_use_id: callId, content: resultText(typeof part.errorText === 'string' ? part.errorText : 'The tool failed.'), is_error: true })
        break
      case 'output-denied':
        results.push({ type: 'tool_result', tool_use_id: callId, content: 'The tool call was denied.', is_error: true })
        break
      default:
        break
    }
  }
  const lines: DraftLine[] = []
  if (content.length > 0)
    lines.push({ type: message.role, uuid: message.id, timestamp, role: message.role, content })
  if (results.length > 0)
    lines.push({ type: 'user', uuid: `${message.id}${TOOL_RESULTS_SUFFIX}`, timestamp, role: 'user', content: results })
  return lines
}

/**
 * The JSONL text of a chat's messages (see the module comment), at most `maxBytes` (the oldest lines dropped first);
 * every line ends with a newline.
 */
export function transcriptText(messages: readonly HarnessUIMessage[], input: { readonly chatId: string, readonly cwd: string, readonly version: string, readonly now: number, readonly maxBytes?: number }): string {
  const maxBytes = input.maxBytes ?? LIMITS.transcriptBytesMax
  const drafts = messages.flatMap(message => messageLines(message, input.now))
  const serialized = drafts.map((draft, index) => ({
    draft,
    // The size of a line with a parent id as long as the longest possible one (the parent is fixed below).
    bytes: Buffer.byteLength(lineJson(draft, index === 0 ? null : (drafts[index - 1] as DraftLine).uuid, input), 'utf8') + 1,
  }))
  let total = serialized.reduce((sum, entry) => sum + entry.bytes, 0)
  let first = 0
  while (first < serialized.length && total > maxBytes) {
    total -= (serialized[first] as { bytes: number }).bytes
    first += 1
  }
  const kept = drafts.slice(first)
  return kept.map((draft, index) => `${lineJson(draft, index === 0 ? null : (kept[index - 1] as DraftLine).uuid, input)}\n`).join('')
}

function lineJson(draft: DraftLine, parentUuid: string | null, input: { readonly chatId: string, readonly cwd: string, readonly version: string }): string {
  return JSON.stringify({
    type: draft.type,
    uuid: draft.uuid,
    parentUuid,
    sessionId: input.chatId,
    timestamp: draft.timestamp,
    cwd: input.cwd,
    isSidechain: false,
    userType: 'external',
    version: input.version,
    message: { role: draft.role, content: draft.content },
  })
}

export function createTranscriptWriter(options: TranscriptWriterOptions): TranscriptWriter {
  const { dir, chats, logger } = options
  const now = options.now ?? (() => Date.now())
  let version: string | null = options.version ?? null
  /** The state of the last write per chat (least recently written first). */
  const written = new Map<string, string>()
  /** Bumped by `remove`: a write that started before a removal deletes its own file. */
  const generations = new Map<string, number>()
  const inflight = new Map<string, Promise<string | null>>()
  const pending = new Set<Promise<unknown>>()
  let prepared: Promise<boolean> | null = null
  let stopped = false

  function versionText(): string {
    if (version === null) {
      try {
        version = `harness-forge/${appVersion()}`
      }
      catch {
        version = 'harness-forge/0.0.0'
      }
    }
    return version
  }

  function pathOf(chatId: string): string | null {
    return typeof chatId === 'string' && CHAT_FILE_ID.test(chatId) ? join(dir, `${chatId}${TRANSCRIPT_SUFFIX}`) : null
  }

  function track<T>(promise: Promise<T>): Promise<T> {
    pending.add(promise)
    const forget = (): void => {
      pending.delete(promise)
    }
    promise.then(forget, forget)
    return promise
  }

  /** The folder (0700) and, once per start, the sweep of orphaned transcripts. */
  function prepare(): Promise<boolean> {
    prepared ??= (async () => {
      try {
        await mkdir(dir, { recursive: true, mode: 0o700 })
        await chmod(dir, 0o700)
      }
      catch (error) {
        logger.warn('hooks: the transcript folder could not be created; hooks get no transcript_path', { err: error })
        prepared = null
        return false
      }
      await sweep()
      return true
    })()
    return prepared
  }

  async function sweep(): Promise<void> {
    try {
      const names = await readdir(dir)
      const files = names.filter(name => name.endsWith(TRANSCRIPT_SUFFIX) || (name.startsWith('.') && name.endsWith('.tmp')))
      if (files.length === 0)
        return
      const ids = new Set(await chats.allIds())
      let removed = 0
      for (const name of files) {
        const temporary = name.endsWith('.tmp')
        const chatId = temporary ? null : name.slice(0, -TRANSCRIPT_SUFFIX.length)
        if (!temporary && chatId !== null && ids.has(chatId))
          continue
        await unlink(join(dir, name)).catch(() => {})
        removed += 1
      }
      if (removed > 0)
        logger.debug('hooks: orphaned transcripts removed', { removed })
    }
    catch (error) {
      logger.debug('hooks: the transcript sweep failed', { err: error })
    }
  }

  async function write(chatId: string, cwd: string, target: string): Promise<string | null> {
    if (!await prepare())
      return null
    const chat = await chats.find(chatId)
    if (chat === null || stopped)
      return null
    const state = `${chat.activeLeafId ?? ''}\u0000${chat.updatedAt}\u0000${cwd}`
    if (written.get(chatId) === state)
      return target
    const generation = generations.get(chatId) ?? 0
    const messages = await chats.listPath(chatId, chat.activeLeafId)
    const text = transcriptText(messages, { chatId, cwd, version: versionText(), now: now() })
    const temporary = join(dir, `.${chatId}.${randomBytes(6).toString('hex')}.tmp`)
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(text, 'utf8')
    }
    finally {
      await handle.close()
    }
    try {
      await chmod(temporary, 0o600)
      await rename(temporary, target)
    }
    catch (error) {
      await unlink(temporary).catch(() => {})
      throw error
    }
    if (stopped || (generations.get(chatId) ?? 0) !== generation) {
      // The chat was deleted (or the writer stopped) while the file was written.
      await unlink(target).catch(() => {})
      return null
    }
    written.delete(chatId)
    written.set(chatId, state)
    for (const key of written.keys()) {
      if (written.size <= KNOWN_CHATS_MAX)
        break
      written.delete(key)
    }
    return target
  }

  return {
    pathOf,
    ensure: async (chatId, cwd, signal) => {
      signal?.throwIfAborted()
      const target = pathOf(chatId)
      if (stopped || target === null)
        return null
      let running = inflight.get(chatId)
      if (running === undefined) {
        running = track(write(chatId, cwd, target).catch((error: unknown) => {
          logger.debug('hooks: the transcript could not be written; the hook gets no transcript_path', { err: error })
          return null
        }))
        inflight.set(chatId, running)
        const current = running
        void current.finally(() => {
          if (inflight.get(chatId) === current)
            inflight.delete(chatId)
        })
      }
      const path = await running
      signal?.throwIfAborted()
      return path
    },
    remove: async (chatId) => {
      const target = pathOf(chatId)
      if (target === null)
        return
      generations.set(chatId, (generations.get(chatId) ?? 0) + 1)
      for (const key of generations.keys()) {
        if (generations.size <= KNOWN_CHATS_MAX)
          break
        if (key !== chatId)
          generations.delete(key)
      }
      written.delete(chatId)
      await track(unlink(target).catch(() => {}))
    },
    stop: async () => {
      stopped = true
      await Promise.allSettled([...pending])
      written.clear()
      inflight.clear()
    },
  }
}
