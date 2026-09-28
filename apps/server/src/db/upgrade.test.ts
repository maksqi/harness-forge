// Upgrade of a v1 database through migration 0001 (C8-T7, ADR-023, ARCHITECTURE.md 8 "Migrations"): a database that
// only had `0000_initial_schema` (linear chats) is migrated with the real folder; the hand-written backfill must turn
// every chat into a linear parent chain whose active leaf is its last message (null for an empty chat), add the new
// index and `chat_shares`, and lose nothing. The same checks run against a copy of the folder without the backfill and
// must fail there, so this test notices a missing or broken backfill.
import type { Database } from './client.ts'
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chatDetailSchema, chatSummarySchema, cursorPageSchema } from '@harness-forge/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestApp } from '../testing/create-test-app.ts'
import { openDatabase } from './client.ts'
import { migrateDatabase, resolveMigrationsFolder } from './migrate.ts'
import { TABLE_NAMES } from './schema.ts'

interface JournalEntry {
  idx: number
  version: string
  when: number
  tag: string
  breakpoints: boolean
}

interface Journal {
  version: string
  dialect: string
  entries: JournalEntry[]
}

const REAL_FOLDER = resolveMigrationsFolder()
const JOURNAL = JSON.parse(readFileSync(join(REAL_FOLDER, 'meta', '_journal.json'), 'utf8')) as Journal
const INITIAL = JOURNAL.entries.find(entry => entry.tag === '0000_initial_schema')
const TREE = JOURNAL.entries.find(entry => entry.tag.startsWith('0001_'))

const opened: Database[] = []
const tempDirs: string[] = []

afterEach(() => {
  for (const database of opened.splice(0))
    database.close()
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-forge-upgrade-'))
  tempDirs.push(dir)
  return dir
}

async function open(path: string): Promise<Database> {
  const database = await openDatabase({ path })
  opened.push(database)
  return database
}

/** A migrations folder holding only 0000 (its SQL + a one-entry journal): the schema of a v1 data directory. */
function v1Folder(): string {
  if (INITIAL === undefined)
    throw new Error('migration 0000_initial_schema is missing from the journal')
  const dir = tempDir()
  mkdirSync(join(dir, 'meta'))
  copyFileSync(join(REAL_FOLDER, `${INITIAL.tag}.sql`), join(dir, `${INITIAL.tag}.sql`))
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({ ...JOURNAL, entries: [INITIAL] }))
  return dir
}

/** A copy of the real folder whose 0001 lacks the hand-written backfill (its two UPDATE statements). */
function folderWithoutBackfill(): string {
  if (TREE === undefined)
    throw new Error('migration 0001 is missing from the journal')
  const dir = tempDir()
  cpSync(REAL_FOLDER, dir, { recursive: true })
  const path = join(dir, `${TREE.tag}.sql`)
  const statements = readFileSync(path, 'utf8').split('--> statement-breakpoint')
  const kept = statements.filter(statement => !/^\s*(?:--[^\n]*\n\s*)*UPDATE\b/i.test(statement))
  expect(statements.length - kept.length, 'the backfill of 0001 is two UPDATE statements').toBe(2)
  writeFileSync(path, kept.join('--> statement-breakpoint'))
  return dir
}

const CHAT_A = '0199a8f0-0000-7000-8000-00000000000a'
const CHAT_B = '0199a8f0-0000-7000-8000-00000000000b'
const CHAT_EMPTY = '0199a8f0-0000-7000-8000-00000000000c'

/** v1 messages: chat A has 4 messages with `seq` gaps (possible after v1 edits), inserted out of order; B has one. */
const V1_MESSAGES = [
  { id: 'msg_a000000000000004', chatId: CHAT_A, seq: 4, role: 'user', text: 'second question' },
  { id: 'msg_a000000000000000', chatId: CHAT_A, seq: 0, role: 'user', text: 'first question' },
  { id: 'msg_a000000000000006', chatId: CHAT_A, seq: 6, role: 'assistant', text: 'second answer' },
  { id: 'msg_a000000000000001', chatId: CHAT_A, seq: 1, role: 'assistant', text: 'first answer' },
  { id: 'msg_b000000000000000', chatId: CHAT_B, seq: 0, role: 'user', text: 'only message' },
]

/** The chain the backfill must produce (parent = the previous message of the chat by `seq`). */
const EXPECTED_PARENTS: Record<string, string | null> = {
  msg_a000000000000000: null,
  msg_a000000000000001: 'msg_a000000000000000',
  msg_a000000000000004: 'msg_a000000000000001',
  msg_a000000000000006: 'msg_a000000000000004',
  msg_b000000000000000: null,
}

const EXPECTED_LEAVES: Record<string, string | null> = {
  [CHAT_A]: 'msg_a000000000000006',
  [CHAT_B]: 'msg_b000000000000000',
  [CHAT_EMPTY]: null,
}

/** The v1 columns of every message, as stored. */
async function v1MessageRows(database: Database): Promise<Record<string, unknown>[]> {
  const result = await database.client.execute(
    'SELECT id, chat_id, seq, role, parts, metadata, search_text, created_at, updated_at FROM messages ORDER BY chat_id, seq',
  )
  return result.rows.map(row => ({ ...row }))
}

/** Creates a v1 database file (0000 only) with the linear chats above; returns the stored message rows. */
async function seedV1Database(path: string): Promise<Record<string, unknown>[]> {
  const database = await open(path)
  await migrateDatabase(database.db, { migrationsFolder: v1Folder() })
  const columns = await database.client.execute('PRAGMA table_info(messages)')
  expect(columns.rows.map(row => String(row.name))).not.toContain('parent_id')
  for (const [index, id] of [CHAT_A, CHAT_B, CHAT_EMPTY].entries()) {
    await database.client.execute({
      sql: 'INSERT INTO chats (id, title, title_source, settings, pinned, archived, pending_approval, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)',
      args: [id, `Chat ${index}`, 'user', '{}', index === 1 ? 1 : 0, index === 2 ? 1 : 0, 1000 + index, 2000 + index],
    })
  }
  for (const message of V1_MESSAGES) {
    await database.client.execute({
      sql: 'INSERT INTO messages (id, chat_id, seq, role, parts, metadata, search_text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      args: [message.id, message.chatId, message.seq, message.role, JSON.stringify([{ type: 'text', text: message.text }]), JSON.stringify({ modelRef: 'mock:echo', startedAt: 1 }), message.text, 3000 + message.seq, 4000 + message.seq],
    })
  }
  await database.client.execute({
    sql: 'INSERT INTO usage (chat_id, message_id, purpose, provider_id, model_id, input, output, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    args: [CHAT_A, 'msg_a000000000000006', 'chat', 'mock', 'echo', 3, 4, 5000],
  })
  const rows = await v1MessageRows(database)
  database.close()
  return rows
}

async function scalar(database: Database, sql: string): Promise<number> {
  const result = await database.client.execute(sql)
  return Number(result.rows[0]?.n)
}

/** Everything the backfill must have produced, as a list of problems (empty = upgraded correctly). */
async function backfillProblems(database: Database): Promise<string[]> {
  const problems: string[] = []
  const parents = await database.client.execute('SELECT id, parent_id FROM messages')
  for (const row of parents.rows) {
    const id = String(row.id)
    const actual = row.parent_id === null ? null : String(row.parent_id)
    if (actual !== EXPECTED_PARENTS[id])
      problems.push(`parent of ${id} is ${actual}, expected ${EXPECTED_PARENTS[id]}`)
  }
  const leaves = await database.client.execute('SELECT id, active_leaf_id FROM chats')
  for (const row of leaves.rows) {
    const id = String(row.id)
    const actual = row.active_leaf_id === null ? null : String(row.active_leaf_id)
    if (actual !== EXPECTED_LEAVES[id])
      problems.push(`active leaf of ${id} is ${actual}, expected ${EXPECTED_LEAVES[id]}`)
  }
  // The upgrade probe of Gate P5-0b.
  const brokenParents = await scalar(database, `SELECT count(*) AS n FROM messages m WHERE m.parent_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM messages p WHERE p.id = m.parent_id AND p.chat_id = m.chat_id AND p.seq < m.seq)`)
  if (brokenParents !== 0)
    problems.push(`${brokenParents} messages point at a parent that is not an older message of their chat`)
  const firstMessages = await scalar(database, 'SELECT count(*) AS n FROM messages WHERE parent_id IS NULL')
  const chatsWithMessages = await scalar(database, 'SELECT count(DISTINCT chat_id) AS n FROM messages')
  if (firstMessages !== chatsWithMessages)
    problems.push(`${firstMessages} messages without a parent, expected one per chat with messages (${chatsWithMessages})`)
  const wrongLeaves = await scalar(database, `SELECT count(*) AS n FROM chats c WHERE active_leaf_id IS NOT (
    SELECT id FROM messages m WHERE m.chat_id = c.id ORDER BY seq DESC LIMIT 1)`)
  if (wrongLeaves !== 0)
    problems.push(`${wrongLeaves} chats whose active leaf is not their last message`)
  return problems
}

interface SchemaShape {
  tables: string[]
  columns: Record<string, unknown[]>
  indexes: Record<string, string[]>
  foreignKeys: Record<string, unknown[]>
}

/** Tables, columns, indexes (with their columns) and foreign keys of the data model tables. */
async function schemaShape(database: Database): Promise<SchemaShape> {
  const tables = await database.client.execute(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations' ORDER BY name`)
  const shape: SchemaShape = { tables: tables.rows.map(row => String(row.name)), columns: {}, indexes: {}, foreignKeys: {} }
  for (const table of shape.tables) {
    const columns = await database.client.execute(`PRAGMA table_info(${table})`)
    shape.columns[table] = columns.rows.map(row => [row.name, row.type, row.notnull, row.dflt_value, row.pk])
    const keys = await database.client.execute(`PRAGMA foreign_key_list(${table})`)
    shape.foreignKeys[table] = keys.rows.map(row => [row.from, row.table, row.to, row.on_delete])
    const indexes = await database.client.execute(`PRAGMA index_list(${table})`)
    for (const index of indexes.rows) {
      const name = String(index.name)
      const indexColumns = await database.client.execute(`PRAGMA index_info(${name})`)
      shape.indexes[name] = indexColumns.rows.map(row => String(row.name))
    }
  }
  return shape
}

describe('upgrade of a v1 database through migration 0001', () => {
  it('backfills a linear parent chain and the active leaves, adds the index and chat_shares, loses nothing', async () => {
    const path = join(tempDir(), 'harness.db')
    const before = await seedV1Database(path)
    const database = await open(path)
    await migrateDatabase(database.db)

    expect(await backfillProblems(database)).toEqual([])
    expect(await v1MessageRows(database)).toEqual(before)
    const applied = await database.client.execute('SELECT created_at FROM __drizzle_migrations ORDER BY created_at')
    expect(applied.rows.map(row => Number(row.created_at))).toEqual(JOURNAL.entries.map(entry => entry.when))
    expect(JOURNAL.entries.slice(0, 2)).toEqual([INITIAL, TREE])

    const shape = await schemaShape(database)
    expect(shape.tables).toEqual([...TABLE_NAMES].sort())
    expect(shape.indexes.messages_chat_parent_idx).toEqual(['chat_id', 'parent_id'])
    expect(shape.indexes.chat_shares_chat_idx).toEqual(['chat_id'])
    // The upgraded database has exactly the schema of a fresh one.
    const fresh = await open(':memory:')
    await migrateDatabase(fresh.db)
    expect(shape).toEqual(await schemaShape(fresh))

    // Other data is untouched, foreign keys are back on and the new cascade works.
    expect(await scalar(database, 'SELECT count(*) AS n FROM usage WHERE chat_id IS NOT NULL')).toBe(1)
    const foreignKeys = await database.client.execute('PRAGMA foreign_keys')
    expect(Number(foreignKeys.rows[0]?.foreign_keys)).toBe(1)
    await database.client.execute({
      sql: `INSERT INTO chat_shares (id, chat_id, options, snapshot, snapshot_at, created_at, updated_at) VALUES ('shr_0000000000000001', ?, '{}', '{}', 1, 1, 1)`,
      args: [CHAT_A],
    })
    await database.client.execute({ sql: 'DELETE FROM chats WHERE id = ?', args: [CHAT_A] })
    expect(await scalar(database, 'SELECT count(*) AS n FROM chat_shares')).toBe(0)

    // Idempotent: migrating again applies nothing.
    await migrateDatabase(database.db)
    expect(await scalar(database, 'SELECT count(*) AS n FROM __drizzle_migrations')).toBe(JOURNAL.entries.length)
  })

  it('the same checks fail when 0001 lacks the backfill (the test notices a missing backfill)', async () => {
    const path = join(tempDir(), 'harness.db')
    const before = await seedV1Database(path)
    const database = await open(path)
    await migrateDatabase(database.db, { migrationsFolder: folderWithoutBackfill() })

    expect(await v1MessageRows(database)).toEqual(before)
    const problems = await backfillProblems(database)
    expect(problems).toEqual(expect.arrayContaining([
      'parent of msg_a000000000000001 is null, expected msg_a000000000000000',
      `active leaf of ${CHAT_A} is null, expected msg_a000000000000006`,
      '5 messages without a parent, expected one per chat with messages (2)',
      '2 chats whose active leaf is not their last message',
    ]))
  })

  it('boots on the upgraded database: every chat and message is served as before', async () => {
    const dataDir = tempDir()
    const databasePath = join(dataDir, 'harness.db')
    await seedV1Database(databasePath)
    const t = await createTestApp({ dataDir, databasePath, start: false })
    try {
      const list = cursorPageSchema(chatSummarySchema).parse(await (await t.request('/api/chats')).json())
      expect(list.items.map(chat => chat.id).sort()).toEqual([CHAT_A, CHAT_B])
      expect(list.items.find(chat => chat.id === CHAT_B)).toMatchObject({ title: 'Chat 1', pinned: true, createdAt: 1001, updatedAt: 2001 })
      const archived = cursorPageSchema(chatSummarySchema).parse(await (await t.request('/api/chats?archived=true')).json())
      expect(archived.items.map(chat => chat.id)).toEqual([CHAT_EMPTY])

      const detail = chatDetailSchema.parse(await (await t.request(`/api/chats/${CHAT_A}`)).json())
      expect(detail.messages.map(message => message.id)).toEqual(['msg_a000000000000000', 'msg_a000000000000001', 'msg_a000000000000004', 'msg_a000000000000006'])
      expect(detail.branches).toEqual({})
      expect(detail.totals).toMatchObject({ inputTokens: 3, outputTokens: 4 })
      expect((await t.deps.chats.find(CHAT_A))?.activeLeafId).toBe('msg_a000000000000006')
      expect((await t.deps.chats.find(CHAT_EMPTY))?.activeLeafId).toBeNull()
      expect(chatDetailSchema.parse(await (await t.request(`/api/chats/${CHAT_EMPTY}`)).json()).messages).toEqual([])
    }
    finally {
      await t.close()
    }
  })
})
