// Upgrades of older databases through the hand-written backfills (ARCHITECTURE.md 8 "Migrations"):
// - v1 -> v1.1 through migration 0001 (C8-T7, ADR-023): a database that only had `0000_initial_schema` (linear chats)
//   is migrated with the real folder; the backfill must turn every chat into a linear parent chain whose active leaf is
//   its last message (null for an empty chat), add the new index and `chat_shares`, and lose nothing.
// - v1.1 -> v1.2 through migration 0002 (C11-T6, ADR-030): a database with `0000` + `0001` and branched chats is migrated
//   with the real folder; the backfill must point exactly the parents on each chat's active path at their child on the
//   path (null everywhere else), so switching away from a version and back restores what the user saw.
// Each set of checks also runs against a copy of the folder without the backfill and must fail there, so these tests
// notice a missing or broken backfill.
// - v1.2 -> v1.3 through migration 0004 (C14-T7, ADR-031): a database with `0000` ... `0003` and chats is migrated with
//   the real folder; 0004 must be plain `CREATE` / `ALTER` / `INDEX` statements (a rebuild of `chats` would cascade-delete
//   messages inside the migration transaction) and every chat must survive without a project (`project_id` null).
import type { Database } from './client.ts'
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chatDetailSchema, chatSummarySchema, cursorPageSchema } from '@harness-forge/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { LISTING_TTL_MS } from '../catalog/index.ts'
import { buildTree, latestLeafUnder } from '../services/chats/tree.ts'
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
const REMEMBERED = JOURNAL.entries.find(entry => entry.tag.startsWith('0002_'))
const PROJECTS = JOURNAL.entries.find(entry => entry.tag.startsWith('0004_'))

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

// ---------- v1.1 -> v1.2: migration 0002 (remembered versions) ----------

/** A migrations folder holding only 0000 + 0001 (their SQL + a two-entry journal): the schema of a v1.1 data directory. */
function v11Folder(): string {
  if (INITIAL === undefined || TREE === undefined)
    throw new Error('migration 0000 or 0001 is missing from the journal')
  const dir = tempDir()
  mkdirSync(join(dir, 'meta'))
  for (const entry of [INITIAL, TREE])
    copyFileSync(join(REAL_FOLDER, `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`))
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({ ...JOURNAL, entries: [INITIAL, TREE] }))
  return dir
}

/** The statements of migration 0002 (split like `migrate()` does). */
function rememberedStatements(folder = REAL_FOLDER): string[] {
  if (REMEMBERED === undefined)
    throw new Error('migration 0002 is missing from the journal')
  return readFileSync(join(folder, `${REMEMBERED.tag}.sql`), 'utf8').split('--> statement-breakpoint')
}

const REMEMBERED_BACKFILL = /UPDATE\s+`?messages`?\s+SET\s+`?selected_child_id/i

/** A copy of the real folder whose 0002 lacks the hand-written backfill (its recursive UPDATE statement). */
function folderWithoutRememberedBackfill(): string {
  const dir = tempDir()
  cpSync(REAL_FOLDER, dir, { recursive: true })
  const statements = rememberedStatements(dir)
  const kept = statements.filter(statement => !REMEMBERED_BACKFILL.test(statement))
  expect(statements.length - kept.length, 'the backfill of 0002 is one UPDATE statement').toBe(1)
  writeFileSync(join(dir, `${REMEMBERED!.tag}.sql`), kept.join('--> statement-breakpoint'))
  return dir
}

const CHAT_BRANCHED = '0199a8f0-0000-7000-8000-0000000000b1'
const CHAT_LINEAR = '0199a8f0-0000-7000-8000-0000000000b2'
const CHAT_RUNNING = '0199a8f0-0000-7000-8000-0000000000b3'
const CHAT_DANGLING = '0199a8f0-0000-7000-8000-0000000000b4'
const CHAT_NONE = '0199a8f0-0000-7000-8000-0000000000b5'

/** Message ids by name (`msg_` + 16 characters). */
const M = {
  A: 'msg_b100000000000000',
  RA: 'msg_b100000000000001',
  B: 'msg_b100000000000002',
  RB: 'msg_b100000000000003',
  B2: 'msg_b100000000000004',
  RB2: 'msg_b100000000000005',
  A2: 'msg_b100000000000006',
  RA2: 'msg_b100000000000007',
  U: 'msg_b200000000000000',
  R: 'msg_b200000000000001',
  M1: 'msg_b300000000000000',
  M2: 'msg_b300000000000001',
  M3: 'msg_b300000000000002',
  D1: 'msg_b400000000000000',
  D2: 'msg_b400000000000001',
} as const

interface V11Message {
  id: string
  chatId: string
  parentId: string | null
  seq: number
  role: 'user' | 'assistant'
}

/**
 * v1.1 data (ARCHITECTURE.md 6.8):
 * - BRANCHED: two first messages A / A2 (A2 = an edit of A, newest), and under A's reply two versions B / B2 (B2 newer);
 *   the active leaf is B's reply RB although B2, RB2, A2 and RA2 are newer (the user switched back to B);
 * - LINEAR: U -> R, leaf R; RUNNING: M1 -> M2 -> M3 with the leaf M2 (as while a run holds the chat);
 * - DANGLING: the stored leaf is not a message of the chat (damaged data); NONE: an empty chat.
 */
const V11_MESSAGES: V11Message[] = [
  { id: M.A, chatId: CHAT_BRANCHED, parentId: null, seq: 0, role: 'user' },
  { id: M.RA, chatId: CHAT_BRANCHED, parentId: M.A, seq: 1, role: 'assistant' },
  { id: M.B, chatId: CHAT_BRANCHED, parentId: M.RA, seq: 2, role: 'user' },
  { id: M.RB, chatId: CHAT_BRANCHED, parentId: M.B, seq: 3, role: 'assistant' },
  { id: M.B2, chatId: CHAT_BRANCHED, parentId: M.RA, seq: 4, role: 'user' },
  { id: M.RB2, chatId: CHAT_BRANCHED, parentId: M.B2, seq: 5, role: 'assistant' },
  { id: M.A2, chatId: CHAT_BRANCHED, parentId: null, seq: 6, role: 'user' },
  { id: M.RA2, chatId: CHAT_BRANCHED, parentId: M.A2, seq: 7, role: 'assistant' },
  { id: M.U, chatId: CHAT_LINEAR, parentId: null, seq: 0, role: 'user' },
  { id: M.R, chatId: CHAT_LINEAR, parentId: M.U, seq: 1, role: 'assistant' },
  { id: M.M1, chatId: CHAT_RUNNING, parentId: null, seq: 0, role: 'user' },
  { id: M.M2, chatId: CHAT_RUNNING, parentId: M.M1, seq: 1, role: 'assistant' },
  { id: M.M3, chatId: CHAT_RUNNING, parentId: M.M2, seq: 2, role: 'user' },
  { id: M.D1, chatId: CHAT_DANGLING, parentId: null, seq: 0, role: 'user' },
  { id: M.D2, chatId: CHAT_DANGLING, parentId: M.D1, seq: 1, role: 'assistant' },
]

const V11_LEAVES: Record<string, string | null> = {
  [CHAT_BRANCHED]: M.RB,
  [CHAT_LINEAR]: M.R,
  [CHAT_RUNNING]: M.M2,
  [CHAT_DANGLING]: 'msg_missing000000000',
  [CHAT_NONE]: null,
}

/** The pointers the backfill must produce: the parents on the active paths only (A -> RA -> B -> RB, U -> R, M1 -> M2). */
const EXPECTED_POINTERS: Record<string, string | null> = {
  ...Object.fromEntries(V11_MESSAGES.map(message => [message.id, null])),
  [M.A]: M.RA,
  [M.RA]: M.B,
  [M.B]: M.RB,
  [M.U]: M.R,
  [M.M1]: M.M2,
}

/** The v1.1 columns of every message, as stored. */
async function v11MessageRows(database: Database): Promise<Record<string, unknown>[]> {
  const result = await database.client.execute(
    'SELECT id, chat_id, parent_id, seq, role, parts, metadata, search_text, created_at, updated_at FROM messages ORDER BY chat_id, seq',
  )
  return result.rows.map(row => ({ ...row }))
}

/** Every chat row, as stored. */
async function chatRows(database: Database): Promise<Record<string, unknown>[]> {
  const result = await database.client.execute('SELECT * FROM chats ORDER BY id')
  return result.rows.map(row => ({ ...row }))
}

/** Creates a v1.1 database file (0000 + 0001 only) with the chats above; returns the stored message and chat rows. */
async function seedV11Database(path: string): Promise<{ messages: Record<string, unknown>[], chats: Record<string, unknown>[] }> {
  const database = await open(path)
  await migrateDatabase(database.db, { migrationsFolder: v11Folder() })
  const columns = await database.client.execute('PRAGMA table_info(messages)')
  expect(columns.rows.map(row => String(row.name))).toContain('parent_id')
  expect(columns.rows.map(row => String(row.name))).not.toContain('selected_child_id')
  for (const [index, [id, leaf]] of Object.entries(V11_LEAVES).entries()) {
    await database.client.execute({
      sql: 'INSERT INTO chats (id, title, title_source, settings, pinned, archived, pending_approval, active_leaf_id, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0, 0, ?, ?, ?)',
      args: [id, `Chat ${index}`, 'user', '{}', leaf, 1000 + index, 2000 + index],
    })
  }
  for (const message of V11_MESSAGES) {
    const text = `${message.role} ${message.id}`
    await database.client.execute({
      sql: 'INSERT INTO messages (id, chat_id, parent_id, seq, role, parts, metadata, search_text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      args: [message.id, message.chatId, message.parentId, message.seq, message.role, JSON.stringify([{ type: 'text', text }]), JSON.stringify({ modelRef: 'mock:echo', startedAt: 1 }), text, 3000 + message.seq, 4000 + message.seq],
    })
  }
  const rows = { messages: await v11MessageRows(database), chats: await chatRows(database) }
  database.close()
  return rows
}

/** Everything the 0002 backfill must have produced, as a list of problems (empty = upgraded correctly). */
async function rememberedProblems(database: Database): Promise<string[]> {
  const problems: string[] = []
  const pointers = await database.client.execute('SELECT id, selected_child_id FROM messages')
  for (const row of pointers.rows) {
    const id = String(row.id)
    const actual = row.selected_child_id === null ? null : String(row.selected_child_id)
    if (actual !== EXPECTED_POINTERS[id])
      problems.push(`pointer of ${id} is ${actual}, expected ${EXPECTED_POINTERS[id]}`)
  }
  // The upgrade probe of Gate P6-0b: pointers only on active-path parents, and every active-path parent has one.
  const path = `WITH RECURSIVE path(chat_id, id, parent_id, seq) AS (
    SELECT m.chat_id, m.id, m.parent_id, m.seq FROM chats c JOIN messages m ON m.chat_id = c.id AND m.id = c.active_leaf_id
    UNION ALL SELECT p.chat_id, p.id, p.parent_id, p.seq FROM messages p
    JOIN path ON p.id = path.parent_id AND p.chat_id = path.chat_id AND p.seq < path.seq)`
  const offPath = await scalar(database, `${path} SELECT count(*) AS n FROM messages m WHERE m.selected_child_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM path WHERE path.parent_id = m.id AND path.id = m.selected_child_id)`)
  if (offPath !== 0)
    problems.push(`${offPath} pointers off the active paths`)
  const missing = await scalar(database, `${path} SELECT count(*) AS n FROM path WHERE path.parent_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = path.parent_id AND m.selected_child_id = path.id)`)
  if (missing !== 0)
    problems.push(`${missing} active-path parents without a pointer`)
  // Every pointer names a real child (a message of the same chat whose parent is the pointing message).
  const strays = await scalar(database, `SELECT count(*) AS n FROM messages m WHERE m.selected_child_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM messages c WHERE c.id = m.selected_child_id AND c.parent_id = m.id AND c.chat_id = m.chat_id)`)
  if (strays !== 0)
    problems.push(`${strays} pointers that name no child`)
  return problems
}

/**
 * The leaf a switch to `messageId` shows with remembered versions (ADR-030, the rule of `rememberedLeafUnder`): walk
 * down through the remembered child while it is a child of the node, else the only child, else the latest leaf.
 */
async function rememberedLeaf(database: Database, chatId: string, messageId: string): Promise<string | null> {
  const result = await database.client.execute({ sql: 'SELECT id, parent_id, seq, role, selected_child_id FROM messages WHERE chat_id = ?', args: [chatId] })
  const rows = result.rows.map(row => ({
    id: String(row.id),
    parentId: row.parent_id === null ? null : String(row.parent_id),
    seq: Number(row.seq),
    role: String(row.role) as 'user' | 'assistant',
    selectedChildId: row.selected_child_id === null ? null : String(row.selected_child_id),
  }))
  const tree = buildTree(rows)
  const pointer = new Map(rows.map(row => [row.id, row.selectedChildId]))
  let node = tree.byId.has(messageId) ? messageId : null
  while (node !== null) {
    const children = tree.childrenOf.get(node) ?? []
    if (children.length === 0)
      return node
    const remembered = pointer.get(node)
    if (remembered !== null && remembered !== undefined && children.includes(remembered))
      node = remembered
    else if (children.length === 1)
      node = children[0]!
    else
      return latestLeafUnder(tree, node)
  }
  return null
}

describe('upgrade of a v1.1 database through migration 0002 (remembered versions)', () => {
  it('0002 is one ALTER TABLE ... ADD plus the hand-written backfill, never a table rebuild', () => {
    const statements = rememberedStatements()
    expect(statements).toHaveLength(2)
    expect(statements[0]?.trim()).toBe('ALTER TABLE `messages` ADD `selected_child_id` text;')
    expect(REMEMBERED_BACKFILL.test(statements[1] ?? '')).toBe(true)
    expect(statements[1]).toMatch(/WITH RECURSIVE path/)
    const sql = statements.join('\n')
    for (const forbidden of [/DROP\s+TABLE/i, /__new_/i, /PRAGMA\s+foreign_keys/i])
      expect(sql, String(forbidden)).not.toMatch(forbidden)
    expect(JOURNAL.entries.slice(0, 3)).toEqual([INITIAL, TREE, REMEMBERED])
  })

  it('points exactly the active-path parents at their child on the path, keeps every row, matches a fresh schema', async () => {
    const path = join(tempDir(), 'harness.db')
    const before = await seedV11Database(path)
    const database = await open(path)
    await migrateDatabase(database.db)

    expect(await rememberedProblems(database)).toEqual([])
    expect(await v11MessageRows(database)).toEqual(before.messages)
    // 0004 (Phase 7) adds `project_id` to every chat row: null, nothing else changes.
    expect(await chatRows(database)).toEqual(before.chats.map(row => ({ ...row, project_id: null })))
    const applied = await database.client.execute('SELECT created_at FROM __drizzle_migrations ORDER BY created_at')
    expect(applied.rows.map(row => Number(row.created_at))).toEqual(JOURNAL.entries.map(entry => entry.when))
    const fresh = await open(':memory:')
    await migrateDatabase(fresh.db)
    expect(await schemaShape(database)).toEqual(await schemaShape(fresh))
    const foreignKeys = await database.client.execute('PRAGMA foreign_keys')
    expect(Number(foreignKeys.rows[0]?.foreign_keys)).toBe(1)

    // Remembered is not latest: switching back to A restores A -> RA -> B -> RB (what was shown), where v1.1's "latest
    // leaf" rule would show B2's newer reply.
    expect(await rememberedLeaf(database, CHAT_BRANCHED, M.A)).toBe(M.RB)
    const rows = await database.client.execute({ sql: 'SELECT id, parent_id, seq, role FROM messages WHERE chat_id = ?', args: [CHAT_BRANCHED] })
    const tree = buildTree(rows.rows.map(row => ({ id: String(row.id), parentId: row.parent_id === null ? null : String(row.parent_id), seq: Number(row.seq), role: String(row.role) as 'user' | 'assistant' })))
    expect(latestLeafUnder(tree, M.A)).toBe(M.RB2)
    // Versions never shown keep null: their latest leaf wins until they are shown.
    expect(await rememberedLeaf(database, CHAT_BRANCHED, M.A2)).toBe(M.RA2)
    expect(await rememberedLeaf(database, CHAT_BRANCHED, M.B2)).toBe(M.RB2)

    // Idempotent: migrating again applies nothing and changes no pointer.
    await migrateDatabase(database.db)
    expect(await scalar(database, 'SELECT count(*) AS n FROM __drizzle_migrations')).toBe(JOURNAL.entries.length)
    expect(await rememberedProblems(database)).toEqual([])
  })

  it('the same checks fail when 0002 lacks the backfill (the test notices a missing backfill)', async () => {
    const path = join(tempDir(), 'harness.db')
    const before = await seedV11Database(path)
    const database = await open(path)
    await migrateDatabase(database.db, { migrationsFolder: folderWithoutRememberedBackfill() })

    expect(await v11MessageRows(database)).toEqual(before.messages)
    expect(await scalar(database, 'SELECT count(*) AS n FROM messages WHERE selected_child_id IS NOT NULL')).toBe(0)
    expect(await rememberedProblems(database)).toEqual(expect.arrayContaining([
      `pointer of ${M.A} is null, expected ${M.RA}`,
      `pointer of ${M.B} is null, expected ${M.RB}`,
      '5 active-path parents without a pointer',
    ]))
    // Without the pointers a switch back to A falls back to the latest leaf: the path the user saw is lost.
    expect(await rememberedLeaf(database, CHAT_BRANCHED, M.A)).toBe(M.RB2)
  })

  it('boots on the upgraded database: every chat, path and version is served as before', async () => {
    const dataDir = tempDir()
    const databasePath = join(dataDir, 'harness.db')
    await seedV11Database(databasePath)
    const t = await createTestApp({ dataDir, databasePath, start: false })
    try {
      const list = cursorPageSchema(chatSummarySchema).parse(await (await t.request('/api/chats')).json())
      expect(list.items.map(chat => chat.id).sort()).toEqual(Object.keys(V11_LEAVES).sort())

      const branched = chatDetailSchema.parse(await (await t.request(`/api/chats/${CHAT_BRANCHED}`)).json())
      expect(branched.messages.map(message => message.id)).toEqual([M.A, M.RA, M.B, M.RB])
      expect(branched.branches).toEqual({
        [M.A]: { siblings: [M.A, M.A2], index: 0 },
        [M.B]: { siblings: [M.B, M.B2], index: 0 },
      })
      const running = chatDetailSchema.parse(await (await t.request(`/api/chats/${CHAT_RUNNING}`)).json())
      expect(running.messages.map(message => message.id)).toEqual([M.M1, M.M2])
      // A stored leaf outside the chat falls back to the chat's most recent message (ARCHITECTURE.md 6.8).
      const dangling = chatDetailSchema.parse(await (await t.request(`/api/chats/${CHAT_DANGLING}`)).json())
      expect(dangling.messages.map(message => message.id)).toEqual([M.D1, M.D2])
      expect(chatDetailSchema.parse(await (await t.request(`/api/chats/${CHAT_NONE}`)).json()).messages).toEqual([])
    }
    finally {
      await t.close()
    }
  })
})

// Migration 0003 (Phase 6, coordinator K5): v1.2 changes what a provider listing holds (media ids with their kinds,
// image output from the listing, new builtin seed models), so every successful listing cached by v1.1 is aged by one
// listing TTL: the catalog still serves it (its `fetchedAt` is not null) and refreshes it at the next start because it
// is stale; a failed refresh keeps it. A row that never fetched successfully (`fetched_at` null) is left alone.
const REFRESH = JOURNAL.entries.find(entry => entry.tag.startsWith('0003_'))

/** A migrations folder holding 0000 – 0002 (the schema of a data directory that ran a v1.2 pre-release). */
function beforeRefreshFolder(): string {
  if (INITIAL === undefined || TREE === undefined || REMEMBERED === undefined)
    throw new Error('migration 0000, 0001 or 0002 is missing from the journal')
  const dir = tempDir()
  mkdirSync(join(dir, 'meta'))
  for (const entry of [INITIAL, TREE, REMEMBERED])
    copyFileSync(join(REAL_FOLDER, `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`))
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({ ...JOURNAL, entries: [INITIAL, TREE, REMEMBERED] }))
  return dir
}

describe('migration 0003 (cached model listings marked stale)', () => {
  it('0003 is one UPDATE of model_cache.fetched_at, never a schema change', () => {
    if (REFRESH === undefined)
      throw new Error('migration 0003 is missing from the journal')
    const sql = readFileSync(join(REAL_FOLDER, `${REFRESH.tag}.sql`), 'utf8')
    const statements = sql.split('--> statement-breakpoint').map(statement => statement.replace(/^--.*$/gm, '').trim()).filter(Boolean)
    expect(statements).toEqual([`UPDATE \`model_cache\` SET \`fetched_at\` = \`fetched_at\` - ${LISTING_TTL_MS} WHERE \`fetched_at\` IS NOT NULL;`])
    expect(JOURNAL.entries.slice(0, 4)).toEqual([INITIAL, TREE, REMEMBERED, REFRESH])
  })

  it('ages every successful cached listing by one TTL, keeps its models, leaves never-fetched rows alone', async () => {
    const database = await open(join(tempDir(), 'harness.db'))
    await migrateDatabase(database.db, { migrationsFolder: beforeRefreshFolder() })
    const models = JSON.stringify([{ id: 'echo', name: 'Echo' }])
    const fetchedAt = 1_790_000_000_000
    await database.client.execute({
      sql: 'INSERT INTO model_cache (provider_id, models, fetched_at, attempted_at, error) VALUES (?, ?, ?, ?, NULL)',
      args: ['mock', models, fetchedAt, fetchedAt],
    })
    // A provider whose first listing failed: no successful fetch yet.
    await database.client.execute({
      sql: 'INSERT INTO model_cache (provider_id, models, fetched_at, attempted_at, error) VALUES (?, ?, NULL, ?, ?)',
      args: ['ollama', '[]', fetchedAt, '{"code":"provider_unreachable","message":"down"}'],
    })
    await migrateDatabase(database.db)
    const rows = (await database.client.execute('SELECT provider_id, models, fetched_at FROM model_cache ORDER BY provider_id')).rows
    expect(rows.map(row => [row.provider_id, row.models, row.fetched_at])).toEqual([
      ['mock', models, fetchedAt - LISTING_TTL_MS],
      ['ollama', '[]', null],
    ])
    // The catalog still serves the aged listing (it only skips listings without a successful fetch) and finds it stale.
    const aged = Number(rows[0]?.fetched_at)
    expect(Date.now() - aged).toBeGreaterThanOrEqual(LISTING_TTL_MS)
  })
})

// ---------- v1.2 -> v1.3: migration 0004 (projects) ----------

/** A migrations folder holding 0000 - 0003 (their SQL + a four-entry journal): the schema of a v1.2 data directory. */
function v12Folder(): string {
  if (INITIAL === undefined || TREE === undefined || REMEMBERED === undefined || REFRESH === undefined)
    throw new Error('migration 0000, 0001, 0002 or 0003 is missing from the journal')
  const dir = tempDir()
  mkdirSync(join(dir, 'meta'))
  for (const entry of [INITIAL, TREE, REMEMBERED, REFRESH])
    copyFileSync(join(REAL_FOLDER, `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`))
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({ ...JOURNAL, entries: [INITIAL, TREE, REMEMBERED, REFRESH] }))
  return dir
}

/** The statements of migration 0004 without comments and blank lines (split like `migrate()` does). */
function projectsStatements(): string[] {
  if (PROJECTS === undefined)
    throw new Error('migration 0004 is missing from the journal')
  return readFileSync(join(REAL_FOLDER, `${PROJECTS.tag}.sql`), 'utf8')
    .split('--> statement-breakpoint')
    .map(statement => statement.replace(/^--.*$/gm, '').trim())
    .filter(Boolean)
}

const CHAT_P1 = '0199a8f0-0000-7000-8000-0000000000c1'
const CHAT_P2 = '0199a8f0-0000-7000-8000-0000000000c2'
const CHAT_P3 = '0199a8f0-0000-7000-8000-0000000000c3'

/** Every row of a table, as stored, ordered by `order`. */
async function rows(database: Database, table: string, order: string): Promise<Record<string, unknown>[]> {
  const result = await database.client.execute(`SELECT * FROM ${table} ORDER BY ${order}`)
  return result.rows.map(row => ({ ...row }))
}

/**
 * Creates a v1.2 database file (0000 - 0003) with three chats (a linear one with a share link and a usage row, an
 * archived empty one, a pinned one), their messages and a cached model listing; returns every row of those tables.
 */
async function seedV12Database(path: string): Promise<Record<'chats' | 'messages' | 'chat_shares' | 'usage', Record<string, unknown>[]>> {
  const database = await open(path)
  await migrateDatabase(database.db, { migrationsFolder: v12Folder() })
  const columns = await database.client.execute('PRAGMA table_info(chats)')
  expect(columns.rows.map(row => String(row.name))).not.toContain('project_id')
  const tables = await database.client.execute(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projects'`)
  expect(tables.rows).toHaveLength(0)
  const chatsSeed: Array<[string, string | null, number, number]> = [
    [CHAT_P1, 'msg_c100000000000001', 0, 0],
    [CHAT_P2, null, 0, 1],
    [CHAT_P3, 'msg_c300000000000000', 1, 0],
  ]
  for (const [index, [id, leaf, pinned, archived]] of chatsSeed.entries()) {
    await database.client.execute({
      sql: 'INSERT INTO chats (id, title, title_source, model_ref, settings, pinned, archived, pending_approval, active_leaf_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)',
      args: [id, `Chat ${index}`, 'user', 'mock:echo', '{"toolMode":"ask"}', pinned, archived, leaf, 1000 + index, 2000 + index],
    })
  }
  const messagesSeed: Array<[string, string, string | null, number, 'user' | 'assistant']> = [
    ['msg_c100000000000000', CHAT_P1, null, 0, 'user'],
    ['msg_c100000000000001', CHAT_P1, 'msg_c100000000000000', 1, 'assistant'],
    ['msg_c300000000000000', CHAT_P3, null, 0, 'user'],
  ]
  for (const [id, chatId, parentId, seq, role] of messagesSeed) {
    await database.client.execute({
      sql: 'INSERT INTO messages (id, chat_id, parent_id, selected_child_id, seq, role, parts, metadata, search_text, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)',
      args: [id, chatId, parentId, seq, role, JSON.stringify([{ type: 'text', text: `${role} ${id}` }]), JSON.stringify({ modelRef: 'mock:echo', startedAt: 1 }), `${role} ${id}`, 3000 + seq, 4000 + seq],
    })
  }
  await database.client.execute({
    sql: `INSERT INTO chat_shares (id, chat_id, options, snapshot, snapshot_at, created_at, updated_at) VALUES ('shr_0000000000000001', ?, '{}', '{}', 1, 1, 1)`,
    args: [CHAT_P1],
  })
  await database.client.execute({
    sql: 'INSERT INTO usage (chat_id, message_id, purpose, provider_id, model_id, input, output, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    args: [CHAT_P1, 'msg_c100000000000001', 'chat', 'mock', 'echo', 3, 4, 5000],
  })
  const seeded = {
    chats: await rows(database, 'chats', 'id'),
    messages: await rows(database, 'messages', 'chat_id, seq'),
    chat_shares: await rows(database, 'chat_shares', 'id'),
    usage: await rows(database, 'usage', 'id'),
  }
  database.close()
  return seeded
}

describe('upgrade of a v1.2 database through migration 0004 (projects)', () => {
  it('0004 is plain CREATE TABLE / CREATE INDEX / ALTER TABLE ... ADD statements, never a table rebuild', () => {
    expect(projectsStatements()).toEqual([
      expect.stringMatching(/^CREATE TABLE `projects` \(/),
      'CREATE UNIQUE INDEX `projects_path_idx` ON `projects` (`path`);',
      'ALTER TABLE `chats` ADD `project_id` text;',
      'CREATE INDEX `chats_project_idx` ON `chats` (`project_id`,`archived`,"updated_at" DESC,"id" DESC);',
    ])
    const sql = projectsStatements().join('\n')
    for (const forbidden of [/DROP\s+TABLE/i, /__new_/i, /PRAGMA\s+foreign_keys/i, /REFERENCES/i, /\bUPDATE\b/i, /\bDELETE\b/i, /\bINSERT\b/i])
      expect(sql, String(forbidden)).not.toMatch(forbidden)
    // The new column has no default and no NOT NULL: SQLite adds it in place.
    expect(projectsStatements()[2]).not.toMatch(/NOT NULL|DEFAULT/i)
    expect(JOURNAL.entries.slice(0, 5)).toEqual([INITIAL, TREE, REMEMBERED, REFRESH, PROJECTS])
    expect(PROJECTS?.tag).toBe('0004_projects')
  })

  it('every chat survives without a project; messages, shares and usage are untouched; the schema matches a fresh one', async () => {
    const path = join(tempDir(), 'harness.db')
    const before = await seedV12Database(path)
    const database = await open(path)
    await migrateDatabase(database.db)

    expect(await rows(database, 'chats', 'id')).toEqual(before.chats.map(row => ({ ...row, project_id: null })))
    expect(await scalar(database, 'SELECT count(*) AS n FROM chats WHERE project_id IS NOT NULL')).toBe(0)
    expect(await rows(database, 'messages', 'chat_id, seq')).toEqual(before.messages)
    expect(await rows(database, 'chat_shares', 'id')).toEqual(before.chat_shares)
    expect(await rows(database, 'usage', 'id')).toEqual(before.usage)
    expect(await scalar(database, 'SELECT count(*) AS n FROM projects')).toBe(0)

    const applied = await database.client.execute('SELECT created_at FROM __drizzle_migrations ORDER BY created_at')
    expect(applied.rows.map(row => Number(row.created_at))).toEqual(JOURNAL.entries.map(entry => entry.when))
    const shape = await schemaShape(database)
    expect(shape.tables).toEqual([...TABLE_NAMES].sort())
    expect(shape.tables).toHaveLength(16)
    expect(shape.indexes.projects_path_idx).toEqual(['path'])
    expect(shape.indexes.chats_project_idx).toEqual(['project_id', 'archived', 'updated_at', 'id'])
    const fresh = await open(':memory:')
    await migrateDatabase(fresh.db)
    expect(shape).toEqual(await schemaShape(fresh))
    const foreignKeys = await database.client.execute('PRAGMA foreign_keys')
    expect(Number(foreignKeys.rows[0]?.foreign_keys)).toBe(1)
    expect(shape.foreignKeys.chats).toEqual([])

    // Idempotent: migrating again applies nothing.
    await migrateDatabase(database.db)
    expect(await scalar(database, 'SELECT count(*) AS n FROM __drizzle_migrations')).toBe(JOURNAL.entries.length)
  })

  it('boots on the upgraded database: every chat is served, without a project', async () => {
    const dataDir = tempDir()
    const databasePath = join(dataDir, 'harness.db')
    await seedV12Database(databasePath)
    const t = await createTestApp({ dataDir, databasePath, start: false })
    try {
      const list = cursorPageSchema(chatSummarySchema).parse(await (await t.request('/api/chats')).json())
      expect(list.items.map(chat => chat.id).sort()).toEqual([CHAT_P1, CHAT_P3])
      expect(list.items.every(chat => chat.projectId === null)).toBe(true)
      const archived = cursorPageSchema(chatSummarySchema).parse(await (await t.request('/api/chats?archived=true')).json())
      expect(archived.items).toMatchObject([{ id: CHAT_P2, projectId: null }])
      const detail = chatDetailSchema.parse(await (await t.request(`/api/chats/${CHAT_P1}`)).json())
      expect(detail).toMatchObject({ projectId: null, settings: { toolMode: 'ask' } })
      expect(detail.messages.map(message => message.id)).toEqual(['msg_c100000000000000', 'msg_c100000000000001'])
      expect((await t.deps.chats.find(CHAT_P3))?.projectId).toBeNull()
    }
    finally {
      await t.close()
    }
  })
})
