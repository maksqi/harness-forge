// The SQL helpers of the message store for remembered versions and version deletes (ADR-030): `rememberPathSql` and
// `deleteSubtreeSql`, on the real schema (the service-level behavior is covered by ./index.test.ts).
import type { TestApp } from '../../testing/create-test-app.ts'
import { eq, sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chats, messages } from '../../db/schema.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { deleteSubtreeSql, rememberPathSql } from './store.ts'

const CHAT = '0199a8f0-0000-7000-8000-000000000001'
const OTHER = '0199a8f0-0000-7000-8000-000000000002'

let t: TestApp

function mid(n: number): string {
  return `msg_${n.toString().padStart(16, '0')}`
}

/** Inserts messages `[n, parent]` in `seq` order (`parent` = a message number, or null). */
async function insert(chatId: string, rows: Array<[number, number | null]>, firstSeq = 0): Promise<void> {
  await t.db.insert(messages).values(rows.map(([n, parent], index) => ({
    id: mid(n),
    chatId,
    parentId: parent === null ? null : mid(parent),
    seq: firstSeq + index,
    role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
    parts: [],
  })))
}

async function pointers(chatId: string): Promise<Record<string, string | null>> {
  const rows = await t.db.select({ id: messages.id, selectedChildId: messages.selectedChildId }).from(messages).where(eq(messages.chatId, chatId))
  return Object.fromEntries(rows.map(row => [row.id, row.selectedChildId]))
}

async function remaining(chatId: string): Promise<string[]> {
  const rows = await t.db.select({ id: messages.id }).from(messages).where(eq(messages.chatId, chatId)).orderBy(messages.seq)
  return rows.map(row => row.id)
}

beforeEach(async () => {
  t = await createTestApp({ start: false })
  await t.db.insert(chats).values([{ id: CHAT, createdAt: 1, updatedAt: 1 }, { id: OTHER, createdAt: 1, updatedAt: 1 }])
  // 1 -> 2 -> 3 -> 4; 2 -> 5 -> 6 (a second version of 3); 7 (a second first message) -> 8.
  await insert(CHAT, [[1, null], [2, 1], [3, 2], [4, 3], [5, 2], [6, 5], [7, null], [8, 7]])
  await insert(OTHER, [[20, null], [21, 20]])
})

afterEach(async () => {
  await t.close()
})

describe('rememberPathSql', () => {
  it('points every parent on the path of the active leaf at its child; unchanged rows are not written', async () => {
    await t.db.update(chats).set({ activeLeafId: mid(6) }).where(eq(chats.id, CHAT))
    expect((await t.db.run(rememberPathSql(CHAT, mid(6)))).rowsAffected).toBe(3)
    expect(await pointers(CHAT)).toEqual({ [mid(1)]: mid(2), [mid(2)]: mid(5), [mid(3)]: null, [mid(4)]: null, [mid(5)]: mid(6), [mid(6)]: null, [mid(7)]: null, [mid(8)]: null })
    expect((await t.db.run(rememberPathSql(CHAT, mid(6)))).rowsAffected).toBe(0)
    // Another path moves only the pointers that differ.
    await t.db.update(chats).set({ activeLeafId: mid(4) }).where(eq(chats.id, CHAT))
    expect((await t.db.run(rememberPathSql(CHAT, mid(4)))).rowsAffected).toBe(2)
    expect(await pointers(CHAT)).toMatchObject({ [mid(1)]: mid(2), [mid(2)]: mid(3), [mid(3)]: mid(4), [mid(5)]: mid(6) })
    expect(await pointers(OTHER)).toEqual({ [mid(20)]: null, [mid(21)]: null })
  })

  it('writes nothing unless the leaf is the active leaf (default) or the given condition holds', async () => {
    await t.db.update(chats).set({ activeLeafId: mid(4) }).where(eq(chats.id, CHAT))
    expect((await t.db.run(rememberPathSql(CHAT, mid(6)))).rowsAffected).toBe(0)
    expect((await t.db.run(rememberPathSql(CHAT, mid(6), sql`0`))).rowsAffected).toBe(0)
    expect((await t.db.run(rememberPathSql(CHAT, mid(6), sql`1`))).rowsAffected).toBe(3)
    // A leaf of another chat, or an unknown one, has no path in this chat.
    await t.db.update(chats).set({ activeLeafId: mid(21) }).where(eq(chats.id, CHAT))
    expect((await t.db.run(rememberPathSql(CHAT, mid(21)))).rowsAffected).toBe(0)
    expect((await t.db.run(rememberPathSql(CHAT, 'msg_unknown000000001', sql`1`))).rowsAffected).toBe(0)
  })

  it('stops at bad data: a parent in another chat or with a higher seq is never pointed at the path', async () => {
    // 9's stored parent 21 lives in the other chat; 10's stored parent 11 is newer (a cycle-shaped row).
    await insert(CHAT, [[9, 21], [10, 11], [11, 10]], 8)
    await t.db.update(chats).set({ activeLeafId: mid(9) }).where(eq(chats.id, CHAT))
    expect((await t.db.run(rememberPathSql(CHAT, mid(9)))).rowsAffected).toBe(0)
    await t.db.update(chats).set({ activeLeafId: mid(10) }).where(eq(chats.id, CHAT))
    expect((await t.db.run(rememberPathSql(CHAT, mid(10)))).rowsAffected).toBe(0)
    await t.db.update(chats).set({ activeLeafId: mid(11) }).where(eq(chats.id, CHAT))
    expect((await t.db.run(rememberPathSql(CHAT, mid(11)))).rowsAffected).toBe(1)
    expect(await pointers(CHAT)).toMatchObject({ [mid(10)]: mid(11), [mid(11)]: null })
    expect(await pointers(OTHER)).toEqual({ [mid(20)]: null, [mid(21)]: null })
  })
})

describe('deleteSubtreeSql', () => {
  it('deletes the message and every message after it, nothing else, only when the condition holds', async () => {
    expect((await t.db.run(deleteSubtreeSql(CHAT, mid(5), sql`0`))).rowsAffected).toBe(0)
    expect((await t.db.run(deleteSubtreeSql(CHAT, mid(5), sql`1`))).rowsAffected).toBe(2)
    expect(await remaining(CHAT)).toEqual([1, 2, 3, 4, 7, 8].map(mid))
    // A message of another chat is not in this one; a first message takes its whole tree.
    expect((await t.db.run(deleteSubtreeSql(CHAT, mid(20), sql`1`))).rowsAffected).toBe(0)
    expect((await t.db.run(deleteSubtreeSql(CHAT, mid(1), sql`1`))).rowsAffected).toBe(4)
    expect(await remaining(CHAT)).toEqual([mid(7), mid(8)])
    expect(await remaining(OTHER)).toEqual([mid(20), mid(21)])
  })

  it('follows effective children only (a later row claiming an older parent is not a child of a newer one)', async () => {
    // 9 claims parent 10, which is newer: 9 is a first message, not part of 10's subtree.
    await insert(CHAT, [[9, 10], [10, 8]], 8)
    expect((await t.db.run(deleteSubtreeSql(CHAT, mid(7), sql`1`))).rowsAffected).toBe(3)
    expect(await remaining(CHAT)).toEqual([1, 2, 3, 4, 5, 6, 9].map(mid))
  })

  it('looks children up in the parent index for every step (no scan of the chat per descendant)', async () => {
    const plan = await t.db.all<{ detail: string }>(sql`EXPLAIN QUERY PLAN ${deleteSubtreeSql(CHAT, mid(1), sql`1`)}`)
    expect(plan.map(row => row.detail)).toContain('SEARCH c USING INDEX messages_chat_parent_idx (chat_id=? AND parent_id=?)')
    // A deep chain is deleted in one statement.
    await insert(OTHER, Array.from({ length: 1500 }, (_, index): [number, number | null] => [100 + index, index === 0 ? 21 : 99 + index]), 2)
    expect((await t.db.run(deleteSubtreeSql(OTHER, mid(21), sql`1`))).rowsAffected).toBe(1501)
    expect(await remaining(OTHER)).toEqual([mid(20)])
  })
})
