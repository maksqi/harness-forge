// Chat runner and the maintenance lock (C16-T1): `POST /chat` answers 409 busy while an operation with `blockRuns`
// (the key rotation) holds the lock, stores nothing, and runs again once the operation ended. An operation without
// `blockRuns` (a file cleanup) never blocks runs.
import type { HarnessErrorInit } from '@harness-forge/shared'
import type { TestApp } from '../testing/create-test-app.ts'
import { harnessErrorEnvelopeSchema } from '@harness-forge/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { KEY_ROTATION_RUNS_MESSAGE } from '../services/maintenance/index.ts'
import { createTestApp } from '../testing/create-test-app.ts'
import { chatBody, postChat, readSse, streamedText, testChatId } from './testing.ts'

let t: TestApp

beforeAll(async () => {
  t = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' } })
})

afterAll(async () => {
  await t.close()
})

async function errorOf(response: Response): Promise<HarnessErrorInit> {
  return harnessErrorEnvelopeSchema.parse(await response.json()).error
}

/** Holds the maintenance lock until the returned `finish()` runs. */
function hold(kind: 'key-rotation' | 'file-cleanup', blockRuns: boolean): { finish: () => void, done: Promise<void> } {
  let finish!: () => void
  const done = t.deps.maintenance.exclusive(kind, () => new Promise<void>((resolve) => {
    finish = resolve
  }), { blockRuns })
  return { finish, done }
}

describe('pOST /api/chat during maintenance', () => {
  it('answers 409 busy while a key rotation blocks runs, stores nothing, and runs again afterwards', async () => {
    const chatId = testChatId(901)
    const rotation = hold('key-rotation', true)
    const refused = await postChat(t, chatBody(chatId, 'hello during rotation'))
    expect(refused.status).toBe(409)
    expect(await errorOf(refused)).toEqual({ code: 'conflict', message: KEY_ROTATION_RUNS_MESSAGE, details: { reason: 'busy' } })
    expect(await t.deps.chats.find(chatId)).toBeNull()
    expect(t.deps.runs.hasRun(chatId)).toBe(false)
    rotation.finish()
    await rotation.done

    const response = await postChat(t, chatBody(chatId, 'hello after rotation'))
    expect(response.status).toBe(200)
    const { chunks, done } = await readSse(response)
    expect(done).toBe(true)
    expect(streamedText(chunks)).toContain('hello after rotation')
  })

  it('keeps running chats while an operation without blockRuns holds the lock', async () => {
    const cleanup = hold('file-cleanup', false)
    try {
      const response = await postChat(t, chatBody(testChatId(902), 'hello during cleanup'))
      expect(response.status).toBe(200)
      expect((await readSse(response)).done).toBe(true)
    }
    finally {
      cleanup.finish()
      await cleanup.done
    }
  })
})

describe('steer queue members (P9-0b stubs until W9.2)', () => {
  it('delegate to the runner queue: an empty queue that cannot take items yet', async () => {
    const chatId = testChatId(903)
    const runs = t.deps.runs
    expect(runs.queueList(chatId)).toEqual([])
    expect(runs.dequeue(chatId, 'msg_q000000000000001')).toBe(false)
    expect(runs.clearQueue(chatId, 'stopped')).toEqual([])
    const body = { message: { id: 'msg_q000000000000001', role: 'user' as const, parts: [{ type: 'text' as const, text: 'later' }] }, modelRef: 'mock:echo', reasoningEffort: 'auto' as const, toolMode: 'ask' as const }
    await expect(runs.enqueue(chatId, body, { logger: t.deps.logger, requestId: 'req_test' })).rejects.toMatchObject({ code: 'not_implemented' })
    // Stop empties the queue first and still answers for a chat without a run.
    expect(await runs.stop(chatId)).toBe(false)
  })
})
