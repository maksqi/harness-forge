import type { Database } from './client.ts'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from './client.ts'
import { migrateDatabase, resolveMigrationsFolder } from './migrate.ts'
import { chats, chatShares, messages, projects, TABLE_NAMES, usage } from './schema.ts'

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

interface ColumnInfo {
  name: string
  type: string
  notnull: number
  dflt_value: string | null
  pk: number
}

/** `PRAGMA table_info` of a table, by column name. */
async function columns(database: Database, table: string): Promise<Record<string, ColumnInfo>> {
  const result = await database.client.execute(`PRAGMA table_info(${table})`)
  return Object.fromEntries(result.rows.map((row) => {
    const column = { name: String(row.name), type: String(row.type), notnull: Number(row.notnull), dflt_value: row.dflt_value === null ? null : String(row.dflt_value), pk: Number(row.pk) }
    return [column.name, column]
  }))
}

/** `PRAGMA foreign_key_list` of a table: `from -> table.to (on_delete)`. */
async function foreignKeys(database: Database, table: string): Promise<string[]> {
  const result = await database.client.execute(`PRAGMA foreign_key_list(${table})`)
  return result.rows.map(row => `${String(row.from)} -> ${String(row.table)}.${String(row.to)} (${String(row.on_delete)})`)
}

/** Columns of an index, in order. */
async function indexColumns(database: Database, index: string): Promise<string[]> {
  const result = await database.client.execute(`PRAGMA index_info(${index})`)
  return result.rows.map(row => String(row.name))
}

describe('migrations', () => {
  it('finds the generated migrations folder of the package', () => {
    expect(resolveMigrationsFolder()).toMatch(/[/\\]apps[/\\]server[/\\]drizzle$/)
  })

  it('creates the 16 tables of the data model', async () => {
    const database = await freshDatabase()
    const tables = (await names(database, 'table')).filter(name => name !== '__drizzle_migrations')
    expect(TABLE_NAMES).toHaveLength(16)
    expect(TABLE_NAMES).toContain('chat_shares')
    expect(TABLE_NAMES).toContain('projects')
    expect(tables).toEqual([...TABLE_NAMES].sort())
  })

  it('creates the documented indexes', async () => {
    const database = await freshDatabase()
    expect(await names(database, 'index')).toEqual(expect.arrayContaining([
      'chat_shares_chat_idx',
      'chats_list_idx',
      'files_sha256_idx',
      'messages_chat_parent_idx',
      'messages_chat_seq_idx',
      'usage_chat_idx',
      'usage_created_idx',
      'projects_path_idx',
      'chats_project_idx',
    ]))
    expect(await indexColumns(database, 'messages_chat_parent_idx')).toEqual(['chat_id', 'parent_id'])
    expect(await indexColumns(database, 'chat_shares_chat_idx')).toEqual(['chat_id'])
  })

  it('applies every migration: 0000 initial schema, 0001 message tree and chat_shares, 0002 remembered versions, 0003, 0004 projects', async () => {
    const database = await freshDatabase()
    const journal = JSON.parse(readFileSync(join(resolveMigrationsFolder(), 'meta', '_journal.json'), 'utf8')) as { entries: Array<{ tag: string }> }
    expect(journal.entries.map(entry => entry.tag)).toEqual(['0000_initial_schema', '0001_message_tree_and_shares', '0002_remembered_versions', '0003_refresh_model_listings', '0004_projects'])
    const applied = await database.client.execute('SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at')
    expect(applied.rows).toHaveLength(journal.entries.length)
  })

  it('is idempotent', async () => {
    const database = await freshDatabase()
    await expect(migrateDatabase(database.db)).resolves.toBeUndefined()
    const applied = await database.client.execute('SELECT COUNT(*) AS n FROM __drizzle_migrations')
    expect(Number(applied.rows[0]?.n)).toBeGreaterThanOrEqual(1)
  })
})

describe('phase 5 schema (ADR-023 message tree, ADR-025 share links)', () => {
  it('adds nullable parent_id and active_leaf_id columns without foreign keys', async () => {
    const database = await freshDatabase()
    expect((await columns(database, 'messages')).parent_id).toEqual({ name: 'parent_id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 })
    expect((await columns(database, 'chats')).active_leaf_id).toEqual({ name: 'active_leaf_id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 })
    expect(await foreignKeys(database, 'messages')).toEqual(['chat_id -> chats.id (CASCADE)'])
    expect(await foreignKeys(database, 'chats')).toEqual([])
  })

  it('creates chat_shares as documented (no token column, cascade from chats)', async () => {
    const database = await freshDatabase()
    const table = await columns(database, 'chat_shares')
    expect(Object.keys(table).sort()).toEqual([
      'chat_id',
      'created_at',
      'expires_at',
      'file_ids',
      'id',
      'message_count',
      'options',
      'snapshot',
      'snapshot_at',
      'title',
      'updated_at',
    ])
    expect(table.id).toMatchObject({ type: 'TEXT', pk: 1 })
    expect(Object.values(table).filter(column => column.notnull === 0 && column.pk === 0).map(column => column.name).sort()).toEqual(['expires_at', 'title'])
    expect(table.file_ids?.dflt_value).toBe('\'[]\'')
    expect(table.message_count?.dflt_value).toBe('0')
    expect(await foreignKeys(database, 'chat_shares')).toEqual(['chat_id -> chats.id (CASCADE)'])
  })

  it('stores the tree columns and share rows; deleting a chat removes its shares', async () => {
    const { db } = await freshDatabase()
    const chatId = '0199a8f0-0000-7000-8000-000000000003'
    await db.insert(chats).values({ id: chatId })
    await db.insert(messages).values([
      { id: 'msg_aaaaaaaaaaaaaaaa', chatId, seq: 0, role: 'user', parts: [] },
      { id: 'msg_bbbbbbbbbbbbbbbb', chatId, parentId: 'msg_aaaaaaaaaaaaaaaa', seq: 1, role: 'assistant', parts: [] },
      { id: 'msg_cccccccccccccccc', chatId, seq: 2, role: 'user', parts: [] },
    ])
    await db.update(chats).set({ activeLeafId: 'msg_bbbbbbbbbbbbbbbb' }).where(eq(chats.id, chatId))
    const [chat] = await db.select().from(chats)
    expect(chat?.activeLeafId).toBe('msg_bbbbbbbbbbbbbbbb')
    const tree = await db.select({ id: messages.id, parentId: messages.parentId }).from(messages).orderBy(messages.seq)
    expect(tree).toEqual([
      { id: 'msg_aaaaaaaaaaaaaaaa', parentId: null },
      { id: 'msg_bbbbbbbbbbbbbbbb', parentId: 'msg_aaaaaaaaaaaaaaaa' },
      { id: 'msg_cccccccccccccccc', parentId: null },
    ])

    const options = { reasoning: false, toolDetails: true, attachments: true }
    const snapshot = { title: 'Shared', messages: [{ role: 'user' as const, parts: [{ type: 'text' as const, text: 'hi' }] }] }
    await db.insert(chatShares).values({ id: 'shr_0000000000000001', chatId, options, snapshot, snapshotAt: 5 })
    const [share] = await db.select().from(chatShares)
    expect(share).toMatchObject({ chatId, title: null, options, snapshot, fileIds: [], messageCount: 0, snapshotAt: 5, expiresAt: null })
    expect(share?.createdAt).toBeGreaterThan(0)
    await expect(db.insert(chatShares).values({ id: 'shr_0000000000000002', chatId: 'missing', options, snapshot, snapshotAt: 5 })).rejects.toThrow()

    // As `ChatsService.remove`: the messages first (the active leaf has no foreign key), then the chat.
    await db.delete(messages).where(eq(messages.chatId, chatId))
    await db.delete(chats).where(eq(chats.id, chatId))
    expect(await db.select().from(chatShares)).toEqual([])
  })
})

describe('phase 6 schema (ADR-030 remembered versions)', () => {
  it('adds a nullable selected_child_id column without a default, a foreign key or an index', async () => {
    const database = await freshDatabase()
    expect((await columns(database, 'messages')).selected_child_id).toEqual({ name: 'selected_child_id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 })
    expect(await foreignKeys(database, 'messages')).toEqual(['chat_id -> chats.id (CASCADE)'])
    const indexes = await database.client.execute(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'messages' AND name NOT LIKE 'sqlite_%'`)
    for (const row of indexes.rows)
      expect(await indexColumns(database, String(row.name)), String(row.name)).not.toContain('selected_child_id')
  })

  it('stores the remembered child as a hint: a pointer may outlive its child', async () => {
    const { db } = await freshDatabase()
    const chatId = '0199a8f0-0000-7000-8000-000000000004'
    await db.insert(chats).values({ id: chatId })
    await db.insert(messages).values([
      { id: 'msg_aaaaaaaaaaaaaaaa', chatId, seq: 0, role: 'user', parts: [], selectedChildId: 'msg_bbbbbbbbbbbbbbbb' },
      { id: 'msg_bbbbbbbbbbbbbbbb', chatId, parentId: 'msg_aaaaaaaaaaaaaaaa', seq: 1, role: 'assistant', parts: [] },
    ])
    const rows = await db.select({ id: messages.id, selectedChildId: messages.selectedChildId }).from(messages).orderBy(messages.seq)
    expect(rows).toEqual([
      { id: 'msg_aaaaaaaaaaaaaaaa', selectedChildId: 'msg_bbbbbbbbbbbbbbbb' },
      { id: 'msg_bbbbbbbbbbbbbbbb', selectedChildId: null },
    ])
    // No foreign key: deleting the child keeps the pointer (readers fall back to the latest leaf).
    await db.delete(messages).where(eq(messages.id, 'msg_bbbbbbbbbbbbbbbb'))
    const [parent] = await db.select({ selectedChildId: messages.selectedChildId }).from(messages)
    expect(parent?.selectedChildId).toBe('msg_bbbbbbbbbbbbbbbb')
  })
})

describe('phase 7 schema (ADR-031 projects)', () => {
  it('creates projects as documented: text id, unique canonical path, nullable instructions, timestamps', async () => {
    const database = await freshDatabase()
    const table = await columns(database, 'projects')
    expect(Object.values(table).map(column => [column.name, column.type, column.notnull, column.pk])).toEqual([
      ['id', 'TEXT', 1, 1],
      ['name', 'TEXT', 1, 0],
      ['path', 'TEXT', 1, 0],
      ['instructions', 'TEXT', 0, 0],
      ['created_at', 'INTEGER', 1, 0],
      ['updated_at', 'INTEGER', 1, 0],
    ])
    expect(await indexColumns(database, 'projects_path_idx')).toEqual(['path'])
    expect(await foreignKeys(database, 'projects')).toEqual([])
  })

  it('adds a nullable chats.project_id without a default or a foreign key, indexed with archived and the list order', async () => {
    const database = await freshDatabase()
    expect((await columns(database, 'chats')).project_id).toEqual({ name: 'project_id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 })
    expect(await foreignKeys(database, 'chats')).toEqual([])
    expect(await indexColumns(database, 'chats_project_idx')).toEqual(['project_id', 'archived', 'updated_at', 'id'])
    const sql = await database.client.execute(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'chats_project_idx'`)
    expect(String(sql.rows[0]?.sql)).toMatch(/"updated_at" DESC,\s*"id" DESC/i)
  })

  it('stores projects; a project path is unique; deleting a project leaves the chats that name it (no foreign key)', async () => {
    const { db } = await freshDatabase()
    await db.insert(projects).values({ id: 'prj_AAAAAAAAAAAAAAAA', name: 'Demo', path: '/srv/projects/demo', createdAt: 1, updatedAt: 2 })
    const [project] = await db.select().from(projects)
    expect(project).toEqual({ id: 'prj_AAAAAAAAAAAAAAAA', name: 'Demo', path: '/srv/projects/demo', instructions: null, createdAt: 1, updatedAt: 2 })
    await expect(db.insert(projects).values({ id: 'prj_BBBBBBBBBBBBBBBB', name: 'Copy', path: '/srv/projects/demo', createdAt: 1, updatedAt: 1 })).rejects.toThrow()

    const chatId = '0199a8f0-0000-7000-8000-000000000005'
    await db.insert(chats).values({ id: chatId, projectId: 'prj_AAAAAAAAAAAAAAAA' })
    const [chat] = await db.select({ projectId: chats.projectId }).from(chats)
    expect(chat?.projectId).toBe('prj_AAAAAAAAAAAAAAAA')
    // The project service detaches chats itself (one transaction); the schema never cascades into chats.
    await db.delete(projects).where(eq(projects.id, 'prj_AAAAAAAAAAAAAAAA'))
    expect(await db.select({ id: chats.id, projectId: chats.projectId }).from(chats)).toEqual([{ id: chatId, projectId: 'prj_AAAAAAAAAAAAAAAA' }])
    // A chat without a project.
    await db.insert(chats).values({ id: '0199a8f0-0000-7000-8000-000000000006' })
    const [plain] = await db.select({ projectId: chats.projectId }).from(chats).where(eq(chats.id, '0199a8f0-0000-7000-8000-000000000006'))
    expect(plain?.projectId).toBeNull()
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
