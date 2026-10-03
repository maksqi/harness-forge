import type { ChatDetail, HarnessUIMessage } from '@harness-forge/shared'
import type { TestApp } from '../../testing/create-test-app.ts'
import { chatExportAnySchema, findCompaction, HarnessError, MESSAGE_ID_PATTERN, splitSteers } from '@harness-forge/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestApp } from '../../testing/create-test-app.ts'
import { buildChatExport } from './export.ts'
import { assignMessageIds, freshMessageIds, IMPORT_DENIAL_REASON, planImportTree, validateImportedMessages } from './import.ts'

const META = { modelRef: 'mock:echo', startedAt: 1 }

function user(id: string, text: string): HarnessUIMessage {
  return { id, role: 'user', metadata: META, parts: [{ type: 'text', text }] }
}

async function rejection(promise: Promise<unknown>): Promise<HarnessError> {
  try {
    await promise
  }
  catch (error) {
    expect(error).toBeInstanceOf(HarnessError)
    return error as HarnessError
  }
  throw new Error('expected a rejection')
}

describe('validateImportedMessages', () => {
  it('accepts valid messages (metadata optional) and keeps them in order', async () => {
    const messages: HarnessUIMessage[] = [
      user('msg_aaaaaaaaaaaaaaaa', 'hello'),
      { id: 'msg_bbbbbbbbbbbbbbbb', role: 'assistant', parts: [{ type: 'text', text: 'hi', state: 'done' }] },
    ]
    await expect(validateImportedMessages(messages)).resolves.toEqual(messages)
    await expect(validateImportedMessages([])).resolves.toEqual([])
  })

  it('finalizes streaming parts and denies pending approvals', async () => {
    const assistant = {
      id: 'msg_bbbbbbbbbbbbbbbb',
      role: 'assistant',
      parts: [
        { type: 'text', text: 'partial', state: 'streaming' },
        { type: 'reasoning', text: 'thinking', state: 'streaming' },
        { type: 'tool-web_fetch', toolCallId: 'c1', state: 'approval-requested', input: { url: 'u' }, approval: { id: 'a1' } },
        { type: 'dynamic-tool', toolName: 'mcp__x__y', toolCallId: 'c2', state: 'approval-responded', input: {}, approval: { id: 'a2', approved: true } },
        { type: 'tool-web_fetch', toolCallId: 'c3', state: 'approval-responded', input: {}, approval: { id: 'a3', approved: false, reason: 'no thanks' } },
        { type: 'tool-web_fetch', toolCallId: 'c4', state: 'output-available', input: {}, output: 'ok' },
      ],
    } as unknown as HarnessUIMessage
    const [result] = await validateImportedMessages([assistant])
    const parts = result!.parts as unknown as Record<string, unknown>[]
    expect(parts[0]).toMatchObject({ type: 'text', state: 'done' })
    expect(parts[1]).toMatchObject({ type: 'reasoning', state: 'done' })
    expect(parts[2]).toMatchObject({ state: 'output-denied', approval: { id: 'a1', approved: false, reason: IMPORT_DENIAL_REASON } })
    expect(parts[3]).toMatchObject({ state: 'output-denied', approval: { id: 'a2', approved: false, reason: IMPORT_DENIAL_REASON } })
    expect(parts[4]).toMatchObject({ state: 'output-denied', approval: { id: 'a3', approved: false, reason: 'no thanks' } })
    expect(parts[5]).toMatchObject({ state: 'output-available', output: 'ok' })
  })

  it('rejects invalid metadata with the issue path under messages, without echoing the value', async () => {
    const bad = { ...user('msg_aaaaaaaaaaaaaaaa', 'secret text'), metadata: { modelRef: 'no-colon', startedAt: 1 } } as HarnessUIMessage
    const error = await rejection(validateImportedMessages([user('msg_cccccccccccccccc', 'ok'), bad]))
    expect(error.code).toBe('validation_error')
    const { issues } = error.details as { issues: { path: unknown[] }[] }
    expect(issues[0]!.path.slice(0, 3)).toEqual(['messages', 1, 'metadata'])
    expect(JSON.stringify(error.toJSON())).not.toContain('secret text')
  })

  it('puts the issue paths under a prefix (importChat: chat.messages)', async () => {
    const bad = { ...user('msg_aaaaaaaaaaaaaaaa', 'x'), metadata: { modelRef: 'no-colon', startedAt: 1 } } as HarnessUIMessage
    const error = await rejection(validateImportedMessages([bad], ['chat']))
    const { issues } = error.details as { issues: { path: unknown[] }[] }
    expect(issues[0]!.path.slice(0, 4)).toEqual(['chat', 'messages', 0, 'metadata'])
  })

  it('rejects unknown data parts and malformed parts', async () => {
    const unknownData = { id: 'msg_aaaaaaaaaaaaaaaa', role: 'assistant', parts: [{ type: 'data-custom', data: {} }] } as unknown as HarnessUIMessage
    expect((await rejection(validateImportedMessages([unknownData]))).code).toBe('validation_error')
    const badNotice = { id: 'msg_aaaaaaaaaaaaaaaa', role: 'assistant', parts: [{ type: 'data-notice', data: { level: 'loud' } }] } as unknown as HarnessUIMessage
    expect((await rejection(validateImportedMessages([badNotice]))).code).toBe('validation_error')
    const emptyUser = { id: 'msg_aaaaaaaaaaaaaaaa', role: 'user', parts: [] } as unknown as HarnessUIMessage
    const error = await rejection(validateImportedMessages([emptyUser]))
    expect((error.details as { issues: { path: unknown[] }[] }).issues[0]!.path[0]).toBe('messages')
  })
})

describe('assignMessageIds', () => {
  it('keeps valid unused ids and replaces invalid, repeated and taken ones', () => {
    const list = [
      user('msg_aaaaaaaaaaaaaaaa', 'keep'),
      user('not-a-message-id', 'invalid'),
      user('msg_aaaaaaaaaaaaaaaa', 'repeated'),
      user('msg_takentakentaken1', 'taken'),
    ]
    const result = assignMessageIds(list, new Set(['msg_takentakentaken1']))
    expect(result[0]).toBe(list[0])
    expect(result.map(message => message.id).every(id => MESSAGE_ID_PATTERN.test(id))).toBe(true)
    expect(new Set(result.map(message => message.id)).size).toBe(4)
    expect(result[3]!.id).not.toBe('msg_takentakentaken1')
    expect(result.map(message => (message.parts[0] as { text: string }).text)).toEqual(['keep', 'invalid', 'repeated', 'taken'])
  })
})

describe('planImportTree', () => {
  function issuePath(fn: () => unknown): unknown[] | undefined {
    try {
      fn()
    }
    catch (error) {
      expect(error).toBeInstanceOf(HarnessError)
      expect((error as HarnessError).code).toBe('validation_error')
      return ((error as HarnessError).details as { issues: { path: unknown[] }[] }).issues[0]?.path
    }
    return undefined
  }

  it('is linear without parentIds (repeated ids allowed), the last message active', () => {
    expect(planImportTree(['a', 'b', 'a'], undefined, undefined)).toEqual({ parentIndex: [-1, 0, 1], leafIndex: 2 })
    expect(planImportTree(['a', 'b', 'c'], undefined, 'a')).toEqual({ parentIndex: [-1, 0, 1], leafIndex: 2 })
    expect(planImportTree([], undefined, undefined)).toEqual({ parentIndex: [], leafIndex: -1 })
    expect(planImportTree([], [], null)).toEqual({ parentIndex: [], leafIndex: -1 })
  })

  it('turns parentIds into positions; the active leaf is the most recent leaf under activeLeafId', () => {
    // A -> RA -> B -> RB; A2 -> RA2; RA3 (a second reply to A).
    const ids = ['A', 'RA', 'B', 'RB', 'A2', 'RA2', 'RA3']
    const parents = [null, 'A', 'RA', 'B', null, 'A2', 'A']
    expect(planImportTree(ids, parents, 'RA2')).toEqual({ parentIndex: [-1, 0, 1, 2, -1, 4, 0], leafIndex: 5 })
    expect(planImportTree(ids, parents, 'A')).toMatchObject({ leafIndex: 6 })
    expect(planImportTree(ids, parents, 'RA')).toMatchObject({ leafIndex: 3 })
    expect(planImportTree(ids, parents, null)).toMatchObject({ leafIndex: 6 })
    expect(planImportTree(ids, parents, undefined)).toMatchObject({ leafIndex: 6 })
  })

  it('rejects a misaligned, forward, unknown or self parent, repeated ids and an unknown leaf, with the path', () => {
    const ids = ['a', 'b', 'c']
    expect(issuePath(() => planImportTree(ids, [null, 'a'], undefined))).toEqual(['parentIds'])
    expect(issuePath(() => planImportTree(ids, [null, 'c', 'a'], undefined))).toEqual(['parentIds', 1])
    expect(issuePath(() => planImportTree(ids, [null, 'b', 'a'], undefined))).toEqual(['parentIds', 1])
    expect(issuePath(() => planImportTree(ids, [null, 'x', 'a'], undefined))).toEqual(['parentIds', 1])
    expect(issuePath(() => planImportTree(['a', 'b', 'a'], [null, 'a', 'b'], undefined))).toEqual(['messages', 2, 'id'])
    expect(issuePath(() => planImportTree(ids, [null, 'a', 'b'], 'x', ['chat']))).toEqual(['chat', 'activeLeafId'])
    expect(issuePath(() => planImportTree(ids, [null, 'a', 'z'], undefined, ['chat']))).toEqual(['chat', 'parentIds', 2])
  })
})

describe('freshMessageIds', () => {
  it('gives every message a new unique id and keeps the content', () => {
    const list = [user('msg_aaaaaaaaaaaaaaaa', 'one'), user('msg_aaaaaaaaaaaaaaaa', 'two'), user('bad', 'three')]
    const result = freshMessageIds(list)
    expect(result.map(message => message.id).every(id => MESSAGE_ID_PATTERN.test(id))).toBe(true)
    expect(new Set([...result.map(message => message.id), 'msg_aaaaaaaaaaaaaaaa']).size).toBe(4)
    expect(result.map(message => (message.parts[0] as { text: string }).text)).toEqual(['one', 'two', 'three'])
    expect(list[0]!.id).toBe('msg_aaaaaaaaaaaaaaaa')
  })
})

// ---------- Phase 9: agent parts (W9.7) ----------

const COMPACTION = { modelRef: 'mock:compact', messagesCompacted: 2, tokensBefore: 800, tokensAfter: 80, createdAt: 7 }

/** A path with a steer inside a reply, a `/compact` reply and an automatic marker during a reply. */
function agentMessages(): HarnessUIMessage[] {
  return [
    { id: 'msg_agentimport00001', role: 'user', metadata: META, parts: [{ type: 'text', text: 'Remember OLD-1' }] },
    {
      id: 'msg_agentimport00002',
      role: 'assistant',
      metadata: { modelRef: 'mock:steer', startedAt: 2, finishedAt: 3 },
      parts: [
        { type: 'step-start' },
        { type: 'text', text: 'Working', state: 'done' },
        {
          type: 'data-steer',
          id: 'steer_part_1',
          data: {
            id: 'msg_queuedimport0001',
            parts: [{ type: 'text', text: 'Also the TANGERINE case' }, { type: 'file', mediaType: 'text/plain', filename: 'notes.txt', url: '/api/files/file_0000000000000003' }],
            queuedAt: 3,
            deliveredAt: 4,
          },
        },
        { type: 'step-start' },
        { type: 'text', text: 'Done with both', state: 'done' },
      ],
    },
    { id: 'msg_agentimport00003', role: 'user', metadata: { ...META, command: { name: 'compact', input: 'keep numbers', type: 'compact' } }, parts: [{ type: 'text', text: '/compact keep numbers' }] },
    {
      id: 'msg_agentimport00004',
      role: 'assistant',
      metadata: { modelRef: 'mock:compact', startedAt: 5, finishedAt: 6 },
      parts: [{ type: 'step-start' }, { type: 'data-compaction', data: { ...COMPACTION, trigger: 'manual', keep: 'none', focus: 'keep numbers', summary: 'MOCK-SUMMARY sentinels=OLD-1' } }],
    },
    { id: 'msg_agentimport00005', role: 'user', metadata: META, parts: [{ type: 'text', text: 'loop 2' }] },
    {
      id: 'msg_agentimport00006',
      role: 'assistant',
      metadata: { modelRef: 'mock:compact', startedAt: 8, finishedAt: 9 },
      parts: [
        { type: 'step-start' },
        { type: 'text', text: 'Step 1 done.', state: 'done' },
        { type: 'data-compaction', data: { ...COMPACTION, trigger: 'auto', keep: 'last-user', summary: 'In-run summary', todos: [{ id: 't1', content: 'Write tests', status: 'in_progress' }] } },
        { type: 'step-start' },
        { type: 'text', text: 'Loop finished after 2 steps.', state: 'done' },
      ],
    },
  ] as HarnessUIMessage[]
}

function agentChat(messages: HarnessUIMessage[] = agentMessages()): ChatDetail {
  return {
    id: '0199a8f0-0000-7000-8000-00000000a9e1',
    title: 'Agent import',
    titleSource: 'user',
    modelRef: 'mock:compact',
    pinned: false,
    archived: false,
    running: false,
    pendingApproval: false,
    projectId: null,
    createdAt: 1,
    updatedAt: 2,
    settings: { toolMode: 'ask' },
    totals: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
    branches: {},
    messages,
  }
}

const apps: TestApp[] = []

afterEach(async () => {
  for (const t of apps.splice(0))
    await t.close()
})

async function testApp(): Promise<TestApp> {
  const t = await createTestApp({ start: false, builtins: [] })
  apps.push(t)
  return t
}

function exportOf(chat: ChatDetail) {
  return chatExportAnySchema.parse(JSON.parse(buildChatExport(chat, 'json', 10).body))
}

describe('validateImportedMessages: agent parts (Phase 9)', () => {
  it('keeps compaction markers and steers unchanged', async () => {
    const messages = agentMessages()
    await expect(validateImportedMessages(messages)).resolves.toEqual(messages)
  })

  it('drops transient activity parts from replies', async () => {
    const reply = {
      id: 'msg_agentimport00009',
      role: 'assistant',
      parts: [{ type: 'data-activity', data: { kind: 'compacting' } }, { type: 'text', text: 'ok', state: 'done' }, { type: 'data-activity', data: { kind: 'idle' } }],
    } as HarnessUIMessage
    const [result] = await validateImportedMessages([reply])
    expect(result!.parts).toEqual([{ type: 'text', text: 'ok', state: 'done' }])
  })

  it('rejects invalid compaction and steer data with the issue path', async () => {
    const [, reply, , compactReply] = agentMessages()
    const badSteer = { ...reply!, parts: [{ type: 'data-steer', data: { id: 'msg_queuedimport0001', parts: [], queuedAt: 1, deliveredAt: 2 } }] } as unknown as HarnessUIMessage
    const longSummary = { ...compactReply!, parts: [{ type: 'data-compaction', data: { ...COMPACTION, trigger: 'manual', keep: 'none', summary: 'x'.repeat(60_001) } }] } as unknown as HarnessUIMessage
    const badTrigger = { ...compactReply!, parts: [{ type: 'data-compaction', data: { ...COMPACTION, trigger: 'sometimes', keep: 'none', summary: 's' } }] } as unknown as HarnessUIMessage
    for (const bad of [badSteer, longSummary, badTrigger]) {
      const error = await rejection(validateImportedMessages([bad], ['chat']))
      expect(error.code).toBe('validation_error')
      expect((error.details as { issues: { path: unknown[] }[] }).issues[0]!.path.slice(0, 3)).toEqual(['chat', 'messages', 0])
    }
  })
})

describe('chat export -> import round trip: agent parts (Phase 9)', () => {
  it('keep: the parts come back unchanged, and a second export equals the first', async () => {
    const t = await testApp()
    const exported = exportOf(agentChat())
    const { id } = await t.deps.chats.importChat({ exported, id: 'keep', restore: true })
    const imported = await t.deps.chats.get(id)
    expect(imported.messages).toEqual(agentMessages())
    const again = (await t.deps.chats.export(id, 'json')).body
    expect(chatExportAnySchema.parse(JSON.parse(again)).chat.messages).toEqual(exported.chat.messages)
  })

  it('new: replaced message ids keep the marker in force (positional) and the steer splits the reply', async () => {
    const t = await testApp()
    const { id } = await t.deps.chats.importChat({ exported: exportOf(agentChat()), id: 'new', restore: false })
    const path = (await t.deps.chats.get(id)).messages
    expect(path.map(message => message.id)).not.toContain('msg_agentimport00001')
    expect(path.map(message => message.parts)).toEqual(agentMessages().map(message => message.parts))
    expect(findCompaction(path)).toMatchObject({ messageIndex: 5, partIndex: 2, keptUserIndex: 4, data: { trigger: 'auto', summary: 'In-run summary' } })
    const split = splitSteers(path)
    expect(split.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant'])
    expect(split[2]).toMatchObject({ id: 'msg_queuedimport0001', role: 'user', parts: [{ type: 'text', text: 'Also the TANGERINE case' }, { type: 'file' }] })
    // The search text of the imported reply holds the steer text, never the summaries.
    expect((await t.deps.chats.list({ q: 'tangerine' })).items.map(chat => chat.id)).toEqual([id])
    expect((await t.deps.chats.list({ q: 'in-run summary' })).items).toEqual([])
    expect((await t.deps.chats.list({ q: 'sentinels' })).items).toEqual([])
  })

  it('an imported activity part is not stored', async () => {
    const t = await testApp()
    const messages = agentMessages()
    const reply = messages[1]!
    messages[1] = { ...reply, parts: [...reply.parts, { type: 'data-activity', data: { kind: 'idle' } } as HarnessUIMessage['parts'][number]] }
    const { id } = await t.deps.chats.importChat({ exported: exportOf(agentChat(messages)), id: 'keep', restore: true })
    expect((await t.deps.chats.get(id)).messages).toEqual(agentMessages())
  })
})
