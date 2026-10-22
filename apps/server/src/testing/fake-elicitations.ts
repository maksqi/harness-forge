import type { ElicitationRequest, ElicitResult } from '@ai-sdk/mcp'
// Test double of `ElicitationBroker` (Phase 14, C50-T6), so the MCP tool generator (`begin` / the handle), the
// `chatElicitations` route, the chats routes (`awaitingInput`) and the web contract can be tested without an MCP server:
//
//   const t = await createTestApp({ elicitations: 'fake' })   // or overrides: { elicitations: createFakeElicitationBroker() }
//   const fake = t.deps.elicitations as FakeElicitationBroker
//   const reply = fake.request({ chatId, toolCallId }, { message: 'Your name?', form: { fields: [...] } })
//   await t.request(`/api/chat/${chatId}/elicitations/${reply.elicitation.id}`, { method: 'POST', body: … })
//   expect(await reply.result).toEqual({ action: 'accept', content: { name: 'Ada' } })
//
// `begin` registers the call (`inFlight`) and returns a live handle: `pending()` / `waiting()` follow the scripted request
// of the call, `onChange` listeners run when one is attributed or settles, `records()` lists the settled ones (never a
// value), `end()` removes the call and cancels its pending request (`stopped`). `request(call, fields)` scripts one
// request for the call in flight with that chat and tool call id (the call must have begun) and answers the pending
// `McpElicitation` plus the promise of what the MCP server would receive. `handler(runtimeKey)` records the request
// (`handled`) and answers `handlerAnswer` (default `decline`, like the stub). `answer` validates like the real broker
// (`validateElicitationAnswer`: 400 with `details.issues` on `['content', <field>]`), answers 404 for an unknown id or
// another chat's, 409 `stale` for a settled one, and records `{ chatId, elicitationId, action, fields }` (field names
// only). `pendingCount`, `cancelChat` (`cancel`, `stopped`) and `stop` (every request cancelled) work on the scripted
// requests. Every call is counted.
import type {
  ElicitationAction,
  ElicitationContent,
  ElicitationReason,
  McpElicitation,
  McpElicitationAnswerBody,
  McpElicitationForm,
  McpElicitationRecord,
} from '@harness-forge/shared'
import type { ElicitationBroker, ElicitationCall, ElicitationCallHandle } from '../mcp/elicitation/types.ts'
import { createElicitationId, HarnessError, LIMITS, validateElicitationAnswer } from '@harness-forge/shared'

/** A scripted request (`request(call, fields)`): the pending card data and what the MCP server receives. */
export interface FakeElicitationReply {
  readonly elicitation: McpElicitation
  /** Resolves when the request settles (answer, cancel, `end`, `stop`): the MCP server's `ElicitResult`. */
  readonly result: Promise<ElicitResult>
}

/** A recorded `answer` (field names only, never values). */
export interface FakeElicitationAnswer {
  readonly chatId: string
  readonly elicitationId: string
  readonly action: ElicitationAction
  readonly fields: readonly string[]
}

/** A recorded `handler` request. */
export interface FakeElicitationHandled {
  readonly runtimeKey: string
  readonly request: ElicitationRequest
}

export interface FakeElicitationBrokerOptions {
  /** How long a scripted request waits (`expiresAt`; default `LIMITS.mcpElicitationWaitMs`); nothing expires by itself. */
  waitMs?: number
  /** Clock (epoch ms; default `Date.now`). */
  now?: () => number
}

export interface FakeElicitationBroker extends ElicitationBroker {
  /** Every call that began and has not ended, in order. */
  readonly inFlight: ElicitationCall[]
  /** Every `answer` that was accepted, in order. */
  readonly answers: FakeElicitationAnswer[]
  /** Every `handler` request, in order. */
  readonly handled: FakeElicitationHandled[]
  /** What `handler(runtimeKey)` answers (default `{ action: 'decline' }`); tests may replace it. */
  handlerAnswer: ElicitResult
  /** Every `cancelChat` argument, in order. */
  readonly cancelledChats: string[]
  /**
   * Scripts a request for the call in flight with `call.chatId` and `call.toolCallId` (throws when there is none, or
   * when it already has a pending request).
   */
  readonly request: (call: Pick<ElicitationCall, 'chatId' | 'toolCallId'>, fields: { message: string, form: McpElicitationForm }) => FakeElicitationReply
  /** Number of calls of each member. */
  readonly calls: Record<keyof ElicitationBroker, number>
}

interface PendingRequest {
  readonly elicitation: McpElicitation
  readonly chatId: string
  readonly entry: CallEntry
  readonly resolve: (result: ElicitResult) => void
}

interface CallEntry {
  readonly call: ElicitationCall
  pending: PendingRequest | null
  readonly records: McpElicitationRecord[]
  readonly listeners: Set<() => void>
}

export function createFakeElicitationBroker(options: FakeElicitationBrokerOptions = {}): FakeElicitationBroker {
  const now = options.now ?? Date.now
  const waitMs = options.waitMs ?? LIMITS.mcpElicitationWaitMs
  const entries: CallEntry[] = []
  const pending = new Map<string, PendingRequest>()
  const inFlight: ElicitationCall[] = []
  const answers: FakeElicitationAnswer[] = []
  const handled: FakeElicitationHandled[] = []
  const cancelledChats: string[] = []
  const calls: Record<keyof ElicitationBroker, number> = { begin: 0, handler: 0, answer: 0, pendingCount: 0, cancelChat: 0, stop: 0 }

  function notify(entry: CallEntry): void {
    for (const listener of [...entry.listeners])
      listener()
  }

  /** Settles a pending request: the record (field names only), the MCP server's answer, the listeners. */
  function settle(request: PendingRequest, action: ElicitationAction, reason: ElicitationReason, content?: ElicitationContent): void {
    if (!pending.delete(request.elicitation.id))
      return
    const { entry, elicitation } = request
    entry.pending = null
    entry.records.push({
      id: elicitation.id,
      message: elicitation.message,
      fields: elicitation.form.fields.map(field => field.name),
      action,
      reason,
    })
    request.resolve(action === 'accept' && content !== undefined ? { action, content } : { action })
    notify(entry)
  }

  function handle(entry: CallEntry): ElicitationCallHandle {
    return {
      pending: () => entry.pending?.elicitation ?? null,
      waiting: () => entry.pending !== null,
      onChange: (listener) => {
        entry.listeners.add(listener)
        return () => {
          entry.listeners.delete(listener)
        }
      },
      records: () => entry.records.map(record => ({ ...record, fields: [...record.fields] })),
      end: () => {
        const index = entries.indexOf(entry)
        if (index === -1)
          return
        entries.splice(index, 1)
        inFlight.splice(inFlight.indexOf(entry.call), 1)
        if (entry.pending !== null)
          settle(entry.pending, 'cancel', 'stopped')
        entry.listeners.clear()
      },
    }
  }

  const fake: FakeElicitationBroker = {
    inFlight,
    answers,
    handled,
    handlerAnswer: { action: 'decline' },
    cancelledChats,
    calls,
    request: (call, fields) => {
      const entry = entries.find(item => item.call.chatId === call.chatId && item.call.toolCallId === call.toolCallId)
      if (entry === undefined)
        throw new Error(`No MCP tool call ${call.toolCallId} of chat ${call.chatId} is in flight.`)
      if (entry.pending !== null)
        throw new Error(`The MCP tool call ${call.toolCallId} already waits for an answer.`)
      const elicitation: McpElicitation = {
        id: createElicitationId(),
        serverId: entry.call.serverId,
        serverName: entry.call.serverName,
        message: fields.message,
        form: fields.form,
        expiresAt: now() + waitMs,
      }
      let resolve!: (result: ElicitResult) => void
      const result = new Promise<ElicitResult>((done) => {
        resolve = done
      })
      const request: PendingRequest = { elicitation, chatId: entry.call.chatId, entry, resolve }
      entry.pending = request
      pending.set(elicitation.id, request)
      notify(entry)
      return { elicitation, result }
    },
    begin: (call) => {
      calls.begin += 1
      const entry: CallEntry = { call, pending: null, records: [], listeners: new Set() }
      entries.push(entry)
      inFlight.push(call)
      return handle(entry)
    },
    handler: (runtimeKey) => {
      calls.handler += 1
      return async (request) => {
        handled.push({ runtimeKey, request })
        return fake.handlerAnswer
      }
    },
    answer: async (chatId: string, elicitationId: string, body: McpElicitationAnswerBody) => {
      calls.answer += 1
      const request = pending.get(elicitationId)
      if (request === undefined || request.chatId !== chatId) {
        const settled = entries.some(entry => entry.call.chatId === chatId && entry.records.some(record => record.id === elicitationId))
        if (settled)
          throw new HarnessError({ code: 'conflict', message: 'This input request was already answered or expired.', details: { reason: 'stale' } })
        throw new HarnessError({ code: 'not_found', message: 'This input request is not pending.' })
      }
      let content: ElicitationContent | undefined
      if (body.action === 'accept') {
        const checked = validateElicitationAnswer(request.elicitation.form, body.content ?? {})
        if (!checked.ok) {
          throw new HarnessError({
            code: 'validation_error',
            message: checked.issues[0]?.message ?? 'The answer is not valid.',
            details: { issues: checked.issues.map(issue => ({ path: ['content', issue.field], message: issue.message, code: issue.code })) },
          })
        }
        content = checked.content
      }
      answers.push({ chatId, elicitationId, action: body.action, fields: Object.keys(content ?? {}) })
      settle(request, body.action, 'user', content)
      return { action: body.action }
    },
    pendingCount: (chatId) => {
      calls.pendingCount += 1
      let count = 0
      for (const request of pending.values()) {
        if (request.chatId === chatId)
          count += 1
      }
      return count
    },
    cancelChat: (chatId) => {
      calls.cancelChat += 1
      cancelledChats.push(chatId)
      for (const request of [...pending.values()]) {
        if (request.chatId === chatId)
          settle(request, 'cancel', 'stopped')
      }
    },
    stop: async () => {
      calls.stop += 1
      for (const request of [...pending.values()])
        settle(request, 'cancel', 'stopped')
    },
  }
  return fake
}
