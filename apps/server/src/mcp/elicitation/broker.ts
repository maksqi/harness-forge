// The MCP elicitation broker (Phase 14, ADR-060; ARCHITECTURE.md 6.40) behind `ElicitationBroker` (./types.ts). Owner:
// W14.3 (C50 landed the stub with the final factory signature).
//
// - Registry: `begin(call)` adds an MCP tool call in flight to the list of its client (`runtimeKey`), oldest first; the
//   handle's `end()` removes it (a request still pending is cancelled, reason `stopped`).
// - Attribution (`handler(runtimeKey)`): no call in flight → `decline` (`not-interactive`); calls of more than one chat →
//   `decline` (`ambiguous`); a sub-agent or background call among them → `decline` (`not-interactive`); otherwise the
//   oldest call gets the request. These declines have no call to belong to: they are logged at `debug` (runtime key and
//   reason only) and leave no record. For the attributed call: URL mode (any `mode` other than `form`) or a schema
//   outside the supported subset (`parseElicitationForm`) → `decline` (`unsupported`); a second request while the
//   call's first one waits → `decline` (`ambiguous`); a call already aborted → `cancel` (`stopped`); each of these is a
//   record of the call. Otherwise the request waits: an `eli_` id, the cleaned message (`elicitationMessageText`), the
//   normalized form and `expiresAt` = now + `waitMs` (default `LIMITS.mcpElicitationWaitMs`, 480 s; `deps.ts` passes
//   the test-only `HF_TEST_ELICITATION_WAIT_MS`). The call's handle reports it (`pending()`, `waiting()`, `onChange`),
//   so the tool generator shows the card (`mcp-tools.ts`).
// - A wait ends with the user's answer (`answer`: `validateElicitationAnswer` → 400 with the field issues; reason
//   `user`), the timeout (`cancel`, `timeout`), the call's signal (Stop, the tool's outer timeout), the call's end, chat
//   deletion (`chat.deleted` → `cancelChat`), a key rotation (`key.rotated`) or `stop()` (each `cancel`, `stopped`).
//   Every settled request becomes a record of its call (`{ id, message, fields: names, action, reason }`, at most
//   `ELICITATION_RECORDS_MAX` per call) and its id is remembered (at most `SETTLED_IDS_MAX`), so a late answer is `409
//   stale` instead of `404`.
// - Signals: `pendingCount(chatId)`; on every 0 ↔ ≥ 1 transition of a chat the broker emits `chat.updated` with the chat's
//   summary, its active leaf and `awaitingInput` (open point 2; per chat in order, after the chat row was read; nothing
//   for a deleted chat or after `stop()`).
// - Never stored, logged or put into an error: the values the user entered (they go only to the MCP server). The request
//   message is never logged either; log lines carry ids, the server id, the action, the reason and counts.
// - Memory only, bounded by the calls in flight; the event-bus subscription (`chat.deleted`, `key.rotated`) exists only
//   while a request waits (an MCP call that never elicits leaves no subscriber); timers are `unref()`-ed and cleared when
//   a wait ends; `stop()` cancels every wait, clears the registries and waits for the `chat.updated` reads in flight.
import type { ElicitationRequest, ElicitResult } from '@ai-sdk/mcp'
import type { Disposable } from '@harness-forge/plugin-sdk'
import type {
  ElicitationAction,
  ElicitationContent,
  ElicitationForm,
  ElicitationReason,
  McpElicitation,
  McpElicitationAnswerBody,
  McpElicitationAnswerResult,
  McpElicitationForm,
  McpElicitationRecord,
} from '@harness-forge/shared'
import type { AppDeps } from '../../types.ts'
import type { ElicitationBroker, ElicitationBrokerOptions, ElicitationCall, ElicitationCallHandle, ElicitationHandler } from './types.ts'
import {
  createElicitationId,
  elicitationMessageText,
  HarnessError,
  LIMITS,
  mcpElicitationSchema,
  parseElicitationForm,
  validateElicitationAnswer,
  validationError,
} from '@harness-forge/shared'

/** Settled request ids remembered for the `409 stale` answer (the oldest is forgotten first). */
export const SETTLED_IDS_MAX = 1000
/** Records kept per call (later requests of the same call are still answered, but not recorded). */
export const ELICITATION_RECORDS_MAX = 50
/** Longest server name on a card (`mcpElicitationSchema.serverName`). */
const SERVER_NAME_MAX_CHARS = 256

/** The answer of `409 conflict` (`stale`): answered, expired or its run ended. */
export const STALE_ELICITATION_MESSAGE = 'This request was already answered or has ended.'
/** The answer of `404 not_found`. */
export const UNKNOWN_ELICITATION_MESSAGE = 'This input request is not pending.'

interface CallEntry {
  readonly call: ElicitationCall
  pending: PendingRequest | null
  readonly records: McpElicitationRecord[]
  readonly listeners: Set<() => void>
  ended: boolean
}

interface PendingRequest {
  readonly elicitation: McpElicitation
  /** The parsed form (`validateElicitationAnswer`). */
  readonly form: ElicitationForm
  readonly entry: CallEntry
  readonly resolve: (result: ElicitResult) => void
  readonly onAbort: () => void
  timer: ReturnType<typeof setTimeout> | null
}

type Attribution
  = | { readonly kind: 'call', readonly entry: CallEntry }
    | { readonly kind: 'decline', readonly reason: 'not-interactive' | 'ambiguous' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** URL mode, or any mode other than the form mode (the only one the harness supports). */
function isNonFormMode(params: Record<string, unknown>): boolean {
  return params.mode !== undefined && params.mode !== 'form'
}

/** The DTO of a parsed form (mutable copies of the readonly arrays). */
function formDto(form: ElicitationForm): McpElicitationForm {
  return {
    fields: form.fields.map(({ options, default: value, ...field }) => ({
      ...field,
      ...(options === undefined ? {} : { options: options.map(option => ({ value: option.value, label: option.label })) }),
      ...(value === undefined ? {} : { default: Array.isArray(value) ? [...value] : value }),
    })),
  }
}

function staleError(): HarnessError {
  return new HarnessError({ code: 'conflict', message: STALE_ELICITATION_MESSAGE, details: { reason: 'stale' } })
}

function unknownError(): HarnessError {
  return new HarnessError({ code: 'not_found', message: UNKNOWN_ELICITATION_MESSAGE })
}

export function createElicitationBroker(deps: AppDeps, options: ElicitationBrokerOptions = {}): ElicitationBroker {
  const waitMs = options.waitMs ?? LIMITS.mcpElicitationWaitMs
  /** The calls in flight per MCP client, oldest first. */
  const clients = new Map<string, CallEntry[]>()
  const pending = new Map<string, PendingRequest>()
  /** Pending requests per chat (absent = 0). */
  const counts = new Map<string, number>()
  /** Settled request id → its chat (insertion order: the oldest first). */
  const settledIds = new Map<string, string>()
  /** The `chat.updated` emission in flight per chat (kept in order). */
  const announcing = new Map<string, Promise<void>>()
  let subscription: Disposable | null = null
  let stopped = false

  function notify(entry: CallEntry): void {
    for (const listener of [...entry.listeners]) {
      try {
        listener()
      }
      catch (error) {
        deps.logger.warn('an elicitation listener failed', { chatId: entry.call.chatId, err: error })
      }
    }
  }

  function addRecord(entry: CallEntry, record: McpElicitationRecord): void {
    if (entry.records.length < ELICITATION_RECORDS_MAX)
      entry.records.push(record)
  }

  function rememberSettled(id: string, chatId: string): void {
    settledIds.set(id, chatId)
    while (settledIds.size > SETTLED_IDS_MAX) {
      const oldest = settledIds.keys().next().value
      if (oldest === undefined)
        break
      settledIds.delete(oldest)
    }
  }

  function forgetChat(chatId: string): void {
    for (const [id, owner] of settledIds) {
      if (owner === chatId)
        settledIds.delete(id)
    }
  }

  // ----- awaitingInput (chat.updated)

  async function emitUpdated(chatId: string, awaitingInput: boolean): Promise<void> {
    try {
      if (stopped)
        return
      const row = await deps.chats.find(chatId)
      if (row === null || stopped)
        return
      const summary = await deps.chats.summary(chatId)
      if (stopped)
        return
      deps.events.emit('chat.updated', { ...summary, activeLeafId: row.activeLeafId, awaitingInput })
    }
    catch (error) {
      deps.logger.debug('mcp elicitation: chat.updated not sent', { chatId, err: error })
    }
  }

  function announce(chatId: string, awaitingInput: boolean): void {
    if (stopped)
      return
    const previous = announcing.get(chatId) ?? Promise.resolve()
    const next = previous.then(() => emitUpdated(chatId, awaitingInput))
    announcing.set(chatId, next)
    void next.then(() => {
      if (announcing.get(chatId) === next)
        announcing.delete(chatId)
    })
  }

  /** Changes the chat's pending count; a 0 ↔ ≥ 1 transition emits `chat.updated`. */
  function adjust(chatId: string, delta: 1 | -1): void {
    const before = counts.get(chatId) ?? 0
    const after = Math.max(0, before + delta)
    if (after === 0)
      counts.delete(chatId)
    else
      counts.set(chatId, after)
    if ((before === 0) !== (after === 0))
      announce(chatId, after > 0)
  }

  // ----- waits

  /** Ends a waiting request: the record, the MCP server's answer, the signals. Idempotent. */
  function settle(request: PendingRequest, action: ElicitationAction, reason: ElicitationReason, content?: ElicitationContent): void {
    const { elicitation, entry } = request
    if (pending.get(elicitation.id) !== request)
      return
    pending.delete(elicitation.id)
    if (pending.size === 0)
      unsubscribe()
    if (request.timer !== null) {
      clearTimeout(request.timer)
      request.timer = null
    }
    entry.call.signal.removeEventListener('abort', request.onAbort)
    if (entry.pending === request)
      entry.pending = null
    addRecord(entry, { id: elicitation.id, message: elicitation.message, fields: request.form.fields.map(field => field.name), action, reason })
    rememberSettled(elicitation.id, entry.call.chatId)
    adjust(entry.call.chatId, -1)
    deps.logger.info('mcp elicitation ended', { chatId: entry.call.chatId, serverId: entry.call.serverId, elicitationId: elicitation.id, action, reason })
    request.resolve(action === 'accept' && content !== undefined ? { action, content } : { action })
    notify(entry)
  }

  /** Shows the request on the call and waits for the answer, the timeout or a cancellation. */
  function wait(entry: CallEntry, message: string, form: ElicitationForm): Promise<ElicitResult> | null {
    const { call } = entry
    const elicitation: McpElicitation = {
      id: createElicitationId(),
      serverId: call.serverId,
      serverName: call.serverName.slice(0, SERVER_NAME_MAX_CHARS),
      message,
      form: formDto(form),
      expiresAt: Date.now() + waitMs,
    }
    // The card must parse on the web (the preliminary output's schema); anything else is declined.
    if (!mcpElicitationSchema.safeParse(elicitation).success)
      return null
    return new Promise<ElicitResult>((resolve) => {
      const request: PendingRequest = {
        elicitation,
        form,
        entry,
        resolve,
        onAbort: () => settle(request, 'cancel', 'stopped'),
        timer: null,
      }
      entry.pending = request
      pending.set(elicitation.id, request)
      subscribe()
      adjust(call.chatId, 1)
      request.timer = setTimeout(settle, waitMs, request, 'cancel', 'timeout')
      request.timer.unref?.()
      call.signal.addEventListener('abort', request.onAbort, { once: true })
      deps.logger.info('mcp elicitation waiting', { chatId: call.chatId, serverId: call.serverId, elicitationId: elicitation.id, fields: form.fields.length })
      notify(entry)
    })
  }

  /** A request answered at once for the attributed call (no card): a record of the call, the MCP server's answer. */
  function answerAtOnce(entry: CallEntry, record: Omit<McpElicitationRecord, 'id'>): ElicitResult {
    const id = createElicitationId()
    addRecord(entry, { id, ...record })
    deps.logger.debug('mcp elicitation declined', { chatId: entry.call.chatId, serverId: entry.call.serverId, elicitationId: id, action: record.action, reason: record.reason })
    notify(entry)
    return { action: record.action }
  }

  function attribute(runtimeKey: string): Attribution {
    const entries = (clients.get(runtimeKey) ?? []).filter(entry => !entry.ended)
    const oldest = entries[0]
    if (oldest === undefined)
      return { kind: 'decline', reason: 'not-interactive' }
    if (entries.some(entry => entry.call.chatId !== oldest.call.chatId))
      return { kind: 'decline', reason: 'ambiguous' }
    if (entries.some(entry => !entry.call.interactive))
      return { kind: 'decline', reason: 'not-interactive' }
    return { kind: 'call', entry: oldest }
  }

  async function receive(runtimeKey: string, request: ElicitationRequest): Promise<ElicitResult> {
    if (stopped) {
      deps.logger.debug('mcp elicitation declined', { runtimeKey, reason: 'stopped' })
      return { action: 'cancel' }
    }
    const attribution = attribute(runtimeKey)
    if (attribution.kind === 'decline') {
      deps.logger.debug('mcp elicitation declined', { runtimeKey, reason: attribution.reason })
      return { action: 'decline' }
    }
    const { entry } = attribution
    const params: Record<string, unknown> = isRecord(request.params) ? request.params : {}
    const message = elicitationMessageText(params.message)
    if (isNonFormMode(params))
      return answerAtOnce(entry, { message, fields: [], action: 'decline', reason: 'unsupported' })
    const parsed = parseElicitationForm(params.requestedSchema)
    if (!parsed.ok)
      return answerAtOnce(entry, { message, fields: [], action: 'decline', reason: 'unsupported' })
    const fields = parsed.form.fields.map(field => field.name)
    if (entry.pending !== null)
      return answerAtOnce(entry, { message, fields, action: 'decline', reason: 'ambiguous' })
    if (entry.call.signal.aborted)
      return answerAtOnce(entry, { message, fields, action: 'cancel', reason: 'stopped' })
    const waiting = wait(entry, message, parsed.form)
    if (waiting === null)
      return answerAtOnce(entry, { message, fields: [], action: 'decline', reason: 'unsupported' })
    return waiting
  }

  // ----- the registry

  /** Follows chat deletions and key rotations while a request waits (`wait` subscribes, the last `settle` disposes). */
  function subscribe(): void {
    if (subscription !== null || stopped)
      return
    try {
      subscription = deps.events.subscribe((event) => {
        if (event.type === 'chat.deleted') {
          cancelChat(event.data.id)
          forgetChat(event.data.id)
        }
        else if (event.type === 'key.rotated') {
          cancelAll()
        }
      })
    }
    catch (error) {
      deps.logger.debug('mcp elicitation: no event subscription', { err: error })
    }
  }

  function unsubscribe(): void {
    const current = subscription
    subscription = null
    current?.dispose()
  }

  function removeEntry(entry: CallEntry): void {
    const key = entry.call.runtimeKey
    const entries = clients.get(key)
    if (entries === undefined)
      return
    const index = entries.indexOf(entry)
    if (index !== -1)
      entries.splice(index, 1)
    if (entries.length === 0)
      clients.delete(key)
  }

  function handleOf(entry: CallEntry): ElicitationCallHandle {
    return {
      pending: () => entry.pending?.elicitation ?? null,
      waiting: () => entry.pending !== null,
      onChange: (listener) => {
        if (entry.ended)
          return () => {}
        entry.listeners.add(listener)
        return () => {
          entry.listeners.delete(listener)
        }
      },
      records: () => entry.records.map(record => ({ ...record, fields: [...record.fields] })),
      end: () => {
        if (entry.ended)
          return
        entry.ended = true
        removeEntry(entry)
        if (entry.pending !== null)
          settle(entry.pending, 'cancel', 'stopped')
        entry.listeners.clear()
      },
    }
  }

  function cancelAll(): void {
    for (const request of [...pending.values()])
      settle(request, 'cancel', 'stopped')
  }

  function cancelChat(chatId: string): void {
    for (const request of [...pending.values()]) {
      if (request.entry.call.chatId === chatId)
        settle(request, 'cancel', 'stopped')
    }
  }

  function answerOf(chatId: string, elicitationId: string, body: McpElicitationAnswerBody): McpElicitationAnswerResult {
    const request = pending.get(elicitationId)
    if (request === undefined || request.entry.call.chatId !== chatId) {
      if (settledIds.get(elicitationId) === chatId)
        throw staleError()
      throw unknownError()
    }
    if (Date.now() >= request.elicitation.expiresAt) {
      settle(request, 'cancel', 'timeout')
      throw staleError()
    }
    let content: ElicitationContent | undefined
    if (body.action === 'accept') {
      const checked = validateElicitationAnswer(request.form, body.content ?? {})
      if (!checked.ok) {
        throw validationError(checked.issues.map(issue => ({
          path: issue.field === '' ? ['content'] : ['content', issue.field],
          message: issue.message,
          code: issue.code,
        })), checked.issues[0]?.message ?? 'The answer is not valid.')
      }
      content = checked.content
    }
    settle(request, body.action, 'user', content)
    return { action: body.action }
  }

  return {
    begin: (call) => {
      const entry: CallEntry = { call, pending: null, records: [], listeners: new Set(), ended: false }
      const entries = clients.get(call.runtimeKey)
      if (entries === undefined)
        clients.set(call.runtimeKey, [entry])
      else
        entries.push(entry)
      return handleOf(entry)
    },
    handler: (runtimeKey): ElicitationHandler => async (request) => {
      try {
        return await receive(runtimeKey, request)
      }
      catch (error) {
        deps.logger.warn('mcp elicitation failed', { runtimeKey, err: error })
        return { action: 'decline' }
      }
    },
    answer: async (chatId, elicitationId, body) => answerOf(chatId, elicitationId, body),
    pendingCount: chatId => counts.get(chatId) ?? 0,
    cancelChat: (chatId) => {
      try {
        cancelChat(chatId)
      }
      catch (error) {
        deps.logger.warn('cannot cancel the elicitations of a chat', { chatId, err: error })
      }
    },
    stop: async () => {
      try {
        stopped = true
        cancelAll()
        unsubscribe()
        for (const entries of clients.values()) {
          for (const entry of entries)
            entry.ended = true
        }
        clients.clear()
        settledIds.clear()
        counts.clear()
        await Promise.allSettled([...announcing.values()])
        announcing.clear()
      }
      catch (error) {
        deps.logger.warn('the elicitation broker did not stop cleanly', { err: error })
      }
    },
  }
}
