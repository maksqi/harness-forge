// `/compact [focus]` through `POST /api/chat` (P9-0b, C26-T5 / T7): the command resolves before the registry, decides the
// reply (no model call) and is dispatched to `compactStream`, which answers "There is nothing to compact yet." until
// W9.1; a regenerate runs it again; an overlong focus is a 400 on the message.
import type { ChatDetail } from '@harness-forge/shared'
import type { TestApp } from '../../testing/create-test-app.ts'
import { chatDetailSchema, LIMITS } from '@harness-forge/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp } from '../../testing/create-test-app.ts'
import { chatBody, messageText, postChat, readSse, runnerOf, streamedText, testChatId } from '../testing.ts'
import { NOTHING_TO_COMPACT_TEXT } from './stream.ts'

let t: TestApp

beforeAll(async () => {
  t = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' } })
})

afterAll(async () => {
  await t.close()
})

async function detailOf(chatId: string): Promise<ChatDetail> {
  const response = await t.request(`/api/chats/${chatId}`)
  expect(response.status).toBe(200)
  return chatDetailSchema.parse(await response.json())
}

describe('/compact (stub until W9.1)', () => {
  it('answers that there is nothing to compact yet, without a model call, and keeps the invocation', async () => {
    const chatId = testChatId(9101)
    await readSse(await postChat(t, chatBody(chatId, 'first turn')))
    const body = chatBody(chatId, '/compact keep numbers')
    const { chunks, done } = await readSse(await postChat(t, body))
    expect(done).toBe(true)
    expect(streamedText(chunks)).toBe(NOTHING_TO_COMPACT_TEXT)
    await runnerOf(t).idle()
    const detail = await detailOf(chatId)
    const [user, reply] = detail.messages.slice(-2)
    expect(user?.metadata?.command).toEqual({ name: 'compact', input: 'keep numbers', type: 'compact' })
    expect(messageText(reply)).toBe(NOTHING_TO_COMPACT_TEXT)
    expect(reply?.metadata?.finishReason).toBe('stop')

    // A regenerate of the reply compacts again.
    const again = await readSse(await postChat(t, { ...body, trigger: 'regenerate-message', messageId: reply!.id }))
    expect(streamedText(again.chunks)).toBe(NOTHING_TO_COMPACT_TEXT)
  })

  it('refuses a focus longer than 1000 characters before anything is stored', async () => {
    const chatId = testChatId(9102)
    const response = await postChat(t, chatBody(chatId, `/compact ${'f'.repeat(LIMITS.compactFocusMaxChars + 1)}`))
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'validation_error', details: { issues: [{ path: ['message'] }] } } })
    const detail = await t.request(`/api/chats/${chatId}`)
    if (detail.status === 200)
      expect(chatDetailSchema.parse(await detail.json()).messages).toEqual([])
  })
})
