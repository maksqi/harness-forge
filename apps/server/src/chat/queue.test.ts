// The steer queue (W9.2-T1, ADR-042, API.md 4.26): caps, every 409, part normalization, `turnOnly`, take vs. remove,
// the `removed` reasons of every `queue.changed`, clearing on `chat.deleted` and `key.rotated`, and no message text in
// the logs.
import type { HarnessUIMessage, QueueAddBody, QueueChangedData, UserMessagePart } from '@harness-forge/shared'
import type { ChatRecord } from '../services/chats/types.ts'
import type { StoredFile } from '../services/files/types.ts'
import type { RecordingEventBus } from '../testing/fakes.ts'
import type { ChatQueue, ChatQueueDeps } from './queue.ts'
import { LIMITS } from '@harness-forge/shared'
import { beforeEach, describe, expect, it } from 'vitest'
import { createMemoryLogger } from '../logger.ts'
import { createRecordingEventBus } from '../testing/fakes.ts'
import { createChatQueue, isServerCommand, queueConflict } from './queue.ts'

const CHAT = '0199a8f0-0000-7000-8000-000000000001'
const OTHER = '0199a8f0-0000-7000-8000-000000000002'
const FILE_ID = 'file_AAAAAAAAAAAAAAAA'
const SECRET_TEXT = 'queue-sentinel-text-7f3a'

function msgId(n: number): string {
  return `msg_q${n.toString().padStart(15, '0')}`
}

interface Harness {
  queue: ChatQueue
  events: RecordingEventBus
  logs: ReturnType<typeof createMemoryLogger>
  chats: Map<string, Pick<ChatRecord, 'id' | 'pendingApproval'>>
  stored: Set<string>
  running: Set<string>
  /** Resolves the next `chats.find` only when the test says so (null: answer at once). */
  gate: { find: Promise<void> | null }
  clock: { now: number }
}

function harness(): Harness {
  const events = createRecordingEventBus()
  const logs = createMemoryLogger()
  const chats = new Map<string, Pick<ChatRecord, 'id' | 'pendingApproval'>>([[CHAT, { id: CHAT, pendingApproval: false }], [OTHER, { id: OTHER, pendingApproval: false }]])
  const stored = new Set<string>()
  const running = new Set<string>([CHAT, OTHER])
  const gate: Harness['gate'] = { find: null }
  const clock = { now: 1000 }
  const file: StoredFile = { id: FILE_ID, name: 'notes.txt', mime: 'text/plain', size: 5, sha256: 'x', createdAt: 1 } as StoredFile
  const deps = {
    chats: {
      find: async (id: string) => {
        if (gate.find !== null)
          await gate.find
        return (chats.get(id) as ChatRecord | undefined) ?? null
      },
      getMessage: async (_chatId: string, id: string) => (stored.has(id) ? ({ id } as HarnessUIMessage) : null),
    },
    files: {
      idFromUrl: (url: string) => (url.startsWith('/api/files/') ? url.slice('/api/files/'.length) : null),
      get: async (id: string) => (id === FILE_ID ? file : null),
    },
    registry: { commands: { get: (name: string) => (name === 'plugin-cmd' ? { pluginId: 'x', definition: { name, description: 'd', template: 't' } } : undefined) } },
    events,
    logger: logs.logger,
  } as unknown as ChatQueueDeps
  const queue = createChatQueue(deps, { hasRun: chatId => running.has(chatId), now: () => clock.now })
  return { queue, events, logs, chats, stored, running, gate, clock }
}

function body(id: string, parts: UserMessagePart[] = [{ type: 'text', text: `hello ${id}` }]): QueueAddBody {
  return { message: { id, role: 'user', parts }, modelRef: 'mock:steer', reasoningEffort: 'auto', toolMode: 'ask' }
}

function changes(h: Harness): QueueChangedData[] {
  return h.events.ofType('queue.changed').map(event => event.data)
}

let h: Harness
const options = (): { logger: Harness['logs']['logger'], requestId: string } => ({ logger: h.logs.logger, requestId: 'req_queue' })

beforeEach(() => {
  h = harness()
})

describe('add', () => {
  it('appends a normalized item (file parts rewritten from the stored file), emits queue.changed and lists it', async () => {
    const item = await h.queue.add(CHAT, body(msgId(1), [
      { type: 'text', text: 'look at this' },
      { type: 'file', mediaType: 'application/octet-stream', filename: 'evil.exe', url: `/api/files/${FILE_ID}` },
    ]), options())
    expect(item).toEqual({
      id: msgId(1),
      message: { id: msgId(1), role: 'user', parts: [{ type: 'text', text: 'look at this' }, { type: 'file', mediaType: 'text/plain', filename: 'notes.txt', url: `/api/files/${FILE_ID}` }] },
      modelRef: 'mock:steer',
      reasoningEffort: 'auto',
      toolMode: 'ask',
      createdAt: 1000,
      turnOnly: false,
    })
    expect(h.queue.list(CHAT)).toEqual([item])
    expect(h.queue.list(OTHER)).toEqual([])
    expect(changes(h)).toEqual([{ chatId: CHAT, items: [item] }])
  })

  it('marks server commands turnOnly (/compact, a plugin command), never client commands or unknown names', async () => {
    const texts = ['/compact keep numbers', '  /plugin-cmd input', '/model mock:echo', '/unknown thing', 'plain /compact']
    const items = []
    for (const [index, text] of texts.entries())
      items.push(await h.queue.add(CHAT, body(msgId(index + 1), [{ type: 'text', text }]), options()))
    expect(items.map(item => item.turnOnly)).toEqual([true, true, false, false, false])
    // Only the first text part counts.
    const withFile = await h.queue.add(CHAT, body(msgId(9), [{ type: 'file', mediaType: 'text/plain', url: `/api/files/${FILE_ID}` }, { type: 'text', text: '/compact' }]), options())
    expect(withFile.turnOnly).toBe(true)
  })

  it('accepts a chat that waits for an approval without a run; 409 run-idle for an idle chat', async () => {
    h.running.clear()
    await expect(h.queue.add(CHAT, body(msgId(1)), options())).rejects.toMatchObject({ code: 'conflict', details: { reason: 'run-idle', chatId: CHAT } })
    h.chats.set(CHAT, { id: CHAT, pendingApproval: true })
    await expect(h.queue.add(CHAT, body(msgId(1)), options())).resolves.toMatchObject({ id: msgId(1) })
    expect(changes(h)).toHaveLength(1)
  })

  it('answers 404 for an unknown chat, 409 exists for a stored or queued id, 409 queue-full at the cap', async () => {
    await expect(h.queue.add('0199a8f0-0000-7000-8000-0000000000ff', body(msgId(1)), options())).rejects.toMatchObject({ code: 'not_found' })
    h.stored.add(msgId(1))
    await expect(h.queue.add(CHAT, body(msgId(1)), options())).rejects.toMatchObject({ code: 'conflict', details: { reason: 'exists' } })
    await h.queue.add(CHAT, body(msgId(2)), options())
    await expect(h.queue.add(CHAT, body(msgId(2)), options())).rejects.toMatchObject({ code: 'conflict', details: { reason: 'exists' } })
    for (let n = 3; n < 2 + LIMITS.queueItemsMax; n++)
      await h.queue.add(CHAT, body(msgId(n)), options())
    expect(h.queue.list(CHAT)).toHaveLength(LIMITS.queueItemsMax)
    await expect(h.queue.add(CHAT, body(msgId(99)), options())).rejects.toMatchObject({ code: 'conflict', details: { reason: 'queue-full' } })
    // Another chat has its own cap.
    await expect(h.queue.add(OTHER, body(msgId(99)), options())).resolves.toMatchObject({ id: msgId(99) })
  })

  it('checks the id against the queue again after the awaits (two adds of one id in flight)', async () => {
    const [first, second] = await Promise.allSettled([h.queue.add(CHAT, body(msgId(1)), options()), h.queue.add(CHAT, body(msgId(1)), options())])
    expect(first.status).toBe('fulfilled')
    expect(second).toMatchObject({ status: 'rejected', reason: { code: 'conflict', details: { reason: 'exists' } } })
    expect(h.queue.list(CHAT)).toHaveLength(1)
  })

  it('validates the parts like a POST /chat user message (400 on [message, parts, i])', async () => {
    await expect(h.queue.add(CHAT, body(msgId(1), [{ type: 'text', text: 'x' }, { type: 'file', mediaType: 'image/png', url: 'https://example.com/a.png' }]), options()))
      .rejects
      .toMatchObject({ code: 'validation_error', details: { issues: [{ path: ['message', 'parts', 1] }] } })
    await expect(h.queue.add(CHAT, body(msgId(1), [{ type: 'file', mediaType: 'image/png', url: '/api/files/file_BBBBBBBBBBBBBBBB' }]), options()))
      .rejects
      .toMatchObject({ code: 'validation_error', details: { issues: [{ path: ['message', 'parts', 0] }] } })
    expect(h.queue.list(CHAT)).toEqual([])
    expect(changes(h)).toEqual([])
  })
})

describe('remove, takes and clear', () => {
  async function fill(...texts: string[]): Promise<string[]> {
    const ids: string[] = []
    for (const [index, text] of texts.entries()) {
      ids.push(msgId(index + 1))
      await h.queue.add(CHAT, body(msgId(index + 1), [{ type: 'text', text }]), options())
    }
    h.events.clear()
    return ids
  }

  it('remove cancels a queued item (reason cancelled) and answers false once it is gone', async () => {
    const [a, b] = await fill('a', 'b')
    expect(h.queue.remove(CHAT, a!)).toBe(true)
    expect(h.queue.remove(CHAT, a!)).toBe(false)
    expect(h.queue.remove(OTHER, b!)).toBe(false)
    expect(h.queue.list(CHAT).map(item => item.id)).toEqual([b])
    expect(changes(h)).toEqual([{ chatId: CHAT, items: [expect.objectContaining({ id: b })], removed: [{ id: a, reason: 'cancelled' }] }])
  })

  it('takeSteerable takes every steerable item in order (delivered) and leaves turnOnly items; a later remove loses', async () => {
    const [a, compact, c] = await fill('a', '/compact', 'c')
    const taken = h.queue.takeSteerable(CHAT)
    expect(taken.map(item => item.id)).toEqual([a, c])
    expect(h.queue.list(CHAT).map(item => item.id)).toEqual([compact])
    expect(changes(h)).toEqual([{ chatId: CHAT, items: [expect.objectContaining({ id: compact, turnOnly: true })], removed: [{ id: a, reason: 'delivered' }, { id: c, reason: 'delivered' }] }])
    expect(h.queue.remove(CHAT, a!)).toBe(false)
    // Nothing steerable left: no event.
    h.events.clear()
    expect(h.queue.takeSteerable(CHAT)).toEqual([])
    expect(changes(h)).toEqual([])
  })

  it('a remove before the take wins: the item is never delivered', async () => {
    const [a, b] = await fill('a', 'b')
    expect(h.queue.remove(CHAT, b!)).toBe(true)
    expect(h.queue.takeSteerable(CHAT).map(item => item.id)).toEqual([a])
  })

  it('takeNext takes the oldest item of any kind (started); requeue puts it back at the head', async () => {
    const [compact, b] = await fill('/compact now', 'b')
    const entry = h.queue.takeNext(CHAT)
    expect(entry?.item.id).toBe(compact)
    expect(entry?.options.requestId).toBe('req_queue')
    expect(changes(h).at(-1)).toEqual({ chatId: CHAT, items: [expect.objectContaining({ id: b })], removed: [{ id: compact, reason: 'started' }] })
    h.queue.requeue(CHAT, entry!)
    expect(h.queue.list(CHAT).map(item => item.id)).toEqual([compact, b])
    expect(changes(h).at(-1)).toEqual({ chatId: CHAT, items: [expect.objectContaining({ id: compact }), expect.objectContaining({ id: b })] })
    // A second requeue of a queued item changes nothing.
    h.queue.requeue(CHAT, entry!)
    expect(h.queue.list(CHAT)).toHaveLength(2)
    expect(h.queue.takeNext(OTHER)).toBeNull()
  })

  it('requeue into a full queue reports the item failed instead of passing the cap', async () => {
    await fill('first')
    const entry = h.queue.takeNext(CHAT)!
    for (let n = 2; n < 2 + LIMITS.queueItemsMax; n++)
      await h.queue.add(CHAT, body(msgId(n)), options())
    h.events.clear()
    h.queue.requeue(CHAT, entry)
    expect(h.queue.list(CHAT)).toHaveLength(LIMITS.queueItemsMax)
    expect(changes(h)).toEqual([{ chatId: CHAT, items: expect.any(Array), removed: [{ id: entry.item.id, reason: 'failed', error: 'The queue is full.' }] }])
  })

  it('clear returns the items oldest first with the reason; an empty queue emits nothing', async () => {
    const [a, b] = await fill('a', 'b')
    expect(h.queue.clear(CHAT, 'failed').map(item => item.id)).toEqual([a, b])
    expect(changes(h)).toEqual([{ chatId: CHAT, items: [], removed: [{ id: a, reason: 'failed' }, { id: b, reason: 'failed' }] }])
    expect(h.queue.clear(CHAT, 'stopped')).toEqual([])
    expect(changes(h)).toHaveLength(1)
  })

  it('clearAll empties every chat (stopped)', async () => {
    await fill('a')
    await h.queue.add(OTHER, body(msgId(7)), options())
    h.events.clear()
    h.queue.clearAll('stopped')
    expect(h.queue.list(CHAT)).toEqual([])
    expect(h.queue.list(OTHER)).toEqual([])
    expect(changes(h).map(change => [change.chatId, change.removed?.map(removal => removal.reason)])).toEqual([[CHAT, ['stopped']], [OTHER, ['stopped']]])
  })
})

describe('clearing on events', () => {
  it('chat.deleted empties that chat (stopped) and fails an add still in flight for it', async () => {
    await h.queue.add(CHAT, body(msgId(1)), options())
    await h.queue.add(OTHER, body(msgId(2)), options())
    let open!: () => void
    h.gate.find = new Promise<void>((resolve) => {
      open = resolve
    })
    const inFlight = h.queue.add(CHAT, body(msgId(3)), options())
    h.events.emit('chat.deleted', { id: CHAT })
    h.chats.delete(CHAT)
    open()
    await expect(inFlight).rejects.toMatchObject({ code: 'not_found' })
    expect(h.queue.list(CHAT)).toEqual([])
    expect(h.queue.list(OTHER)).toHaveLength(1)
    expect(changes(h).filter(change => change.chatId === CHAT).at(-1)).toEqual({ chatId: CHAT, items: [], removed: [{ id: msgId(1), reason: 'stopped' }] })
  })

  it('a deleted chat whose add was still in flight leaves nothing behind even when the chat row is still found', async () => {
    let open!: () => void
    h.gate.find = new Promise<void>((resolve) => {
      open = resolve
    })
    // The queue subscribes with its first add.
    const inFlight = h.queue.add(CHAT, body(msgId(1)), options())
    h.events.emit('chat.deleted', { id: CHAT })
    open()
    await expect(inFlight).rejects.toMatchObject({ code: 'not_found' })
    expect(h.queue.list(CHAT)).toEqual([])
  })

  it('key.rotated empties every queue, also of a chat that waits for an approval without a run', async () => {
    h.running.delete(CHAT)
    h.chats.set(CHAT, { id: CHAT, pendingApproval: true })
    await h.queue.add(CHAT, body(msgId(1)), options())
    await h.queue.add(OTHER, body(msgId(2)), options())
    h.events.emit('key.rotated', { keyVersion: 2, rotatedAt: 5, chatIds: [OTHER] })
    expect(h.queue.list(CHAT)).toEqual([])
    expect(h.queue.list(OTHER)).toEqual([])
    expect(changes(h).slice(-2).map(change => change.removed)).toEqual([[{ id: msgId(1), reason: 'stopped' }], [{ id: msgId(2), reason: 'stopped' }]])
  })
})

describe('hygiene', () => {
  it('never logs message texts (ids only, at debug)', async () => {
    await h.queue.add(CHAT, body(msgId(1), [{ type: 'text', text: SECRET_TEXT }]), options())
    await h.queue.add(CHAT, body(msgId(2), [{ type: 'text', text: `/compact ${SECRET_TEXT}` }]), options())
    h.queue.remove(CHAT, msgId(2))
    h.queue.takeSteerable(CHAT)
    await h.queue.add(CHAT, body(msgId(3), [{ type: 'text', text: SECRET_TEXT }]), options())
    h.queue.clear(CHAT, 'stopped')
    expect(h.logs.records.length).toBeGreaterThan(0)
    expect(h.logs.text()).not.toContain(SECRET_TEXT)
    expect(h.logs.records.every(record => record.level === 'debug')).toBe(true)
  })

  it('queueConflict and isServerCommand', () => {
    expect(queueConflict('queue-full', CHAT)).toMatchObject({ code: 'conflict', details: { reason: 'queue-full', chatId: CHAT } })
    const commands = { get: (name: string) => (name === 'review' ? {} as never : undefined) }
    expect(isServerCommand('/compact', commands)).toBe(true)
    expect(isServerCommand('/review this', commands)).toBe(true)
    expect(isServerCommand('/help', commands)).toBe(false)
    expect(isServerCommand('/nope', commands)).toBe(false)
    expect(isServerCommand('', commands)).toBe(false)
  })
})
