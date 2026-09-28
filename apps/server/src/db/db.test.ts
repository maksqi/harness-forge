import type { Database } from './client.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from './client.ts'
import { migrateDatabase, resolveMigrationsFolder } from './migrate.ts'
import { chats, messages, TABLE_NAMES, usage } from './schema.ts'

const opened: Database[] = []
const tempDirs: string[] = []

async function freshDatabase(path = ':memory:'): Promise<Database> {
  const database = await openDatabase({ path })
  opened.push(database)
  await migrateDatabase(database.db)
  return database
}

afterEach(() => {
  for (const database of opened.splice(0))
    database.close()
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

async function names(database: Database, type: 'table' | 'index'): Promise<string[]> {
  const result = await database.client.execute({
    sql: `SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    args: [type],
  })
  return result.rows.map(row => String(row.name))
}

describe('migrations', () => {
  it('finds the generated migrations folder of the package', () => {
    expect(resolveMigrationsFolder()).toMatch(/[/\\]apps[/\\]server[/\\]drizzle$/)
  })

  it('creates the 14 tables of the data model', async () => {
    const database = await freshDatabase()
    const tables = (await names(database, 'table')).filter(name => name !== '__drizzle_migrations')
    expect(tables).toEqual([...TABLE_NAMES].sort())
  })

  it('creates the documented indexes', async () => {
    const database = await freshDatabase()
    expect(await names(database, 'index')).toEqual(expect.arrayContaining([
      'chats_list_idx',
      'files_sha256_idx',
      'messages_chat_seq_idx',
      'usage_chat_idx',
      'usage_created_idx',
    ]))
  })

  it('is idempotent', async () => {
    const database = await freshDatabase()
    await expect(migrateDatabase(database.db)).resolves.toBeUndefined()
    const applied = await database.client.execute('SELECT COUNT(*) AS n FROM __drizzle_migrations')
    expect(Number(applied.rows[0]?.n)).toBeGreaterThanOrEqual(1)
  })
})

describe('schema behavior', () => {
  it('cascades message deletes, keeps usage rows with chat_id NULL, applies defaults', async () => {
    const { db } = await freshDatabase()
    const chatId = '0199a8f0-0000-7000-8000-000000000001'
    await db.insert(chats).values({ id: chatId })
    await db.insert(messages).values({ id: 'msg_aaaaaaaaaaaaaaaa', chatId, seq: 0, role: 'user', parts: [{ type: 'text', text: 'hi' }] })
    await db.insert(usage).values({ chatId, providerId: 'mock', modelId: 'echo', input: 3 })

    const [chat] = await db.select().from(chats).where(eq(chats.id, chatId))
    expect(chat).toMatchObject({ pinned: false, archived: false, pendingApproval: false, settings: {}, title: null })
    expect(chat?.createdAt).toBeGreaterThan(0)
    const [message] = await db.select().from(messages)
    expect(message?.parts).toEqual([{ type: 'text', text: 'hi' }])
    expect(message?.searchText).toBe('')

    await db.delete(chats).where(eq(chats.id, chatId))
    expect(await db.select().from(messages)).toEqual([])
    const [row] = await db.select().from(usage)
    expect(row).toMatchObject({ chatId: null, input: 3, output: 0, purpose: 'chat', costUsd: null })
  })

  it('enforces unique (chat_id, seq) and the messages foreign key', async () => {
    const { db } = await freshDatabase()
    const chatId = '0199a8f0-0000-7000-8000-000000000002'
    await db.insert(chats).values({ id: chatId })
    await db.insert(messages).values({ id: 'msg_bbbbbbbbbbbbbbbb', chatId, seq: 0, role: 'user', parts: [] })
    await expect(db.insert(messages).values({ id: 'msg_cccccccccccccccc', chatId, seq: 0, role: 'assistant', parts: [] })).rejects.toThrow()
    await expect(db.insert(messages).values({ id: 'msg_dddddddddddddddd', chatId: 'missing', seq: 0, role: 'user', parts: [] })).rejects.toThrow()
  })

  it('uses WAL and foreign keys for file databases', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-forge-db-'))
    tempDirs.push(dir)
    const database = await freshDatabase(join(dir, 'nested', 'harness.db'))
    const journal = await database.client.execute('PRAGMA journal_mode')
    expect(String(journal.rows[0]?.journal_mode)).toBe('wal')
    const foreignKeys = await database.client.execute('PRAGMA foreign_keys')
    expect(Number(foreignKeys.rows[0]?.foreign_keys)).toBe(1)
    const count = await database.db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM chats`)
    expect(count?.n).toBe(0)
  })
})
