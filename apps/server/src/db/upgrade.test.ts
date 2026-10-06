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
// - v1.3 -> v1.4 through migration 0005 (C19-T10, ADR-036 / ADR-038): a database with `0000` ... `0004`, chats and
//   projects is migrated with the real folder; 0005 must be exactly two `CREATE TABLE` and five `CREATE INDEX`
//   statements (new tables with real cascading foreign keys, nothing else touched), every chat and project survives, and
//   deleting a chat or a project cascades into the new tables while global shell rules stay.
// - v1.4 -> v1.5 through migration 0006 (C24-T6, ADR-038 amendment): a database with `0000` ... `0005`, duplicate shell
//   rules in both scopes and `allow` overrides on `shell` and `current_time` is migrated with the real folder; 0006 must be
//   exactly one `DELETE`, one `UPDATE` and two partial `CREATE UNIQUE INDEX` statements (no rebuild: foreign keys are on),
//   keep the oldest rule of each scope and prefix (ties by id), clear only the `shell` override, lose no chat, message or
//   project, and make a second identical rule a unique violation. The checks also run against copies of 0006 without its
//   `DELETE` or `UPDATE`, which must fail.
// - v1.5 -> v1.6 through migration 0007 (C30-T9, ADR-044 / ADR-046): a database with `0000` ... `0006`, projects, chats
//   and messages is migrated with the real folder; 0007 must be exactly two `CREATE TABLE` and three `CREATE [UNIQUE]
//   INDEX` statements (nothing else touched: foreign keys are on), both new tables start empty, every chat, message and
//   project survives, a second personal definition of the same kind and name is a unique violation, and deleting a chat
//   cascades into its `background_tasks` rows.
// - v1.6 -> v1.7 through migration 0008 (C36-T11, ADR-048 / ADR-049 / ADR-051): a database with `0000` ... `0007`,
//   projects, chats, messages (a delivered background result carrier, a command message), personal definitions and
//   background tasks is migrated with the real folder; 0008 must be exactly two `CREATE TABLE` and one `ALTER TABLE
//   \`projects\` ADD \`output_style\`` (no index, no rebuild: foreign keys are on), both new tables start empty,
//   `output_style` is null on every project, every row survives, deleting a project cascades into its `project_trust`
//   rows and a second (project, sha256) is a primary-key violation.
// - v1.7 -> v1.8 through migration 0009 (C43-T7, ADR-053 / ADR-054 / ADR-057): a database with `0000` ... `0008`,
//   plugins (a builtin, a pinned zip plugin, a linked folder), personal hooks, a project with approvals, personal
//   definitions, chats and messages (with a `data-hook` part) is migrated with the real folder; 0009 must be exactly one
//   `CREATE TABLE`, one `CREATE UNIQUE INDEX` and six `ALTER TABLE … ADD` (two on `plugins`, four on `hooks`; no
//   rebuild, no data change: foreign keys are on), `marketplaces` starts empty, every plugin row is `format = 'harness'`
//   with a null `origin`, every hook row is `type = 'command'` with null `prompt` / `model` / `options`, every row
//   survives, and a second marketplace of the same name is a unique violation.
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
import { primaryKeyViolation, uniqueViolation } from './constraint.test-util.ts'
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
const CHECKPOINTS = JOURNAL.entries.find(entry => entry.tag.startsWith('0005_'))
const SHELL_UNIQUE = JOURNAL.entries.find(entry => entry.tag.startsWith('0006_'))
const CUSTOMIZATIONS = JOURNAL.entries.find(entry => entry.tag.startsWith('0007_'))
const HOOKS_TRUST = JOURNAL.entries.find(entry => entry.tag.startsWith('0008_'))
const CLAUDE_ECOSYSTEM = JOURNAL.entries.find(entry => entry.tag.startsWith('0009_'))

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
    // 16 tables of v1.3 plus the two of 0005 (Phase 8), the two of 0007 (Phase 10), the two of 0008 (Phase 11) and the
    // one of 0009 (Phase 12), applied by the same run.
    expect(shape.tables).toHaveLength(23)
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

// ---------- v1.3 -> v1.4: migration 0005 (workspace checkpoints, shell rules) ----------

/** A migrations folder holding 0000 - 0004 (their SQL + a five-entry journal): the schema of a v1.3 data directory. */
function v13Folder(): string {
  const entries = [INITIAL, TREE, REMEMBERED, REFRESH, PROJECTS]
  if (entries.includes(undefined))
    throw new Error('a migration of 0000 - 0004 is missing from the journal')
  const dir = tempDir()
  mkdirSync(join(dir, 'meta'))
  for (const entry of entries as JournalEntry[])
    copyFileSync(join(REAL_FOLDER, `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`))
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({ ...JOURNAL, entries }))
  return dir
}

/** The statements of migration 0005 without comments and blank lines (split like `migrate()` does). */
function checkpointStatements(): string[] {
  if (CHECKPOINTS === undefined)
    throw new Error('migration 0005 is missing from the journal')
  return readFileSync(join(REAL_FOLDER, `${CHECKPOINTS.tag}.sql`), 'utf8')
    .split('--> statement-breakpoint')
    .map(statement => statement.replace(/^--.*$/gm, '').trim())
    .filter(Boolean)
}

const V13_PROJECT = 'prj_v13project000001'
const V13_OTHER_PROJECT = 'prj_v13project000002'
const CHAT_Q1 = '0199a8f0-0000-7000-8000-0000000000d1'
const CHAT_Q2 = '0199a8f0-0000-7000-8000-0000000000d2'
const CHAT_Q3 = '0199a8f0-0000-7000-8000-0000000000d3'

/**
 * Creates a v1.3 database file (0000 - 0004) with two projects, three chats (two in the first project, one without a
 * project), their messages, a share link and a usage row; returns every row of those tables.
 */
async function seedV13Database(path: string): Promise<Record<'projects' | 'chats' | 'messages' | 'chat_shares' | 'usage', Record<string, unknown>[]>> {
  const database = await open(path)
  await migrateDatabase(database.db, { migrationsFolder: v13Folder() })
  const tables = await database.client.execute(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('workspace_changes', 'shell_rules')`)
  expect(tables.rows).toHaveLength(0)
  const projectsSeed: Array<[string, string]> = [[V13_PROJECT, 'git-demo'], [V13_OTHER_PROJECT, 'other']]
  for (const [id, name] of projectsSeed) {
    await database.client.execute({
      sql: 'INSERT INTO projects (id, name, path, instructions, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      args: [id, name, `/srv/projects/${name}`, id === V13_PROJECT ? 'Be careful.' : null, 100, 200],
    })
  }
  const chatsSeed: Array<[string, string | null, string | null]> = [
    [CHAT_Q1, V13_PROJECT, 'msg_d100000000000001'],
    [CHAT_Q2, V13_PROJECT, 'msg_d200000000000000'],
    [CHAT_Q3, null, 'msg_d300000000000000'],
  ]
  for (const [index, [id, projectId, leaf]] of chatsSeed.entries()) {
    await database.client.execute({
      sql: 'INSERT INTO chats (id, title, title_source, model_ref, settings, pinned, archived, pending_approval, active_leaf_id, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?)',
      args: [id, `Chat ${index}`, 'user', 'mock:workspace', '{"toolMode":"auto"}', leaf, projectId, 1000 + index, 2000 + index],
    })
  }
  const messagesSeed: Array<[string, string, string | null, number, 'user' | 'assistant']> = [
    ['msg_d100000000000000', CHAT_Q1, null, 0, 'user'],
    ['msg_d100000000000001', CHAT_Q1, 'msg_d100000000000000', 1, 'assistant'],
    ['msg_d200000000000000', CHAT_Q2, null, 0, 'user'],
    ['msg_d300000000000000', CHAT_Q3, null, 0, 'user'],
  ]
  for (const [id, chatId, parentId, seq, role] of messagesSeed) {
    const parts = role === 'assistant'
      ? [{ type: 'tool-write_file', toolCallId: 'mock_call_1', state: 'output-available', input: { path: 'mock-workspace.txt', content: 'x' }, output: { path: 'mock-workspace.txt', created: true } }]
      : [{ type: 'text', text: `user ${id}` }]
    await database.client.execute({
      sql: 'INSERT INTO messages (id, chat_id, parent_id, selected_child_id, seq, role, parts, metadata, search_text, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)',
      args: [id, chatId, parentId, seq, role, JSON.stringify(parts), JSON.stringify({ modelRef: 'mock:workspace', startedAt: 1 }), `${role} ${id}`, 3000 + seq, 4000 + seq],
    })
  }
  await database.client.execute({
    sql: `INSERT INTO chat_shares (id, chat_id, options, snapshot, snapshot_at, created_at, updated_at) VALUES ('shr_0000000000000002', ?, '{}', '{}', 1, 1, 1)`,
    args: [CHAT_Q1],
  })
  await database.client.execute({
    sql: 'INSERT INTO usage (chat_id, message_id, purpose, provider_id, model_id, input, output, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    args: [CHAT_Q1, 'msg_d100000000000001', 'chat', 'mock', 'workspace', 3, 4, 5000],
  })
  const seeded = {
    projects: await rows(database, 'projects', 'id'),
    chats: await rows(database, 'chats', 'id'),
    messages: await rows(database, 'messages', 'chat_id, seq'),
    chat_shares: await rows(database, 'chat_shares', 'id'),
    usage: await rows(database, 'usage', 'id'),
  }
  database.close()
  return seeded
}

describe('upgrade of a v1.3 database through migration 0005 (workspace checkpoints)', () => {
  it('0005 is two CREATE TABLE and five CREATE INDEX statements, never a change of an existing table', () => {
    const statements = checkpointStatements()
    expect(statements.filter(statement => statement.startsWith('CREATE TABLE ')).map(statement => statement.match(/^CREATE TABLE `(\w+)`/)?.[1])).toEqual(['shell_rules', 'workspace_changes'])
    expect(statements.filter(statement => statement.startsWith('CREATE INDEX ')).map(statement => statement.match(/^CREATE INDEX `(\w+)`/)?.[1]).sort()).toEqual([
      'shell_rules_project_idx',
      'workspace_changes_before_sha_idx',
      'workspace_changes_chat_path_idx',
      'workspace_changes_chat_seq_idx',
      'workspace_changes_project_idx',
    ])
    expect(statements).toHaveLength(7)
    const sql = statements.join('\n')
    // (`ON UPDATE no action ON DELETE cascade` of the foreign keys is allowed; an UPDATE / DELETE statement is not.)
    for (const forbidden of [/DROP\s+/i, /__new_/i, /PRAGMA/i, /ALTER\s+TABLE/i, /^\s*UPDATE\s/im, /DELETE\s+FROM/i, /\bINSERT\b/i, /UNIQUE/i])
      expect(sql, String(forbidden)).not.toMatch(forbidden)
    // The only foreign keys are those of the new tables: cascades from chats and projects.
    expect(sql.match(/FOREIGN KEY \(`\w+`\) REFERENCES `\w+`\(`id`\) ON UPDATE no action ON DELETE cascade/g)).toHaveLength(3)
    expect(JOURNAL.entries.slice(0, 6)).toEqual([INITIAL, TREE, REMEMBERED, REFRESH, PROJECTS, CHECKPOINTS])
    expect(CHECKPOINTS?.tag).toBe('0005_workspace_checkpoints')
  })

  it('every chat and project survives; the new tables are empty; the schema matches a fresh one', async () => {
    const path = join(tempDir(), 'harness.db')
    const before = await seedV13Database(path)
    const database = await open(path)
    await migrateDatabase(database.db)

    // Phase 11 (0008): every project gains `output_style` (null).
    expect(await rows(database, 'projects', 'id')).toEqual(before.projects.map(row => ({ ...row, output_style: null })))
    expect(await rows(database, 'chats', 'id')).toEqual(before.chats)
    expect(await rows(database, 'messages', 'chat_id, seq')).toEqual(before.messages)
    expect(await rows(database, 'chat_shares', 'id')).toEqual(before.chat_shares)
    expect(await rows(database, 'usage', 'id')).toEqual(before.usage)
    expect(await scalar(database, 'SELECT count(*) AS n FROM workspace_changes')).toBe(0)
    expect(await scalar(database, 'SELECT count(*) AS n FROM shell_rules')).toBe(0)

    const applied = await database.client.execute('SELECT created_at FROM __drizzle_migrations ORDER BY created_at')
    expect(applied.rows.map(row => Number(row.created_at))).toEqual(JOURNAL.entries.map(entry => entry.when))
    // 0005 and every later migration (Phase 9: 0006; Phase 10: 0007; Phase 11: 0008; Phase 12: 0009).
    expect(applied.rows).toHaveLength(10)
    const shape = await schemaShape(database)
    expect(shape.tables).toEqual([...TABLE_NAMES].sort())
    expect(shape.tables).toHaveLength(23)
    const fresh = await open(':memory:')
    await migrateDatabase(fresh.db)
    expect(shape).toEqual(await schemaShape(fresh))
    expect(shape.foreignKeys.workspace_changes?.map(key => (key as unknown[]).slice(0, 4).join(' ')).sort()).toEqual(['chat_id chats id CASCADE', 'project_id projects id CASCADE'])
    expect(shape.foreignKeys.shell_rules?.map(key => (key as unknown[]).slice(0, 4).join(' '))).toEqual(['project_id projects id CASCADE'])
    expect(shape.foreignKeys.chats).toEqual([])
    const foreignKeys = await database.client.execute('PRAGMA foreign_keys')
    expect(Number(foreignKeys.rows[0]?.foreign_keys)).toBe(1)
    const check = await database.client.execute('PRAGMA foreign_key_check')
    expect(check.rows).toEqual([])

    // Idempotent: migrating again applies nothing.
    await migrateDatabase(database.db)
    expect(await scalar(database, 'SELECT count(*) AS n FROM __drizzle_migrations')).toBe(JOURNAL.entries.length)
  })

  it('deleting a chat removes its journal rows; deleting a project removes its rows and rules, global rules stay', async () => {
    const path = join(tempDir(), 'harness.db')
    await seedV13Database(path)
    const database = await open(path)
    await migrateDatabase(database.db)
    const insertChange = async (chatId: string, projectId: string, path: string, createdAt: number): Promise<void> => {
      await database.client.execute({
        sql: `INSERT INTO workspace_changes (chat_id, project_id, message_seq, message_id, tool_call_id, kind, tool, path, before_state, after_sha, after_size, created_at)
              VALUES (?, ?, (SELECT coalesce(max(seq), 0) FROM messages WHERE chat_id = ?), NULL, 'call_1', 'edit', 'write_file', ?, 'missing', ?, 1, ?)`,
        args: [chatId, projectId, chatId, path, 'f'.repeat(64), createdAt],
      })
    }
    await insertChange(CHAT_Q1, V13_PROJECT, 'a.txt', 1)
    await insertChange(CHAT_Q1, V13_PROJECT, 'b.txt', 2)
    await insertChange(CHAT_Q2, V13_PROJECT, 'a.txt', 3)
    const rulesSeed: Array<[string, string | null, string]> = [['srl_rule000000000001', V13_PROJECT, 'pnpm test'], ['srl_rule000000000002', V13_OTHER_PROJECT, 'make'], ['srl_rule000000000003', null, 'ls']]
    for (const [id, projectId, prefix] of rulesSeed) {
      await database.client.execute({ sql: 'INSERT INTO shell_rules (id, project_id, prefix, created_at) VALUES (?, ?, ?, 1)', args: [id, projectId, prefix] })
    }
    expect(await scalar(database, `SELECT message_seq AS n FROM workspace_changes WHERE chat_id = '${CHAT_Q1}' LIMIT 1`)).toBe(1)

    await database.client.execute({ sql: 'DELETE FROM messages WHERE chat_id = ?', args: [CHAT_Q1] })
    await database.client.execute({ sql: 'DELETE FROM chats WHERE id = ?', args: [CHAT_Q1] })
    expect((await rows(database, 'workspace_changes', 'id')).map(row => row.chat_id)).toEqual([CHAT_Q2])

    await database.client.execute({ sql: 'DELETE FROM projects WHERE id = ?', args: [V13_PROJECT] })
    expect(await scalar(database, 'SELECT count(*) AS n FROM workspace_changes')).toBe(0)
    expect((await rows(database, 'shell_rules', 'id')).map(row => [row.id, row.project_id])).toEqual([
      ['srl_rule000000000002', V13_OTHER_PROJECT],
      ['srl_rule000000000003', null],
    ])
    // The chats of the deleted project stay (the project service detaches them itself; no foreign key on chats).
    expect(await scalar(database, 'SELECT count(*) AS n FROM chats')).toBe(2)
  })

  it('boots on the upgraded database: every chat is served with its project', async () => {
    const dataDir = tempDir()
    const databasePath = join(dataDir, 'harness.db')
    await seedV13Database(databasePath)
    const t = await createTestApp({ dataDir, databasePath, start: false })
    try {
      const list = cursorPageSchema(chatSummarySchema).parse(await (await t.request('/api/chats')).json())
      expect(list.items.map(chat => [chat.id, chat.projectId]).sort()).toEqual([[CHAT_Q1, V13_PROJECT], [CHAT_Q2, V13_PROJECT], [CHAT_Q3, null]])
      const detail = chatDetailSchema.parse(await (await t.request(`/api/chats/${CHAT_Q1}`)).json())
      expect(detail.messages.map(message => message.id)).toEqual(['msg_d100000000000000', 'msg_d100000000000001'])
      expect(detail.messages[1]?.parts[0]).toMatchObject({ type: 'tool-write_file', state: 'output-available' })
      expect((await t.deps.projects.list()).map(project => project.id).sort()).toEqual([V13_PROJECT, V13_OTHER_PROJECT])
    }
    finally {
      await t.close()
    }
  })
})

// ---------- v1.4 -> v1.5: migration 0006 (unique shell rules per scope) ----------

/** A migrations folder holding 0000 - 0005 (their SQL + a six-entry journal): the schema of a v1.4 data directory. */
function v14Folder(): string {
  const entries = [INITIAL, TREE, REMEMBERED, REFRESH, PROJECTS, CHECKPOINTS]
  if (entries.includes(undefined))
    throw new Error('a migration of 0000 - 0005 is missing from the journal')
  const dir = tempDir()
  mkdirSync(join(dir, 'meta'))
  for (const entry of entries as JournalEntry[])
    copyFileSync(join(REAL_FOLDER, `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`))
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({ ...JOURNAL, entries }))
  return dir
}

/** The statements of migration 0006 without comments and blank lines (split like `migrate()` does). */
function shellUniqueStatements(): string[] {
  if (SHELL_UNIQUE === undefined)
    throw new Error('migration 0006 is missing from the journal')
  return readFileSync(join(REAL_FOLDER, `${SHELL_UNIQUE.tag}.sql`), 'utf8')
    .split('--> statement-breakpoint')
    .map(statement => statement.replace(/^--.*$/gm, '').trim())
    .filter(Boolean)
}

/** A copy of the real folder whose 0006 lacks the statement starting with `keyword` (`DELETE` or `UPDATE`). */
function folderWithout0006(keyword: 'DELETE' | 'UPDATE'): string {
  if (SHELL_UNIQUE === undefined)
    throw new Error('migration 0006 is missing from the journal')
  const dir = tempDir()
  cpSync(REAL_FOLDER, dir, { recursive: true })
  const path = join(dir, `${SHELL_UNIQUE.tag}.sql`)
  const statements = readFileSync(path, 'utf8').split('--> statement-breakpoint')
  const kept = statements.filter(statement => !new RegExp(`^\\s*(?:--[^\\n]*\\n\\s*)*${keyword}\\b`, 'i').test(statement))
  expect(statements.length - kept.length, `0006 has one ${keyword} statement`).toBe(1)
  writeFileSync(path, kept.join('--> statement-breakpoint'))
  return dir
}

const V14_PROJECT = 'prj_v14project000001'
const V14_OTHER_PROJECT = 'prj_v14project000002'
const CHAT_R1 = '0199a8f0-0000-7000-8000-0000000000e1'
const CHAT_R2 = '0199a8f0-0000-7000-8000-0000000000e2'

/**
 * Shell rules of the v1.4 seed: `[id, projectId, prefix, createdAt]`. v1.4 serialized rule creation only inside one
 * process, so a scope could hold a prefix twice. Groups: two global `ls` (the newer has the lower id), three global
 * `git status`, an equal-`created_at` pair of global `make` (decided by id), two `ls` in the first project, one `ls` in
 * the other project, single rules in both scopes.
 */
const V14_RULES: Array<[string, string | null, string, number]> = [
  ['srl_glob000000000002', null, 'ls', 10],
  ['srl_glob000000000001', null, 'ls', 20],
  ['srl_gits000000000003', null, 'git status', 1],
  ['srl_gits000000000001', null, 'git status', 2],
  ['srl_gits000000000002', null, 'git status', 3],
  ['srl_make000000000002', null, 'make', 30],
  ['srl_make000000000001', null, 'make', 30],
  ['srl_pwd0000000000001', null, 'pwd', 40],
  ['srl_prja000000000001', V14_PROJECT, 'ls', 15],
  ['srl_prja000000000002', V14_PROJECT, 'ls', 5],
  ['srl_prja000000000003', V14_PROJECT, 'pnpm test', 50],
  ['srl_prjb000000000001', V14_OTHER_PROJECT, 'ls', 60],
]

/** The rule kept for each scope and prefix: the oldest, ties by id. */
const V14_KEPT_RULES = [
  'srl_gits000000000003',
  'srl_glob000000000002',
  'srl_make000000000001',
  'srl_prja000000000002',
  'srl_prja000000000003',
  'srl_prjb000000000001',
  'srl_pwd0000000000001',
]

/** Tool preferences of the v1.4 seed: `[toolName, enabled, override]`. */
const V14_TOOL_PREFS: Array<[string, 0 | 1, string | null]> = [
  ['shell', 1, 'allow'],
  ['current_time', 1, 'allow'],
  ['write_file', 0, 'deny'],
  ['read_file', 1, 'ask'],
]

/**
 * Creates a v1.4 database file (0000 - 0005) with two projects, a chat in the first project (with a journal row) and
 * one without, their messages, the duplicate shell rules of `V14_RULES` and the tool preferences of `V14_TOOL_PREFS`;
 * returns every row of the tables 0006 must not touch.
 */
async function seedV14Database(path: string): Promise<Record<'projects' | 'chats' | 'messages' | 'workspace_changes' | 'usage', Record<string, unknown>[]>> {
  const database = await open(path)
  await migrateDatabase(database.db, { migrationsFolder: v14Folder() })
  const unique = await database.client.execute(`SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'shell_rules_%_uq'`)
  expect(unique.rows).toHaveLength(0)
  for (const [id, name] of [[V14_PROJECT, 'git-demo'], [V14_OTHER_PROJECT, 'other']] as const) {
    await database.client.execute({
      sql: 'INSERT INTO projects (id, name, path, instructions, created_at, updated_at) VALUES (?, ?, ?, NULL, 100, 200)',
      args: [id, name, `/srv/projects/${name}`],
    })
  }
  for (const [index, [id, projectId]] of ([[CHAT_R1, V14_PROJECT], [CHAT_R2, null]] as const).entries()) {
    await database.client.execute({
      sql: 'INSERT INTO chats (id, title, title_source, model_ref, settings, pinned, archived, pending_approval, active_leaf_id, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?)',
      args: [id, `Chat ${index}`, 'user', 'mock:shell', '{"toolMode":"ask"}', index === 0 ? 1 : 0, `msg_e${index + 1}00000000000001`, projectId, 1000 + index, 2000 + index],
    })
    for (const [seq, role] of [[0, 'user'], [1, 'assistant']] as const) {
      const messageId = `msg_e${index + 1}0000000000000${seq}`
      const parts = role === 'assistant'
        ? [{ type: 'tool-shell', toolCallId: 'mock_call_1', state: 'approval-requested', input: { command: 'ls' }, approval: { id: 'apr_1' } }]
        : [{ type: 'text', text: `user ${messageId}` }]
      await database.client.execute({
        sql: 'INSERT INTO messages (id, chat_id, parent_id, selected_child_id, seq, role, parts, metadata, search_text, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)',
        args: [messageId, id, seq === 0 ? null : `msg_e${index + 1}00000000000000`, seq, role, JSON.stringify(parts), JSON.stringify({ modelRef: 'mock:shell', startedAt: 1 }), `${role} ${messageId}`, 3000 + seq, 4000 + seq],
      })
    }
  }
  await database.client.execute({
    sql: `INSERT INTO workspace_changes (chat_id, project_id, message_seq, message_id, tool_call_id, kind, tool, path, before_state, after_sha, after_size, created_at)
          VALUES (?, ?, 1, 'msg_e100000000000001', 'call_1', 'edit', 'write_file', 'a.txt', 'missing', ?, 1, 7)`,
    args: [CHAT_R1, V14_PROJECT, 'f'.repeat(64)],
  })
  await database.client.execute({
    sql: 'INSERT INTO usage (chat_id, message_id, purpose, provider_id, model_id, input, output, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    args: [CHAT_R1, 'msg_e100000000000001', 'chat', 'mock', 'shell', 3, 4, 5000],
  })
  for (const [id, projectId, prefix, createdAt] of V14_RULES)
    await database.client.execute({ sql: 'INSERT INTO shell_rules (id, project_id, prefix, created_at) VALUES (?, ?, ?, ?)', args: [id, projectId, prefix, createdAt] })
  for (const [toolName, enabled, override] of V14_TOOL_PREFS)
    await database.client.execute({ sql: 'INSERT INTO tool_prefs (tool_name, enabled, override, updated_at) VALUES (?, ?, ?, 9)', args: [toolName, enabled, override] })
  expect(await scalar(database, 'SELECT count(*) AS n FROM shell_rules')).toBe(V14_RULES.length)
  const seeded = {
    projects: await rows(database, 'projects', 'id'),
    chats: await rows(database, 'chats', 'id'),
    messages: await rows(database, 'messages', 'chat_id, seq'),
    workspace_changes: await rows(database, 'workspace_changes', 'id'),
    usage: await rows(database, 'usage', 'id'),
  }
  database.close()
  return seeded
}

/** The `tool_prefs` rows as `[tool_name, enabled, override]`, by name. */
async function toolPrefRows(database: Database): Promise<Array<[string, number, string | null]>> {
  const result = await database.client.execute('SELECT tool_name, enabled, override FROM tool_prefs ORDER BY tool_name')
  return result.rows.map(row => [String(row.tool_name), Number(row.enabled), row.override === null ? null : String(row.override)])
}

describe('upgrade of a v1.4 database through migration 0006 (unique shell rules)', () => {
  it('0006 is one DELETE, one UPDATE and two partial CREATE UNIQUE INDEX statements, never a table rebuild', () => {
    const statements = shellUniqueStatements()
    expect(statements).toHaveLength(4)
    expect(statements.filter(statement => /^DELETE\s+FROM\s+`?shell_rules`?\s/i.test(statement))).toHaveLength(1)
    expect(statements.filter(statement => /^UPDATE\s+`?tool_prefs`?\s+SET\s+`?override`?\s*=\s*NULL\s/i.test(statement))).toHaveLength(1)
    const indexes = statements.filter(statement => statement.startsWith('CREATE UNIQUE INDEX '))
    expect(indexes.map(statement => statement.match(/^CREATE UNIQUE INDEX `(\w+)`/)?.[1])).toEqual(['shell_rules_global_prefix_uq', 'shell_rules_project_prefix_uq'])
    expect(indexes[0]).toMatch(/ON `shell_rules` \(`prefix`\) WHERE project_id is null;?$/)
    expect(indexes[1]).toMatch(/ON `shell_rules` \(`project_id`,\s?`prefix`\) WHERE project_id is not null;?$/)
    const sql = statements.join('\n')
    for (const forbidden of [/DROP\s+/i, /__new_/i, /PRAGMA/i, /ALTER\s+TABLE/i, /CREATE\s+TABLE/i, /\bINSERT\b/i])
      expect(sql, String(forbidden)).not.toMatch(forbidden)
    // The UPDATE clears only an `allow` override of the `shell` tool.
    expect(statements.find(statement => statement.startsWith('UPDATE'))).toMatch(/WHERE `?tool_name`? = 'shell' AND `?override`? = 'allow'/)
    expect(JOURNAL.entries.slice(0, 7)).toEqual([INITIAL, TREE, REMEMBERED, REFRESH, PROJECTS, CHECKPOINTS, SHELL_UNIQUE])
    expect(SHELL_UNIQUE?.tag).toBe('0006_shell_rule_unique')
  })

  it('keeps the oldest rule of each scope and prefix (ties by id), clears only the shell allow, loses nothing else', async () => {
    const path = join(tempDir(), 'harness.db')
    const before = await seedV14Database(path)
    const database = await open(path)
    await migrateDatabase(database.db)

    // The oldest rule of each scope + prefix; the global and the project `ls` both stay, as does the other project's.
    const kept = await rows(database, 'shell_rules', 'id')
    expect(kept.map(row => row.id)).toEqual(V14_KEPT_RULES)
    expect(kept.filter(row => row.prefix === 'ls').map(row => [row.project_id, row.id])).toEqual([
      [null, 'srl_glob000000000002'],
      [V14_PROJECT, 'srl_prja000000000002'],
      [V14_OTHER_PROJECT, 'srl_prjb000000000001'],
    ])
    for (const row of kept) {
      const seeded = V14_RULES.find(([id]) => id === row.id)
      expect([row.project_id, row.prefix, Number(row.created_at)], String(row.id)).toEqual(seeded?.slice(1))
    }
    const duplicates = await database.client.execute(`SELECT coalesce(project_id, '') AS scope, prefix FROM shell_rules GROUP BY 1, 2 HAVING count(*) > 1`)
    expect(duplicates.rows).toEqual([])

    // Only the `allow` override of `shell` is cleared; `current_time` keeps its `allow`, the others are untouched.
    expect(await toolPrefRows(database)).toEqual([
      ['current_time', 1, 'allow'],
      ['read_file', 1, 'ask'],
      ['shell', 1, null],
      ['write_file', 0, 'deny'],
    ])

    // Every project, chat, message, journal row and usage row survives as stored (Phase 11, 0008: projects gain a null
    // `output_style`).
    expect(await rows(database, 'projects', 'id')).toEqual(before.projects.map(row => ({ ...row, output_style: null })))
    expect(await rows(database, 'chats', 'id')).toEqual(before.chats)
    expect(await rows(database, 'messages', 'chat_id, seq')).toEqual(before.messages)
    expect(await rows(database, 'workspace_changes', 'id')).toEqual(before.workspace_changes)
    expect(await rows(database, 'usage', 'id')).toEqual(before.usage)

    const applied = await database.client.execute('SELECT created_at FROM __drizzle_migrations ORDER BY created_at')
    expect(applied.rows.map(row => Number(row.created_at))).toEqual(JOURNAL.entries.map(entry => entry.when))
    // 0006 and every later migration (Phase 10: 0007; Phase 11: 0008; Phase 12: 0009).
    expect(applied.rows).toHaveLength(10)
    const shape = await schemaShape(database)
    expect(shape.tables).toHaveLength(23)
    const fresh = await open(':memory:')
    await migrateDatabase(fresh.db)
    expect(shape).toEqual(await schemaShape(fresh))
    expect(shape.indexes.shell_rules_global_prefix_uq).toEqual(['prefix'])
    expect(shape.indexes.shell_rules_project_prefix_uq).toEqual(['project_id', 'prefix'])
    const indexSql = await database.client.execute(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name LIKE 'shell_rules_%_uq' ORDER BY name`)
    expect(indexSql.rows.map(row => [String(row.name), /WHERE project_id is (?:not )?null$/.exec(String(row.sql))?.[0]])).toEqual([
      ['shell_rules_global_prefix_uq', 'WHERE project_id is null'],
      ['shell_rules_project_prefix_uq', 'WHERE project_id is not null'],
    ])
    expect((await database.client.execute('PRAGMA foreign_key_check')).rows).toEqual([])
    expect((await database.client.execute('PRAGMA integrity_check')).rows.map(row => String(row.integrity_check))).toEqual(['ok'])

    // The database is now the authority: a second identical rule in either scope is a unique violation.
    const insertRule = (id: string, projectId: string | null, prefix: string): Promise<unknown> =>
      database.client.execute({ sql: 'INSERT INTO shell_rules (id, project_id, prefix, created_at) VALUES (?, ?, ?, 99)', args: [id, projectId, prefix] })
    expect(await uniqueViolation(insertRule('srl_dupe000000000001', null, 'ls'))).toBe('UNIQUE constraint failed: shell_rules.prefix')
    expect(await uniqueViolation(insertRule('srl_dupe000000000002', V14_PROJECT, 'ls'))).toBe('UNIQUE constraint failed: shell_rules.project_id, shell_rules.prefix')
    // The same prefix in another scope is still fine.
    await insertRule('srl_dupe000000000003', V14_OTHER_PROJECT, 'pnpm test')
    expect(await scalar(database, 'SELECT count(*) AS n FROM shell_rules')).toBe(V14_KEPT_RULES.length + 1)

    // Idempotent: migrating again applies nothing.
    await migrateDatabase(database.db)
    expect(await scalar(database, 'SELECT count(*) AS n FROM __drizzle_migrations')).toBe(JOURNAL.entries.length)
  })

  it('the same checks fail without the hand-written statements (the test notices a missing dedupe or reset)', async () => {
    // Without the DELETE, the unique index cannot be created over the duplicates: the migration fails.
    const noDedupe = join(tempDir(), 'harness.db')
    await seedV14Database(noDedupe)
    const first = await open(noDedupe)
    await expect(migrateDatabase(first.db, { migrationsFolder: folderWithout0006('DELETE') })).rejects.toThrow()
    first.close()
    const after = await open(noDedupe)
    expect(await scalar(after, 'SELECT count(*) AS n FROM shell_rules')).toBe(V14_RULES.length)
    expect(await scalar(after, 'SELECT count(*) AS n FROM __drizzle_migrations')).toBe(6)

    // Without the UPDATE, the stored `allow` of `shell` survives.
    const noReset = join(tempDir(), 'harness.db')
    await seedV14Database(noReset)
    const second = await open(noReset)
    await migrateDatabase(second.db, { migrationsFolder: folderWithout0006('UPDATE') })
    expect((await toolPrefRows(second)).find(([name]) => name === 'shell')).toEqual(['shell', 1, 'allow'])
  })

  it('boots on the upgraded database: chats, the pending approval and the kept rules are served', async () => {
    const dataDir = tempDir()
    const databasePath = join(dataDir, 'harness.db')
    await seedV14Database(databasePath)
    const t = await createTestApp({ dataDir, databasePath, start: false })
    try {
      const list = cursorPageSchema(chatSummarySchema).parse(await (await t.request('/api/chats')).json())
      expect(list.items.map(chat => [chat.id, chat.projectId]).sort()).toEqual([[CHAT_R1, V14_PROJECT], [CHAT_R2, null]])
      const detail = chatDetailSchema.parse(await (await t.request(`/api/chats/${CHAT_R1}`)).json())
      expect(detail.messages.map(message => message.id)).toEqual(['msg_e100000000000000', 'msg_e100000000000001'])
      expect(detail.messages[1]?.parts[0]).toMatchObject({ type: 'tool-shell', state: 'approval-requested' })
      expect(detail.pendingApproval).toBe(true)
      expect((await t.deps.shellRules.list()).map(rule => rule.id).sort()).toEqual(V14_KEPT_RULES)
      expect((await t.deps.projects.list()).map(project => project.id).sort()).toEqual([V14_PROJECT, V14_OTHER_PROJECT])
    }
    finally {
      await t.close()
    }
  })
})

function v15Folder(): string {
  const entries = [INITIAL, TREE, REMEMBERED, REFRESH, PROJECTS, CHECKPOINTS, SHELL_UNIQUE]
  if (entries.includes(undefined))
    throw new Error('a migration of 0000 - 0006 is missing from the journal')
  const dir = tempDir()
  mkdirSync(join(dir, 'meta'))
  for (const entry of entries as JournalEntry[])
    copyFileSync(join(REAL_FOLDER, `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`))
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({ ...JOURNAL, entries }))
  return dir
}

/** The statements of migration 0007 without comments and blank lines (split like `migrate()` does). */
function customizationStatements(): string[] {
  if (CUSTOMIZATIONS === undefined)
    throw new Error('migration 0007 is missing from the journal')
  return readFileSync(join(REAL_FOLDER, `${CUSTOMIZATIONS.tag}.sql`), 'utf8')
    .split('--> statement-breakpoint')
    .map(statement => statement.replace(/^--.*$/gm, '').trim())
    .filter(Boolean)
}

const V15_PROJECT = 'prj_v15project000001'
const CHAT_S1 = '0199a8f0-0000-7000-8000-0000000000f1'
const CHAT_S2 = '0199a8f0-0000-7000-8000-0000000000f2'

/**
 * Creates a v1.5 database file (0000 - 0006) with a project, a project chat whose assistant message holds a v1.5 `task`
 * part, a chat without a project, a journal row, a shell rule and a usage row; returns every row of the tables 0007
 * must not touch.
 */
async function seedV15Database(path: string): Promise<Record<'projects' | 'chats' | 'messages' | 'workspace_changes' | 'shell_rules' | 'usage', Record<string, unknown>[]>> {
  const database = await open(path)
  await migrateDatabase(database.db, { migrationsFolder: v15Folder() })
  const before = await database.client.execute(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('customizations', 'background_tasks')`)
  expect(before.rows).toHaveLength(0)
  await database.client.execute({
    sql: 'INSERT INTO projects (id, name, path, instructions, created_at, updated_at) VALUES (?, ?, ?, ?, 100, 200)',
    args: [V15_PROJECT, 'agent-demo', '/srv/projects/agent-demo', 'Use pnpm.'],
  })
  for (const [index, [id, projectId]] of ([[CHAT_S1, V15_PROJECT], [CHAT_S2, null]] as const).entries()) {
    await database.client.execute({
      sql: 'INSERT INTO chats (id, title, title_source, model_ref, settings, pinned, archived, pending_approval, active_leaf_id, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?)',
      args: [id, `Chat ${index}`, 'user', 'mock:subagent', '{"toolMode":"ask"}', `msg_f${index + 1}00000000000001`, projectId, 1000 + index, 2000 + index],
    })
    for (const [seq, role] of [[0, 'user'], [1, 'assistant']] as const) {
      const messageId = `msg_f${index + 1}0000000000000${seq}`
      const parts = role === 'assistant'
        ? [{ type: 'tool-task', toolCallId: 'mock_task_1', state: 'output-available', input: { description: 'Look around', prompt: 'List files', type: 'explore' }, output: { status: 'completed', type: 'explore', description: 'Look around', modelRef: 'mock:subagent', steps: [], stepsOmitted: 0, report: 'Done.', startedAt: 1, finishedAt: 2 } }]
        : [{ type: 'text', text: `user ${messageId}` }]
      await database.client.execute({
        sql: 'INSERT INTO messages (id, chat_id, parent_id, selected_child_id, seq, role, parts, metadata, search_text, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)',
        args: [messageId, id, seq === 0 ? null : `msg_f${index + 1}00000000000000`, seq, role, JSON.stringify(parts), JSON.stringify({ modelRef: 'mock:subagent', startedAt: 1 }), `${role} ${messageId}`, 3000 + seq, 4000 + seq],
      })
    }
  }
  await database.client.execute({
    sql: `INSERT INTO workspace_changes (chat_id, project_id, message_seq, message_id, tool_call_id, kind, tool, path, before_state, after_sha, after_size, created_at)
          VALUES (?, ?, 1, 'msg_f100000000000001', 'call_1', 'edit', 'write_file', 'a.txt', 'missing', ?, 1, 7)`,
    args: [CHAT_S1, V15_PROJECT, 'e'.repeat(64)],
  })
  await database.client.execute({ sql: 'INSERT INTO shell_rules (id, project_id, prefix, created_at) VALUES (?, ?, ?, 8)', args: ['srl_v15rule000000001', V15_PROJECT, 'ls'] })
  await database.client.execute({
    sql: 'INSERT INTO usage (chat_id, message_id, purpose, provider_id, model_id, input, output, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    args: [CHAT_S1, 'msg_f100000000000001', 'subagent', 'mock', 'subagent', 3, 4, 5000],
  })
  const seeded = {
    projects: await rows(database, 'projects', 'id'),
    chats: await rows(database, 'chats', 'id'),
    messages: await rows(database, 'messages', 'chat_id, seq'),
    workspace_changes: await rows(database, 'workspace_changes', 'id'),
    shell_rules: await rows(database, 'shell_rules', 'id'),
    usage: await rows(database, 'usage', 'id'),
  }
  database.close()
  return seeded
}

describe('upgrade of a v1.5 database through migration 0007 (customizations, background tasks)', () => {
  it('0007 is two CREATE TABLE and three CREATE [UNIQUE] INDEX statements, never a change of an existing table', () => {
    const statements = customizationStatements()
    expect(statements).toHaveLength(5)
    const tables = statements.filter(statement => statement.startsWith('CREATE TABLE '))
    expect(tables.map(statement => statement.match(/^CREATE TABLE `(\w+)`/)?.[1]).sort()).toEqual(['background_tasks', 'customizations'])
    const indexes = statements.filter(statement => /^CREATE (?:UNIQUE )?INDEX /.test(statement))
    expect(indexes.map(statement => statement.match(/INDEX `(\w+)`/)?.[1]).sort()).toEqual(['background_tasks_chat_idx', 'background_tasks_pending_idx', 'customizations_kind_name_uq'])
    expect(indexes.filter(statement => statement.startsWith('CREATE UNIQUE INDEX '))).toHaveLength(1)
    const sql = statements.join('\n')
    for (const forbidden of [/DROP\s+/i, /__new_/i, /PRAGMA/i, /ALTER\s+TABLE/i, /\bDELETE\s+FROM\b/i, /\bUPDATE\s+`?\w+`?\s+SET\b/i, /\bINSERT\b/i])
      expect(sql, String(forbidden)).not.toMatch(forbidden)
    // The only foreign key: background_tasks.chat_id -> chats.id, cascading.
    expect(sql.match(/FOREIGN KEY/g)).toHaveLength(1)
    expect(tables.find(statement => statement.includes('`background_tasks`'))).toMatch(/FOREIGN KEY \(`chat_id`\) REFERENCES `chats`\(`id`\) ON UPDATE no action ON DELETE cascade/)
    expect(JOURNAL.entries.slice(0, 8)).toEqual([INITIAL, TREE, REMEMBERED, REFRESH, PROJECTS, CHECKPOINTS, SHELL_UNIQUE, CUSTOMIZATIONS])
    expect(CUSTOMIZATIONS?.tag).toBe('0007_customizations')
  })

  it('both tables exist and are empty; every chat, message and project survives; the schema matches a fresh one', async () => {
    const path = join(tempDir(), 'harness.db')
    const before = await seedV15Database(path)
    const database = await open(path)
    await migrateDatabase(database.db)

    expect(await scalar(database, 'SELECT count(*) AS n FROM customizations')).toBe(0)
    expect(await scalar(database, 'SELECT count(*) AS n FROM background_tasks')).toBe(0)
    // Phase 11 (0008): every project gains `output_style` (null).
    expect(await rows(database, 'projects', 'id')).toEqual(before.projects.map(row => ({ ...row, output_style: null })))
    expect(await rows(database, 'chats', 'id')).toEqual(before.chats)
    expect(await rows(database, 'messages', 'chat_id, seq')).toEqual(before.messages)
    expect(await rows(database, 'workspace_changes', 'id')).toEqual(before.workspace_changes)
    expect(await rows(database, 'shell_rules', 'id')).toEqual(before.shell_rules)
    expect(await rows(database, 'usage', 'id')).toEqual(before.usage)

    const applied = await database.client.execute('SELECT created_at FROM __drizzle_migrations ORDER BY created_at')
    expect(applied.rows.map(row => Number(row.created_at))).toEqual(JOURNAL.entries.map(entry => entry.when))
    // 0007 and every later migration (Phase 11: 0008; Phase 12: 0009).
    expect(applied.rows).toHaveLength(10)
    const shape = await schemaShape(database)
    expect(shape.tables).toEqual([...TABLE_NAMES].sort())
    expect(shape.tables).toHaveLength(23)
    const fresh = await open(':memory:')
    await migrateDatabase(fresh.db)
    expect(shape).toEqual(await schemaShape(fresh))
    expect(shape.indexes.customizations_kind_name_uq).toEqual(['kind', 'name'])
    expect(shape.indexes.background_tasks_chat_idx).toEqual(['chat_id', 'created_at'])
    expect(shape.indexes.background_tasks_pending_idx).toEqual(['delivered_at', 'status'])
    expect((await database.client.execute('PRAGMA foreign_key_check')).rows).toEqual([])
    expect((await database.client.execute('PRAGMA integrity_check')).rows.map(row => String(row.integrity_check))).toEqual(['ok'])

    // Idempotent: migrating again applies nothing.
    await migrateDatabase(database.db)
    expect(await scalar(database, 'SELECT count(*) AS n FROM __drizzle_migrations')).toBe(JOURNAL.entries.length)
  })

  it('a second (kind, name) is a unique violation; deleting a chat cascades to its background tasks only', async () => {
    const path = join(tempDir(), 'harness.db')
    await seedV15Database(path)
    const database = await open(path)
    await migrateDatabase(database.db)

    const insertCustomization = (id: string, kind: string, name: string): Promise<unknown> => database.client.execute({
      sql: 'INSERT INTO customizations (id, kind, name, description, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 1)',
      args: [id, kind, name, 'Reviews diffs.', `---\nname: ${name}\ndescription: Reviews diffs.\n---\nReview.`],
    })
    await insertCustomization('cus_v15custom0000001', 'agent', 'reviewer')
    expect(await uniqueViolation(insertCustomization('cus_v15custom0000002', 'agent', 'reviewer'))).toBe('UNIQUE constraint failed: customizations.kind, customizations.name')
    await insertCustomization('cus_v15custom0000003', 'command', 'reviewer')
    expect(await scalar(database, 'SELECT count(*) AS n FROM customizations WHERE enabled = 1')).toBe(2)

    const output = JSON.stringify({ status: 'running', type: 'explore', description: 'Look', modelRef: 'mock:background', steps: [], stepsOmitted: 0, report: '', startedAt: 1 })
    for (const [id, chatId] of [['bgt_v15task00000001', CHAT_S1], ['bgt_v15task00000002', CHAT_S1], ['bgt_v15task00000003', CHAT_S2]] as const) {
      await database.client.execute({
        sql: `INSERT INTO background_tasks (id, chat_id, message_id, tool_call_id, type, description, status, origin, output, created_at) VALUES (?, ?, ?, 'call_1', 'explore', 'Look', 'running', 'request', ?, 1)`,
        args: [id, chatId, chatId === CHAT_S1 ? 'msg_f100000000000001' : 'msg_f200000000000001', output],
      })
    }
    await database.client.execute({ sql: 'DELETE FROM chats WHERE id = ?', args: [CHAT_S1] })
    expect((await rows(database, 'background_tasks', 'id')).map(row => row.id)).toEqual(['bgt_v15task00000003'])
    // Definitions are configuration: a chat delete never touches them.
    expect(await scalar(database, 'SELECT count(*) AS n FROM customizations')).toBe(2)
    // A task of a chat that does not exist is refused (foreign keys are on).
    await expect(database.client.execute({
      sql: `INSERT INTO background_tasks (id, chat_id, message_id, tool_call_id, type, description, status, origin, output, created_at) VALUES ('bgt_v15task00000004', 'missing', 'msg_x', 'call_1', 'explore', 'Look', 'running', 'request', ?, 1)`,
      args: [output],
    })).rejects.toThrow()
  })

  it('boots on the upgraded database: every chat is served with its v1.5 task part unchanged', async () => {
    const dataDir = tempDir()
    const databasePath = join(dataDir, 'harness.db')
    const before = await seedV15Database(databasePath)
    const t = await createTestApp({ dataDir, databasePath, start: false })
    try {
      const list = cursorPageSchema(chatSummarySchema).parse(await (await t.request('/api/chats')).json())
      expect(list.items.map(chat => [chat.id, chat.projectId]).sort()).toEqual([[CHAT_S1, V15_PROJECT], [CHAT_S2, null]])
      const detail = chatDetailSchema.parse(await (await t.request(`/api/chats/${CHAT_S1}`)).json())
      expect(detail.messages.map(message => message.id)).toEqual(['msg_f100000000000000', 'msg_f100000000000001'])
      const stored = before.messages.find(row => row.id === 'msg_f100000000000001')
      expect(detail.messages[1]?.parts).toEqual(JSON.parse(String(stored?.parts)))
      expect((await t.deps.projects.list()).map(project => project.id)).toEqual([V15_PROJECT])
    }
    finally {
      await t.close()
    }
  })
})

/** A migrations folder holding 0000 - 0007 (their SQL + an eight-entry journal): the schema of a v1.6 data directory. */
function v16Folder(): string {
  const entries = [INITIAL, TREE, REMEMBERED, REFRESH, PROJECTS, CHECKPOINTS, SHELL_UNIQUE, CUSTOMIZATIONS]
  if (entries.includes(undefined))
    throw new Error('a migration of 0000 - 0007 is missing from the journal')
  const dir = tempDir()
  mkdirSync(join(dir, 'meta'))
  for (const entry of entries as JournalEntry[])
    copyFileSync(join(REAL_FOLDER, `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`))
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({ ...JOURNAL, entries }))
  return dir
}

/** The statements of migration 0008 without comments and blank lines (split like `migrate()` does). */
function hooksTrustStatements(): string[] {
  if (HOOKS_TRUST === undefined)
    throw new Error('migration 0008 is missing from the journal')
  return readFileSync(join(REAL_FOLDER, `${HOOKS_TRUST.tag}.sql`), 'utf8')
    .split('--> statement-breakpoint')
    .map(statement => statement.replace(/^--.*$/gm, '').trim())
    .filter(Boolean)
}

const V16_PROJECT = 'prj_v16project000001'
const V16_OTHER_PROJECT = 'prj_v16project000002'
const CHAT_T1 = '0199a8f0-0000-7000-8000-0000000001a1'
const CHAT_T2 = '0199a8f0-0000-7000-8000-0000000001a2'
const V16_HASH_A = 'a'.repeat(64)
const V16_HASH_B = 'b'.repeat(64)

type V16Table = 'projects' | 'chats' | 'messages' | 'workspace_changes' | 'shell_rules' | 'usage' | 'customizations' | 'background_tasks'

/**
 * Creates a v1.6 database file (0000 - 0007) with two projects, a project chat holding a `/status` command message, a
 * reply with a background `task` part and a delivered result carrier (`data-task-result`), a chat without a project, a
 * journal row, a shell rule, a usage row, personal definitions and two background tasks; returns every row of the tables
 * 0008 must not touch (besides the new `projects.output_style`).
 */
async function seedV16Database(path: string): Promise<Record<V16Table, Record<string, unknown>[]>> {
  const database = await open(path)
  await migrateDatabase(database.db, { migrationsFolder: v16Folder() })
  const before = await database.client.execute(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('hooks', 'project_trust')`)
  expect(before.rows).toHaveLength(0)
  for (const [id, name] of [[V16_PROJECT, 'git-demo'], [V16_OTHER_PROJECT, 'untrusted']] as const) {
    await database.client.execute({
      sql: 'INSERT INTO projects (id, name, path, instructions, created_at, updated_at) VALUES (?, ?, ?, ?, 100, 200)',
      args: [id, name, `/srv/projects/${name}`, id === V16_PROJECT ? 'Use pnpm.' : null],
    })
  }
  const task = { status: 'completed', type: 'explore', description: 'Look around', modelRef: 'mock:background', steps: [], stepsOmitted: 0, report: 'Found 3 files.', startedAt: 1, finishedAt: 2 }
  const turns: Array<[string, string | null, Array<['user' | 'assistant', unknown[], Record<string, unknown>]>]> = [
    [CHAT_T1, V16_PROJECT, [
      ['user', [{ type: 'text', text: 'Status now' }], { command: { name: 'status', source: 'project', input: 'now', expansion: 'Run !`git status --short` and read @README.md: now' } }],
      ['assistant', [{ type: 'tool-task', toolCallId: 'mock_task_1', state: 'output-available', input: { description: 'Look around', prompt: 'List files', type: 'explore', background: true }, output: { status: 'running', taskId: 'bgt_v16task00000001' } }], { modelRef: 'mock:background', startedAt: 1 }],
      ['user', [{ type: 'data-task-result', id: 'bgt_v16task00000001', data: { taskId: 'bgt_v16task00000001', toolCallId: 'mock_task_1', output: task } }], {}],
      ['assistant', [{ type: 'text', text: 'The task found 3 files.' }], { modelRef: 'mock:background', startedAt: 3 }],
    ]],
    [CHAT_T2, null, [
      ['user', [{ type: 'text', text: 'Hello' }], {}],
      ['assistant', [{ type: 'text', text: 'Hi.' }], { modelRef: 'mock:echo', startedAt: 4 }],
    ]],
  ]
  for (const [index, [chatId, projectId, messages]] of turns.entries()) {
    const ids = messages.map((_, seq) => `msg_t${index + 1}${String(seq).padStart(14, '0')}`)
    await database.client.execute({
      sql: 'INSERT INTO chats (id, title, title_source, model_ref, settings, pinned, archived, pending_approval, active_leaf_id, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?)',
      args: [chatId, `Chat ${index}`, 'user', 'mock:background', '{"toolMode":"ask"}', ids[ids.length - 1] ?? null, projectId, 1000 + index, 2000 + index],
    })
    for (const [seq, [role, parts, metadata]] of messages.entries()) {
      await database.client.execute({
        sql: 'INSERT INTO messages (id, chat_id, parent_id, selected_child_id, seq, role, parts, metadata, search_text, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)',
        args: [ids[seq] ?? null, chatId, seq === 0 ? null : (ids[seq - 1] ?? null), seq, role, JSON.stringify(parts), JSON.stringify(metadata), `${role} ${seq}`, 3000 + seq, 4000 + seq],
      })
    }
  }
  await database.client.execute({
    sql: `INSERT INTO workspace_changes (chat_id, project_id, message_seq, message_id, tool_call_id, kind, tool, path, before_state, after_sha, after_size, created_at)
          VALUES (?, ?, 1, 'msg_t100000000000001', 'call_1', 'edit', 'write_file', 'notes.txt', 'missing', ?, 1, 7)`,
    args: [CHAT_T1, V16_PROJECT, 'e'.repeat(64)],
  })
  await database.client.execute({ sql: 'INSERT INTO shell_rules (id, project_id, prefix, created_at) VALUES (?, ?, ?, 8)', args: ['srl_v16rule000000001', V16_PROJECT, 'git status'] })
  await database.client.execute({
    sql: 'INSERT INTO usage (chat_id, message_id, purpose, provider_id, model_id, input, output, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    args: [CHAT_T1, 'msg_t100000000000001', 'subagent', 'mock', 'background', 3, 4, 5000],
  })
  for (const [id, kind, name] of [['cus_v16custom0000001', 'agent', 'reviewer'], ['cus_v16custom0000002', 'command', 'greet'], ['cus_v16custom0000003', 'skill', 'release-notes']] as const) {
    await database.client.execute({
      sql: 'INSERT INTO customizations (id, kind, name, description, content, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 10, 11)',
      args: [id, kind, name, `The ${name} ${kind}.`, `---\nname: ${name}\ndescription: The ${name} ${kind}.\n---\nBody of ${name}.`],
    })
  }
  for (const [id, status, deliveredAt, deliveredMessageId] of [['bgt_v16task00000001', 'completed', 20, 'msg_t100000000000002'], ['bgt_v16task00000002', 'aborted', null, null]] as const) {
    await database.client.execute({
      sql: `INSERT INTO background_tasks (id, chat_id, message_id, tool_call_id, type, description, status, origin, output, created_at, finished_at, delivered_at, delivered_message_id)
            VALUES (?, ?, 'msg_t100000000000001', 'mock_task_1', 'explore', 'Look around', ?, 'request', ?, 12, 13, ?, ?)`,
      args: [id, CHAT_T1, status, JSON.stringify({ ...task, status }), deliveredAt, deliveredMessageId],
    })
  }
  const seeded = {
    projects: await rows(database, 'projects', 'id'),
    chats: await rows(database, 'chats', 'id'),
    messages: await rows(database, 'messages', 'chat_id, seq'),
    workspace_changes: await rows(database, 'workspace_changes', 'id'),
    shell_rules: await rows(database, 'shell_rules', 'id'),
    usage: await rows(database, 'usage', 'id'),
    customizations: await rows(database, 'customizations', 'id'),
    background_tasks: await rows(database, 'background_tasks', 'id'),
  }
  database.close()
  return seeded
}

describe('upgrade of a v1.6 database through migration 0008 (hooks, project trust, project output style)', () => {
  it('0008 is two CREATE TABLE and one ALTER TABLE `projects` ADD `output_style`, never a rebuild, an index or a data change', () => {
    const statements = hooksTrustStatements()
    expect(statements).toHaveLength(3)
    const tables = statements.filter(statement => statement.startsWith('CREATE TABLE '))
    expect(tables.map(statement => statement.match(/^CREATE TABLE `(\w+)`/)?.[1]).sort()).toEqual(['hooks', 'project_trust'])
    const alters = statements.filter(statement => /^ALTER\s+TABLE/i.test(statement))
    expect(alters).toEqual(['ALTER TABLE `projects` ADD `output_style` text;'])
    const sql = statements.join('\n')
    // The only `UPDATE` allowed is the foreign key's `ON UPDATE no action`.
    for (const forbidden of [/DROP\s+/i, /__new_/i, /PRAGMA/i, /\bINDEX\b/i, /\bDELETE\s+FROM\b/i, /\bUPDATE\s+`?\w+`?\s+SET\b/i, /\bINSERT\b/i])
      expect(sql, String(forbidden)).not.toMatch(forbidden)
    expect(sql.replaceAll('ON UPDATE no action', '')).not.toMatch(/\bUPDATE\b/i)
    // The only foreign key: project_trust.project_id -> projects.id, cascading; the primary key is (project_id, sha256).
    expect(sql.match(/FOREIGN KEY/g)).toHaveLength(1)
    const trust = tables.find(statement => statement.includes('`project_trust`'))
    expect(trust).toMatch(/FOREIGN KEY \(`project_id`\) REFERENCES `projects`\(`id`\) ON UPDATE no action ON DELETE cascade/)
    expect(trust).toMatch(/PRIMARY KEY\(`project_id`, `sha256`\)/)
    expect(tables.find(statement => statement.includes('`hooks`'))).toMatch(/`enabled` integer DEFAULT true NOT NULL/)
    expect(JOURNAL.entries.slice(0, 9)).toEqual([INITIAL, TREE, REMEMBERED, REFRESH, PROJECTS, CHECKPOINTS, SHELL_UNIQUE, CUSTOMIZATIONS, HOOKS_TRUST])
    expect(HOOKS_TRUST?.tag).toBe('0008_hooks_trust')
  })

  it('both tables exist and are empty; output_style is null on every project; every row survives; the schema matches a fresh one', async () => {
    const path = join(tempDir(), 'harness.db')
    const before = await seedV16Database(path)
    const database = await open(path)
    await migrateDatabase(database.db)

    expect(await scalar(database, 'SELECT count(*) AS n FROM hooks')).toBe(0)
    expect(await scalar(database, 'SELECT count(*) AS n FROM project_trust')).toBe(0)
    expect(await scalar(database, 'SELECT count(*) AS n FROM projects WHERE output_style IS NOT NULL')).toBe(0)
    expect(await rows(database, 'projects', 'id')).toEqual(before.projects.map(row => ({ ...row, output_style: null })))
    expect(await rows(database, 'chats', 'id')).toEqual(before.chats)
    expect(await rows(database, 'messages', 'chat_id, seq')).toEqual(before.messages)
    expect(await rows(database, 'workspace_changes', 'id')).toEqual(before.workspace_changes)
    expect(await rows(database, 'shell_rules', 'id')).toEqual(before.shell_rules)
    expect(await rows(database, 'usage', 'id')).toEqual(before.usage)
    expect(await rows(database, 'customizations', 'id')).toEqual(before.customizations)
    expect(await rows(database, 'background_tasks', 'id')).toEqual(before.background_tasks)

    const applied = await database.client.execute('SELECT created_at FROM __drizzle_migrations ORDER BY created_at')
    expect(applied.rows.map(row => Number(row.created_at))).toEqual(JOURNAL.entries.map(entry => entry.when))
    // 0008 and every later migration (Phase 12: 0009).
    expect(applied.rows).toHaveLength(10)
    const shape = await schemaShape(database)
    expect(shape.tables).toEqual([...TABLE_NAMES].sort())
    expect(shape.tables).toHaveLength(23)
    const fresh = await open(':memory:')
    await migrateDatabase(fresh.db)
    expect(shape).toEqual(await schemaShape(fresh))
    expect(shape.foreignKeys.project_trust?.map(key => (key as unknown[]).slice(0, 4).join(' '))).toEqual(['project_id projects id CASCADE'])
    expect(shape.foreignKeys.hooks).toEqual([])
    expect((await database.client.execute('PRAGMA foreign_key_check')).rows).toEqual([])
    expect((await database.client.execute('PRAGMA integrity_check')).rows.map(row => String(row.integrity_check))).toEqual(['ok'])

    // Idempotent: migrating again applies nothing.
    await migrateDatabase(database.db)
    expect(await scalar(database, 'SELECT count(*) AS n FROM __drizzle_migrations')).toBe(JOURNAL.entries.length)
  })

  it('a second (project, sha256) is a primary-key violation; deleting a project cascades to its project_trust rows only', async () => {
    const path = join(tempDir(), 'harness.db')
    await seedV16Database(path)
    const database = await open(path)
    await migrateDatabase(database.db)

    const approve = (projectId: string, sha256: string, kind = 'hook'): Promise<unknown> => database.client.execute({
      sql: 'INSERT INTO project_trust (project_id, sha256, kind, label, created_at) VALUES (?, ?, ?, ?, 1)',
      args: [projectId, sha256, kind, 'sh .claude/hooks/guard.sh'],
    })
    await approve(V16_PROJECT, V16_HASH_A)
    await approve(V16_PROJECT, V16_HASH_B, 'mcp')
    await approve(V16_OTHER_PROJECT, V16_HASH_A)
    expect(await primaryKeyViolation(approve(V16_PROJECT, V16_HASH_A, 'command'))).toBe('UNIQUE constraint failed: project_trust.project_id, project_trust.sha256')
    // An approval of a project that does not exist is refused (foreign keys are on).
    await expect(approve('prj_v16missing000001', V16_HASH_A)).rejects.toThrow()
    await database.client.execute({
      sql: `INSERT INTO hooks (id, event, matcher, command, timeout, enabled, created_at, updated_at) VALUES ('hok_v16hook000000001', 'PreToolUse', 'Bash', 'sh guard.sh', NULL, 1, 1, 1)`,
      args: [],
    })

    // The project service detaches its chats itself; the schema cascades into project_trust (and, since 0005, the
    // journal rows and shell rules).
    await database.client.execute({ sql: 'UPDATE chats SET project_id = NULL WHERE project_id = ?', args: [V16_PROJECT] })
    await database.client.execute({ sql: 'DELETE FROM projects WHERE id = ?', args: [V16_PROJECT] })
    expect((await rows(database, 'project_trust', 'project_id, sha256')).map(row => [row.project_id, row.sha256])).toEqual([[V16_OTHER_PROJECT, V16_HASH_A]])
    // Personal hooks are configuration: a project delete never touches them.
    expect(await scalar(database, 'SELECT count(*) AS n FROM hooks')).toBe(1)
    expect((await database.client.execute('PRAGMA foreign_key_check')).rows).toEqual([])
  })

  it('boots on the upgraded database: every chat is served with its stored parts and metadata; projects answer outputStyle null', async () => {
    const dataDir = tempDir()
    const databasePath = join(dataDir, 'harness.db')
    const before = await seedV16Database(databasePath)
    const t = await createTestApp({ dataDir, databasePath, start: false })
    try {
      const list = cursorPageSchema(chatSummarySchema).parse(await (await t.request('/api/chats')).json())
      expect(list.items.map(chat => [chat.id, chat.projectId]).sort()).toEqual([[CHAT_T1, V16_PROJECT], [CHAT_T2, null]])
      const detail = chatDetailSchema.parse(await (await t.request(`/api/chats/${CHAT_T1}`)).json())
      const stored = before.messages.filter(row => row.chat_id === CHAT_T1)
      expect(detail.messages.map(message => message.id)).toEqual(stored.map(row => row.id))
      for (const [index, message] of detail.messages.entries()) {
        expect(message.parts, String(message.id)).toEqual(JSON.parse(String(stored[index]?.parts)))
        expect(message.metadata?.command, String(message.id)).toEqual((JSON.parse(String(stored[index]?.metadata)) as { command?: unknown }).command)
      }
      expect((await t.deps.projects.list()).map(project => [project.id, project.outputStyle])).toEqual([[V16_PROJECT, null], [V16_OTHER_PROJECT, null]])
      // The Phase 11 stubs answer empty: nothing was approved, nothing runs.
      expect(await t.deps.projectTrust.approved(V16_PROJECT)).toEqual(new Set())
      expect((await t.deps.hooks.list({})).items).toEqual([])
    }
    finally {
      await t.close()
    }
  })
})

/** A migrations folder holding 0000 - 0008 (their SQL + a nine-entry journal): the schema of a v1.7 data directory. */
function v17Folder(): string {
  const entries = [INITIAL, TREE, REMEMBERED, REFRESH, PROJECTS, CHECKPOINTS, SHELL_UNIQUE, CUSTOMIZATIONS, HOOKS_TRUST]
  if (entries.includes(undefined))
    throw new Error('a migration of 0000 - 0008 is missing from the journal')
  const dir = tempDir()
  mkdirSync(join(dir, 'meta'))
  for (const entry of entries as JournalEntry[])
    copyFileSync(join(REAL_FOLDER, `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`))
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({ ...JOURNAL, entries }))
  return dir
}

/** The statements of migration 0009 without comments and blank lines (split like `migrate()` does). */
function claudeEcosystemStatements(): string[] {
  if (CLAUDE_ECOSYSTEM === undefined)
    throw new Error('migration 0009 is missing from the journal')
  return readFileSync(join(REAL_FOLDER, `${CLAUDE_ECOSYSTEM.tag}.sql`), 'utf8')
    .split('--> statement-breakpoint')
    .map(statement => statement.replace(/^--.*$/gm, '').trim())
    .filter(Boolean)
}

const V17_PROJECT = 'prj_v17project000001'
const CHAT_U1 = '0199a8f0-0000-7000-8000-0000000001b1'
const CHAT_U2 = '0199a8f0-0000-7000-8000-0000000001b2'
const V17_PIN = 'c'.repeat(64)

type V17Table = 'plugins' | 'hooks' | 'projects' | 'project_trust' | 'customizations' | 'chats' | 'messages' | 'usage' | 'settings'

/** The `data-hook` record of a v1.7 `UserPromptSubmit` hook (stored on the user message). */
const V17_HOOK_PART = {
  type: 'data-hook',
  id: 'hev_v17hookrecord001',
  data: {
    id: 'hev_v17hookrecord001',
    event: 'UserPromptSubmit',
    outcome: 'context',
    createdAt: 30,
    hooks: [{ source: 'personal', label: 'sh .claude/hooks/context.sh', exitCode: 0, durationMs: 12 }],
    context: 'lint ok',
  },
}

/**
 * Creates a v1.7 database file (0000 - 0008) with plugins (a builtin, a pinned zip plugin, a linked folder with a path
 * pin and an error), two personal hooks (one off), a project with two approvals, a personal command with a `!` span, a
 * project chat whose user message holds a `data-hook` part, a chat without a project, a usage row and a setting; returns
 * every row of those tables.
 */
async function seedV17Database(path: string): Promise<Record<V17Table, Record<string, unknown>[]>> {
  const database = await open(path)
  await migrateDatabase(database.db, { migrationsFolder: v17Folder() })
  const before = await database.client.execute(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'marketplaces'`)
  expect(before.rows).toHaveLength(0)
  const pluginRows: Array<[string, string, string | null, string, number, string | null, string | null]> = [
    ['core-tools', 'builtin', null, '1.7.0', 1, null, null],
    ['acme-zip', 'zip', 'acme-zip.zip', '2.1.0', 1, V17_PIN, null],
    ['hook-pack', 'link', '/srv/plugins/hook-pack', '0.3.0', 0, `path:${'d'.repeat(64)}`, JSON.stringify({ code: 'plugin_error', message: 'The plugin failed to load.' })],
  ]
  for (const [id, source, sourceRef, version, enabled, trustedHash, lastError] of pluginRows) {
    await database.client.execute({
      sql: 'INSERT INTO plugins (id, source, source_ref, version, enabled, trusted_hash, loading_since, last_error, installed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 50, 60)',
      args: [id, source, sourceRef, version, enabled, trustedHash, lastError],
    })
  }
  await database.client.execute(`INSERT INTO hooks (id, event, matcher, command, timeout, enabled, created_at, updated_at) VALUES ('hok_v17hook000000001', 'PreToolUse', 'Bash|Write', 'sh .claude/hooks/guard.sh', 30, 1, 70, 71)`)
  await database.client.execute(`INSERT INTO hooks (id, event, matcher, command, timeout, enabled, created_at, updated_at) VALUES ('hok_v17hook000000002', 'Stop', NULL, 'sh check.sh', NULL, 0, 72, 73)`)
  await database.client.execute({
    sql: 'INSERT INTO projects (id, name, path, instructions, output_style, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 100, 200)',
    args: [V17_PROJECT, 'hooks-demo', '/srv/projects/hooks-demo', 'Use pnpm.', 'explanatory'],
  })
  for (const [sha256, kind, label] of [['a'.repeat(64), 'hook', 'sh .claude/hooks/guard.sh'], ['b'.repeat(64), 'mcp', 'github']] as const) {
    await database.client.execute({ sql: 'INSERT INTO project_trust (project_id, sha256, kind, label, created_at) VALUES (?, ?, ?, ?, 80)', args: [V17_PROJECT, sha256, kind, label] })
  }
  await database.client.execute({
    sql: 'INSERT INTO customizations (id, kind, name, description, content, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 10, 11)',
    args: ['cus_v17custom0000001', 'command', 'status', 'Show the status.', '---\nname: status\ndescription: Show the status.\n---\nRun !`git status --short`: $ARGUMENTS'],
  })
  const turns: Array<[string, string | null, Array<['user' | 'assistant', unknown[], Record<string, unknown>]>]> = [
    [CHAT_U1, V17_PROJECT, [
      ['user', [{ type: 'text', text: 'Check the code' }, V17_HOOK_PART], {}],
      ['assistant', [{ type: 'text', text: 'Lint is fine.' }], { modelRef: 'mock:hooks', startedAt: 31 }],
    ]],
    [CHAT_U2, null, [
      ['user', [{ type: 'text', text: 'Hello' }], {}],
      ['assistant', [{ type: 'text', text: 'Hi.' }], { modelRef: 'mock:echo', startedAt: 4 }],
    ]],
  ]
  for (const [index, [chatId, projectId, messages]] of turns.entries()) {
    const ids = messages.map((_, seq) => `msg_u${index + 1}${String(seq).padStart(14, '0')}`)
    await database.client.execute({
      sql: 'INSERT INTO chats (id, title, title_source, model_ref, settings, pinned, archived, pending_approval, active_leaf_id, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?)',
      args: [chatId, `Chat ${index}`, 'user', 'mock:hooks', '{"toolMode":"ask"}', ids[ids.length - 1] ?? null, projectId, 1000 + index, 2000 + index],
    })
    for (const [seq, [role, parts, metadata]] of messages.entries()) {
      await database.client.execute({
        sql: 'INSERT INTO messages (id, chat_id, parent_id, selected_child_id, seq, role, parts, metadata, search_text, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)',
        args: [ids[seq] ?? null, chatId, seq === 0 ? null : (ids[seq - 1] ?? null), seq, role, JSON.stringify(parts), JSON.stringify(metadata), `${role} ${seq}`, 3000 + seq, 4000 + seq],
      })
    }
  }
  await database.client.execute({
    sql: 'INSERT INTO usage (chat_id, message_id, purpose, provider_id, model_id, input, output, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    args: [CHAT_U1, 'msg_u100000000000001', 'chat', 'mock', 'hooks', 3, 4, 5000],
  })
  await database.client.execute({ sql: 'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, 90)', args: ['hooksEnabled', 'true'] })
  const seeded = {
    plugins: await rows(database, 'plugins', 'id'),
    hooks: await rows(database, 'hooks', 'id'),
    projects: await rows(database, 'projects', 'id'),
    project_trust: await rows(database, 'project_trust', 'project_id, sha256'),
    customizations: await rows(database, 'customizations', 'id'),
    chats: await rows(database, 'chats', 'id'),
    messages: await rows(database, 'messages', 'chat_id, seq'),
    usage: await rows(database, 'usage', 'id'),
    settings: await rows(database, 'settings', 'key'),
  }
  database.close()
  return seeded
}

describe('upgrade of a v1.7 database through migration 0009 (marketplaces, plugin format and origin, hook handler fields)', () => {
  it('0009 is one CREATE TABLE, one CREATE UNIQUE INDEX and six ALTER TABLE … ADD, never a rebuild or a data change', () => {
    const statements = claudeEcosystemStatements()
    expect(statements).toHaveLength(8)
    const tables = statements.filter(statement => statement.startsWith('CREATE TABLE '))
    expect(tables.map(statement => statement.match(/^CREATE TABLE `(\w+)`/)?.[1])).toEqual(['marketplaces'])
    const indexes = statements.filter(statement => /^CREATE\s+(?:UNIQUE\s+)?INDEX/i.test(statement))
    expect(indexes).toEqual(['CREATE UNIQUE INDEX `marketplaces_name_unique` ON `marketplaces` (`name`);'])
    const alters = statements.filter(statement => /^ALTER\s+TABLE/i.test(statement))
    expect(alters.sort()).toEqual([
      'ALTER TABLE `hooks` ADD `model` text;',
      'ALTER TABLE `hooks` ADD `options` text;',
      'ALTER TABLE `hooks` ADD `prompt` text;',
      'ALTER TABLE `hooks` ADD `type` text DEFAULT \'command\' NOT NULL;',
      'ALTER TABLE `plugins` ADD `format` text DEFAULT \'harness\' NOT NULL;',
      'ALTER TABLE `plugins` ADD `origin` text;',
    ])
    expect(tables.length + indexes.length + alters.length).toBe(statements.length)
    const sql = statements.join('\n')
    for (const forbidden of [/DROP\s+/i, /__new_/i, /PRAGMA/i, /\bDELETE\b/i, /\bUPDATE\b/i, /\bINSERT\b/i, /FOREIGN KEY/i, /ALTER\s+TABLE\s+`?\w+`?\s+(?:RENAME|DROP)/i])
      expect(sql, String(forbidden)).not.toMatch(forbidden)
    expect(JOURNAL.entries.slice(0, 10)).toEqual([INITIAL, TREE, REMEMBERED, REFRESH, PROJECTS, CHECKPOINTS, SHELL_UNIQUE, CUSTOMIZATIONS, HOOKS_TRUST, CLAUDE_ECOSYSTEM])
    expect(CLAUDE_ECOSYSTEM?.tag).toBe('0009_claude_ecosystem')
  })

  it('marketplaces exists and is empty; plugins are harness without an origin; hooks are command hooks; every row survives', async () => {
    const path = join(tempDir(), 'harness.db')
    const before = await seedV17Database(path)
    const database = await open(path)
    await migrateDatabase(database.db)

    expect(await scalar(database, 'SELECT count(*) AS n FROM marketplaces')).toBe(0)
    expect(await scalar(database, `SELECT count(*) AS n FROM plugins WHERE format <> 'harness' OR origin IS NOT NULL`)).toBe(0)
    expect(await scalar(database, `SELECT count(*) AS n FROM hooks WHERE type <> 'command' OR prompt IS NOT NULL OR model IS NOT NULL OR options IS NOT NULL`)).toBe(0)
    expect(await rows(database, 'plugins', 'id')).toEqual(before.plugins.map(row => ({ ...row, format: 'harness', origin: null })))
    expect(await rows(database, 'hooks', 'id')).toEqual(before.hooks.map(row => ({ ...row, type: 'command', prompt: null, model: null, options: null })))
    expect(await rows(database, 'projects', 'id')).toEqual(before.projects)
    expect(await rows(database, 'project_trust', 'project_id, sha256')).toEqual(before.project_trust)
    expect(await rows(database, 'customizations', 'id')).toEqual(before.customizations)
    expect(await rows(database, 'chats', 'id')).toEqual(before.chats)
    expect(await rows(database, 'messages', 'chat_id, seq')).toEqual(before.messages)
    expect(await rows(database, 'usage', 'id')).toEqual(before.usage)
    expect(await rows(database, 'settings', 'key')).toEqual(before.settings)

    const applied = await database.client.execute('SELECT created_at FROM __drizzle_migrations ORDER BY created_at')
    expect(applied.rows.map(row => Number(row.created_at))).toEqual(JOURNAL.entries.map(entry => entry.when))
    expect(applied.rows).toHaveLength(10)
    const shape = await schemaShape(database)
    expect(shape.tables).toEqual([...TABLE_NAMES].sort())
    expect(shape.tables).toHaveLength(23)
    const fresh = await open(':memory:')
    await migrateDatabase(fresh.db)
    expect(shape).toEqual(await schemaShape(fresh))
    expect(shape.indexes.marketplaces_name_unique).toEqual(['name'])
    expect(shape.foreignKeys.marketplaces).toEqual([])
    expect((await database.client.execute('PRAGMA foreign_key_check')).rows).toEqual([])
    expect((await database.client.execute('PRAGMA integrity_check')).rows.map(row => String(row.integrity_check))).toEqual(['ok'])

    // Idempotent: migrating again applies nothing.
    await migrateDatabase(database.db)
    expect(await scalar(database, 'SELECT count(*) AS n FROM __drizzle_migrations')).toBe(JOURNAL.entries.length)
  })

  it('a second marketplace with the same name fails on the unique index; new rows take the column defaults', async () => {
    const path = join(tempDir(), 'harness.db')
    await seedV17Database(path)
    const database = await open(path)
    await migrateDatabase(database.db)

    const add = (id: string, name: string): Promise<unknown> => database.client.execute({
      sql: 'INSERT INTO marketplaces (id, name, source, created_at, updated_at) VALUES (?, ?, ?, 1, 1)',
      args: [id, name, JSON.stringify({ type: 'github', repo: 'acme/tools' })],
    })
    await add('mkt_v17market000001', 'acme')
    await add('mkt_v17market000002', 'other')
    expect(await uniqueViolation(add('mkt_v17market000003', 'acme'))).toBe('UNIQUE constraint failed: marketplaces.name')
    expect((await rows(database, 'marketplaces', 'id')).map(row => [row.id, row.name, row.resolved_ref, row.catalog, row.fetched_at, row.last_error]))
      .toEqual([['mkt_v17market000001', 'acme', null, null, null, null], ['mkt_v17market000002', 'other', null, null, null, null]])
    // A plugin or hook written the v1.7 way (without the new columns) takes the defaults.
    await database.client.execute(`INSERT INTO plugins (id, source, version, enabled, installed_at, updated_at) VALUES ('legacy', 'zip', '1.0.0', 1, 1, 1)`)
    await database.client.execute(`INSERT INTO hooks (id, event, command, enabled, created_at, updated_at) VALUES ('hok_v17hook000000003', 'Stop', 'sh stop.sh', 1, 1, 1)`)
    expect(await rows(database, 'plugins', 'id').then(list => list.find(row => row.id === 'legacy'))).toMatchObject({ format: 'harness', origin: null })
    expect(await rows(database, 'hooks', 'id').then(list => list.find(row => row.id === 'hok_v17hook000000003'))).toMatchObject({ type: 'command', prompt: null, model: null, options: null })
  })

  it('boots on the upgraded database: plugins read as harness, personal hooks as command hooks, chats unchanged, no marketplace', async () => {
    const dataDir = tempDir()
    const databasePath = join(dataDir, 'harness.db')
    const before = await seedV17Database(databasePath)
    const t = await createTestApp({ dataDir, databasePath, start: false })
    try {
      for (const id of ['core-tools', 'acme-zip', 'hook-pack'])
        expect(await t.deps.plugins.record(id), id).toMatchObject({ format: 'harness', origin: null })
      expect(await t.deps.plugins.record('acme-zip')).toMatchObject({ source: 'zip', trustedHash: V17_PIN, version: '2.1.0' })
      const hooks = await t.deps.hooks.list({})
      expect(hooks.items.filter(item => item.kind === 'command').map(item => [item.id, item.state])).toEqual([['hok_v17hook000000001', 'active'], ['hok_v17hook000000002', 'off']])
      expect((await t.deps.marketplaces.list()).items).toEqual([])
      const detail = chatDetailSchema.parse(await (await t.request(`/api/chats/${CHAT_U1}`)).json())
      const stored = before.messages.filter(row => row.chat_id === CHAT_U1)
      expect(detail.messages.map(message => message.parts)).toEqual(stored.map(row => JSON.parse(String(row.parts))))
      expect(detail.messages[0]?.parts[1]).toEqual(V17_HOOK_PART)
      const list = cursorPageSchema(chatSummarySchema).parse(await (await t.request('/api/chats')).json())
      expect(list.items.map(chat => [chat.id, chat.projectId]).sort()).toEqual([[CHAT_U1, V17_PROJECT], [CHAT_U2, null]])
    }
    finally {
      await t.close()
    }
  })
})
