// Runs registry and resume buffer (ARCHITECTURE.md 6.3, API.md 6.6). At most one run per chat. A run owns its
// `AbortController` (never the request signal), so a client disconnect only drops the HTTP connection. The SSE bytes of
// the response are teed into the run buffer (`consumeSseStream`), which `GET /chat/:id/stream` replays from the first
// chunk and then follows live.
//
// Phases: `preparing` (request accepted, history not committed yet: conflicts apply, nothing to resume), `streaming`
// (`isActive`, resumable), `finishing` (the end callback persists the message: conflicts still apply, resume answers
// 204 so a replay never overlaps the persisted message). The run leaves the registry when it is released.
import type { ActiveRun } from './types.ts'
import { HarnessError } from '@harness-forge/shared'
import { UI_MESSAGE_STREAM_HEADERS } from 'ai'

export type RunPhase = 'preparing' | 'streaming' | 'finishing'

export interface Run {
  readonly runId: string
  readonly chatId: string
  readonly controller: AbortController
  /** The run signal passed to the model call, tools and commands. */
  readonly signal: AbortSignal
  /** When the request was accepted. */
  readonly acceptedAt: number
  phase: RunPhase
  /** The assistant message being generated; set when the run starts streaming. */
  messageId: string | null
  modelRef: string
  /** Stream start (`ActiveRun.startedAt`). */
  startedAt: number
  /** The SSE copy of the response; null until the run streams. */
  buffer: SseReplayBuffer | null
  /** Resolves once the run is released. */
  readonly settled: Promise<void>
  /** True after `release`. */
  released: boolean
  /** Released by `forceRelease` (the run did not settle after a stop): its late end callback persists nothing. */
  forceReleased: boolean
}

export interface RunRegistry {
  /** Reserves the chat; `conflict` (`reason: 'run-active'`) when a run already exists for it. */
  readonly acquire: (chatId: string, modelRef: string) => Run
  readonly get: (chatId: string) => Run | undefined
  /** Removes the run (only when it is the registered one) and resolves `settled`. Returns true on the first call. */
  readonly release: (run: Run) => boolean
  /** Every registered run, any phase. */
  readonly list: () => Run[]
}

let runCounter = 0

function newRunId(): string {
  runCounter += 1
  return `run_${Date.now().toString(36)}_${runCounter.toString(36)}`
}

export function runConflict(chatId: string): HarnessError {
  return new HarnessError({
    code: 'conflict',
    message: 'A reply is already being generated for this chat. Stop it or wait until it finishes.',
    details: { reason: 'run-active', chatId },
  })
}

export function createRunRegistry(now: () => number = Date.now): RunRegistry {
  const runs = new Map<string, Run>()
  const resolvers = new WeakMap<Run, () => void>()

  return {
    acquire: (chatId, modelRef) => {
      if (runs.has(chatId))
        throw runConflict(chatId)
      const controller = new AbortController()
      let resolveSettled!: () => void
      const settled = new Promise<void>((resolve) => {
        resolveSettled = resolve
      })
      const at = now()
      const run: Run = {
        runId: newRunId(),
        chatId,
        controller,
        signal: controller.signal,
        acceptedAt: at,
        phase: 'preparing',
        messageId: null,
        modelRef,
        startedAt: at,
        buffer: null,
        settled,
        released: false,
        forceReleased: false,
      }
      resolvers.set(run, resolveSettled)
      runs.set(chatId, run)
      return run
    },
    get: chatId => runs.get(chatId),
    release: (run) => {
      if (run.released)
        return false
      run.released = true
      if (runs.get(run.chatId) === run)
        runs.delete(run.chatId)
      resolvers.get(run)?.()
      return true
    },
    list: () => [...runs.values()],
  }
}

/** The `ActiveRun` view of a streaming run. */
export function toActiveRun(run: Run): ActiveRun | null {
  if (run.phase !== 'streaming' || run.messageId === null)
    return null
  return { runId: run.runId, chatId: run.chatId, messageId: run.messageId, modelRef: run.modelRef, startedAt: run.startedAt }
}

/**
 * The SSE text of one run (`data: <chunk>\n\n` strings, `data: [DONE]\n\n` last). `consume` fills it from the teed
 * response stream; `replay` returns a byte stream with every chunk from the first, then live chunks until the run
 * stream ends.
 */
export class SseReplayBuffer {
  readonly #chunks: string[] = []
  readonly #wakeups = new Set<() => void>()
  #closed = false

  get closed(): boolean {
    return this.#closed
  }

  get size(): number {
    return this.#chunks.length
  }

  append(chunk: string): void {
    if (this.#closed)
      return
    this.#chunks.push(chunk)
    this.#wake()
  }

  close(): void {
    if (this.#closed)
      return
    this.#closed = true
    this.#wake()
  }

  /** Reads `stream` until it ends; a stream error ends the buffer as well (the caller sees it through `onError`). */
  async consume(stream: ReadableStream<string>, onError?: (error: unknown) => void): Promise<void> {
    const reader = stream.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done)
          break
        this.append(value)
      }
    }
    catch (error) {
      onError?.(error)
    }
    finally {
      this.close()
      reader.releaseLock()
    }
  }

  replay(): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder()
    let index = 0
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        while (index >= this.#chunks.length && !this.#closed)
          await this.#next()
        if (index < this.#chunks.length) {
          const text = this.#chunks.slice(index).join('')
          index = this.#chunks.length
          controller.enqueue(encoder.encode(text))
          return
        }
        controller.close()
      },
    })
  }

  /** A response for `GET /chat/:id/stream`. */
  toResponse(): Response {
    return new Response(this.replay(), { status: 200, headers: UI_MESSAGE_STREAM_HEADERS })
  }

  #next(): Promise<void> {
    return new Promise((resolve) => {
      this.#wakeups.add(resolve)
    })
  }

  #wake(): void {
    const wakeups = [...this.#wakeups]
    this.#wakeups.clear()
    for (const wake of wakeups)
      wake()
  }
}
