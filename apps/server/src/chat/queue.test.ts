// The steer queue (P9-0b stub, C26-T5): `add` and `requeue` throw `not_implemented`; reads and removals answer the
// empty queue so Stop, chat delete and shutdown keep working until W9.2.
import type { QueueItem } from '@harness-forge/shared'
import type { ChatQueueDeps } from './queue.ts'
import { describe, expect, it } from 'vitest'
import { createSilentLogger } from '../logger.ts'
import { createChatQueue } from './queue.ts'

const CHAT = '0199a8f0-0000-7000-8000-000000000001'

describe('createChatQueue (stub until W9.2)', () => {
  it('answers the empty queue and refuses to add', async () => {
    const queue = createChatQueue({} as ChatQueueDeps, { hasRun: () => true, now: () => 1 })
    expect(queue.list(CHAT)).toEqual([])
    expect(queue.remove(CHAT, 'msg_q000000000000001')).toBe(false)
    expect(queue.takeSteerable(CHAT)).toEqual([])
    expect(queue.takeNext(CHAT)).toBeNull()
    expect(queue.clear(CHAT, 'stopped')).toEqual([])
    expect(() => queue.clearAll('stopped')).not.toThrow()
    const body = { message: { id: 'msg_q000000000000001', role: 'user' as const, parts: [{ type: 'text' as const, text: 'hi' }] }, modelRef: 'mock:echo', reasoningEffort: 'auto' as const, toolMode: 'ask' as const }
    await expect(queue.add(CHAT, body, { logger: createSilentLogger(), requestId: 'req' })).rejects.toMatchObject({ code: 'not_implemented' })
    const item = { id: body.message.id, message: body.message, modelRef: 'mock:echo', reasoningEffort: 'auto', toolMode: 'ask', createdAt: 1, turnOnly: false } as QueueItem
    expect(() => queue.requeue(CHAT, { item, options: { logger: createSilentLogger(), requestId: 'req' } })).toThrow(expect.objectContaining({ code: 'not_implemented' }))
  })
})
