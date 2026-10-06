import type { Database } from './client.ts'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from './client.ts'
import { primaryKeyViolation, uniqueViolation } from './constraint.test-util.ts'
import { migrateDatabase, resolveMigrationsFolder } from './migrate.ts'
import { backgroundTasks, chats, chatShares, customizations, hooks, marketplaces, messages, plugins, projects, projectTrust, shellRules, TABLE_NAMES, usage, workspaceChanges } from './schema.ts'

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

  it('creates the 23 tables of the data model', async () => {
    const database = await freshDatabase()
    const tables = (await names(database, 'table')).filter(name => name !== '__drizzle_migrations')
    expect(TABLE_NAMES).toHaveLength(23)
    expect(TABLE_NAMES).toContain('marketplaces')
    expect(TABLE_NAMES).toContain('hooks')
    expect(TABLE_NAMES).toContain('project_trust')
    expect(TABLE_NAMES).toContain('chat_shares')
    expect(TABLE_NAMES).toContain('projects')
    expect(TABLE_NAMES).toContain('workspace_changes')
    expect(TABLE_NAMES).toContain('shell_rules')
    expect(TABLE_NAMES).toContain('customizations')
    expect(TABLE_NAMES).toContain('background_tasks')
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
      'workspace_changes_chat_path_idx',
      'workspace_changes_chat_seq_idx',
      'workspace_changes_project_idx',
      'workspace_changes_before_sha_idx',
      'shell_rules_project_idx',
      'shell_rules_global_prefix_uq',
      'shell_rules_project_prefix_uq',
      'customizations_kind_name_uq',
      'background_tasks_chat_idx',
      'background_tasks_pending_idx',
      'marketplaces_name_unique',
    ]))
    expect(await indexColumns(database, 'messages_chat_parent_idx')).toEqual(['chat_id', 'parent_id'])
    expect(await indexColumns(database, 'chat_shares_chat_idx')).toEqual(['chat_id'])
  })

  it('applies every migration: 0000 initial schema, 0001 message tree and chat_shares, 0002 remembered versions, 0003, 0004 projects, 0005 workspace checkpoints, 0006 shell rule unique, 0007 customizations, 0008 hooks and trust, 0009 claude ecosystem', async () => {
    const database = await freshDatabase()
    const journal = JSON.parse(readFileSync(join(resolveMigrationsFolder(), 'meta', '_journal.json'), 'utf8')) as { entries: Array<{ tag: string }> }
    expect(journal.entries.map(entry => entry.tag)).toEqual([
      '0000_initial_schema',
      '0001_message_tree_and_shares',
      '0002_remembered_versions',
      '0003_refresh_model_listings',
      '0004_projects',
      '0005_workspace_checkpoints',
      '0006_shell_rule_unique',
      '0007_customizations',
      '0008_hooks_trust',
      '0009_claude_ecosystem',
    ])
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
  it('creates projects as documented: text id, unique canonical path, nullable instructions, timestamps (Phase 11: output_style)', async () => {
    const database = await freshDatabase()
    const table = await columns(database, 'projects')
    expect(Object.values(table).map(column => [column.name, column.type, column.notnull, column.pk])).toEqual([
      ['id', 'TEXT', 1, 1],
      ['name', 'TEXT', 1, 0],
      ['path', 'TEXT', 1, 0],
      ['instructions', 'TEXT', 0, 0],
      ['created_at', 'INTEGER', 1, 0],
      ['updated_at', 'INTEGER', 1, 0],
      // Phase 11 (0008, ADR-051): added by `ALTER TABLE ... ADD`, so it comes last.
      ['output_style', 'TEXT', 0, 0],
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
    expect(project).toEqual({ id: 'prj_AAAAAAAAAAAAAAAA', name: 'Demo', path: '/srv/projects/demo', instructions: null, outputStyle: null, createdAt: 1, updatedAt: 2 })
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

describe('phase 8 schema (ADR-036 checkpoint journal, ADR-038 shell rules)', () => {
  it('creates workspace_changes as documented: the journal columns, two cascading foreign keys, four indexes', async () => {
    const database = await freshDatabase()
    const table = await columns(database, 'workspace_changes')
    expect(Object.values(table).map(column => [column.name, column.type, column.notnull, column.pk])).toEqual([
      ['id', 'INTEGER', 1, 1],
      ['chat_id', 'TEXT', 1, 0],
      ['project_id', 'TEXT', 1, 0],
      ['message_seq', 'INTEGER', 1, 0],
      ['message_id', 'TEXT', 0, 0],
      ['tool_call_id', 'TEXT', 0, 0],
      ['batch_id', 'TEXT', 0, 0],
      ['kind', 'TEXT', 1, 0],
      ['tool', 'TEXT', 0, 0],
      ['path', 'TEXT', 0, 0],
      ['command', 'TEXT', 0, 0],
      ['before_state', 'TEXT', 0, 0],
      ['before_sha', 'TEXT', 0, 0],
      ['before_size', 'INTEGER', 0, 0],
      ['before_mode', 'INTEGER', 0, 0],
      ['after_sha', 'TEXT', 0, 0],
      ['after_size', 'INTEGER', 0, 0],
      ['created_at', 'INTEGER', 1, 0],
    ])
    expect(Object.values(table).every(column => column.dflt_value === null)).toBe(true)
    expect((await foreignKeys(database, 'workspace_changes')).sort()).toEqual(['chat_id -> chats.id (CASCADE)', 'project_id -> projects.id (CASCADE)'])
    expect(await indexColumns(database, 'workspace_changes_chat_path_idx')).toEqual(['chat_id', 'path', 'id'])
    expect(await indexColumns(database, 'workspace_changes_chat_seq_idx')).toEqual(['chat_id', 'message_seq'])
    expect(await indexColumns(database, 'workspace_changes_project_idx')).toEqual(['project_id', 'id'])
    expect(await indexColumns(database, 'workspace_changes_before_sha_idx')).toEqual(['before_sha'])
    const autoincrement = await database.client.execute(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workspace_changes'`)
    expect(String(autoincrement.rows[0]?.sql)).toMatch(/`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL/i)
  })

  it('creates shell_rules as documented: a nullable project_id (null = global) cascading from projects', async () => {
    const database = await freshDatabase()
    const table = await columns(database, 'shell_rules')
    expect(Object.values(table).map(column => [column.name, column.type, column.notnull, column.pk])).toEqual([
      ['id', 'TEXT', 1, 1],
      ['project_id', 'TEXT', 0, 0],
      ['prefix', 'TEXT', 1, 0],
      ['created_at', 'INTEGER', 1, 0],
    ])
    expect(await foreignKeys(database, 'shell_rules')).toEqual(['project_id -> projects.id (CASCADE)'])
    expect(await indexColumns(database, 'shell_rules_project_idx')).toEqual(['project_id'])
    // Phase 9 (0006): uniqueness per scope is the database's (two partial unique indexes, see below); caps stay the
    // service's.
    const unique = await database.client.execute(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'shell_rules' AND sql LIKE '%UNIQUE%' ORDER BY name`)
    expect(unique.rows.map(row => String(row.name))).toEqual(['shell_rules_global_prefix_uq', 'shell_rules_project_prefix_uq'])
  })

  it('stores journal rows and rules; deleting a chat or a project cascades, global rules stay', async () => {
    const { db } = await freshDatabase()
    const projectId = 'prj_AAAAAAAAAAAAAAAA'
    const chatA = '0199a8f0-0000-7000-8000-0000000000a1'
    const chatB = '0199a8f0-0000-7000-8000-0000000000a2'
    await db.insert(projects).values({ id: projectId, name: 'Demo', path: '/srv/projects/demo', createdAt: 1, updatedAt: 1 })
    await db.insert(chats).values([{ id: chatA, projectId }, { id: chatB, projectId }])
    await db.insert(workspaceChanges).values([
      { chatId: chatA, projectId, messageSeq: 1, messageId: 'msg_AAAAAAAAAAAAAAAA', toolCallId: 'call_1', kind: 'edit', tool: 'write_file', path: 'a.txt', beforeState: 'missing', afterSha: 'a'.repeat(64), afterSize: 3, createdAt: 10 },
      { chatId: chatA, projectId, messageSeq: 1, messageId: 'msg_AAAAAAAAAAAAAAAA', toolCallId: 'call_2', kind: 'shell', tool: 'shell', command: 'ls', createdAt: 11 },
      { chatId: chatB, projectId, messageSeq: 3, batchId: 'wcb_AAAAAAAAAAAAAAAA', kind: 'rewind', path: 'a.txt', beforeState: 'stored', beforeSha: 'a'.repeat(64), beforeSize: 3, beforeMode: 0o644, afterSha: null, createdAt: 12 },
    ])
    await db.insert(shellRules).values([
      { id: 'srl_AAAAAAAAAAAAAAAA', projectId, prefix: 'pnpm test', createdAt: 1 },
      { id: 'srl_BBBBBBBBBBBBBBBB', projectId: null, prefix: 'ls', createdAt: 2 },
    ])
    const rows = await db.select().from(workspaceChanges).orderBy(workspaceChanges.id)
    expect(rows.map(row => [row.id, row.chatId, row.kind])).toEqual([[1, chatA, 'edit'], [2, chatA, 'shell'], [3, chatB, 'rewind']])
    expect(rows[2]).toMatchObject({ messageId: null, toolCallId: null, tool: null, beforeMode: 0o644, afterSha: null, afterSize: null })
    // Real foreign keys: an unknown chat or project is refused.
    await expect(db.insert(workspaceChanges).values({ chatId: 'missing', projectId, messageSeq: 0, kind: 'edit', createdAt: 1 })).rejects.toThrow()
    await expect(db.insert(workspaceChanges).values({ chatId: chatA, projectId: 'prj_missing0000000', messageSeq: 0, kind: 'edit', createdAt: 1 })).rejects.toThrow()
    await expect(db.insert(shellRules).values({ id: 'srl_CCCCCCCCCCCCCCCC', projectId: 'prj_missing0000000', prefix: 'ls', createdAt: 1 })).rejects.toThrow()

    // Deleting a chat removes its rows (its messages first, as `ChatsService.remove` does).
    await db.delete(messages).where(eq(messages.chatId, chatA))
    await db.delete(chats).where(eq(chats.id, chatA))
    expect((await db.select().from(workspaceChanges)).map(row => row.chatId)).toEqual([chatB])
    // Deleting the project removes the rest of its rows and its rules; the global rule and the chats stay.
    await db.delete(projects).where(eq(projects.id, projectId))
    expect(await db.select().from(workspaceChanges)).toEqual([])
    expect((await db.select().from(shellRules)).map(rule => [rule.id, rule.projectId])).toEqual([['srl_BBBBBBBBBBBBBBBB', null]])
    expect((await db.select({ id: chats.id }).from(chats)).map(chat => chat.id)).toEqual([chatB])
  })
})

describe('phase 9 schema (0006: ADR-038 amendment, unique shell rules per scope)', () => {
  const PROJECT_A = 'prj_AAAAAAAAAAAAAAAA'
  const PROJECT_B = 'prj_BBBBBBBBBBBBBBBB'

  /** The `sql` of an index in `sqlite_master`, whitespace collapsed. */
  async function indexSql(database: Database, index: string): Promise<string> {
    const result = await database.client.execute({ sql: `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`, args: [index] })
    return String(result.rows[0]?.sql ?? '').replace(/\s+/g, ' ')
  }

  it('creates the two partial unique indexes with their WHERE (the shell_rules_project_idx stays)', async () => {
    const database = await freshDatabase()
    const indexes = await database.client.execute(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'shell_rules' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    expect(indexes.rows.map(row => String(row.name))).toEqual(['shell_rules_global_prefix_uq', 'shell_rules_project_idx', 'shell_rules_project_prefix_uq'])
    expect(await indexColumns(database, 'shell_rules_global_prefix_uq')).toEqual(['prefix'])
    expect(await indexColumns(database, 'shell_rules_project_prefix_uq')).toEqual(['project_id', 'prefix'])
    expect(await indexSql(database, 'shell_rules_global_prefix_uq')).toMatch(/^CREATE UNIQUE INDEX `shell_rules_global_prefix_uq` ON `shell_rules` \(`prefix`\) WHERE project_id is null$/)
    expect(await indexSql(database, 'shell_rules_project_prefix_uq')).toMatch(/^CREATE UNIQUE INDEX `shell_rules_project_prefix_uq` ON `shell_rules` \(`project_id`,\s?`prefix`\) WHERE project_id is not null$/)
    // `PRAGMA index_list` reports both as unique and partial.
    const list = await database.client.execute(`PRAGMA index_list(shell_rules)`)
    const flags = Object.fromEntries(list.rows.map(row => [String(row.name), [Number(row.unique), Number(row.partial)]]))
    expect(flags).toMatchObject({ shell_rules_global_prefix_uq: [1, 1], shell_rules_project_prefix_uq: [1, 1], shell_rules_project_idx: [0, 0] })
  })

  it('refuses the same prefix twice in one scope; the same prefix in other scopes is fine', async () => {
    const { db } = await freshDatabase()
    await db.insert(projects).values([
      { id: PROJECT_A, name: 'A', path: '/srv/projects/a', createdAt: 1, updatedAt: 1 },
      { id: PROJECT_B, name: 'B', path: '/srv/projects/b', createdAt: 1, updatedAt: 1 },
    ])
    await db.insert(shellRules).values([
      { id: 'srl_AAAAAAAAAAAAAAAA', projectId: null, prefix: 'ls', createdAt: 1 },
      { id: 'srl_BBBBBBBBBBBBBBBB', projectId: PROJECT_A, prefix: 'ls', createdAt: 2 },
      { id: 'srl_CCCCCCCCCCCCCCCC', projectId: PROJECT_B, prefix: 'ls', createdAt: 3 },
      { id: 'srl_DDDDDDDDDDDDDDDD', projectId: PROJECT_A, prefix: 'pnpm test', createdAt: 4 },
    ])
    expect(await uniqueViolation(db.insert(shellRules).values({ id: 'srl_EEEEEEEEEEEEEEEE', projectId: null, prefix: 'ls', createdAt: 5 })))
      .toBe('UNIQUE constraint failed: shell_rules.prefix')
    expect(await uniqueViolation(db.insert(shellRules).values({ id: 'srl_FFFFFFFFFFFFFFFF', projectId: PROJECT_A, prefix: 'ls', createdAt: 5 })))
      .toBe('UNIQUE constraint failed: shell_rules.project_id, shell_rules.prefix')
    expect(await db.select({ id: shellRules.id }).from(shellRules).orderBy(shellRules.id)).toHaveLength(4)
    // A deleted project frees its prefixes (the cascade), so the scope can hold them again.
    await db.delete(projects).where(eq(projects.id, PROJECT_A))
    await db.insert(projects).values({ id: PROJECT_A, name: 'A', path: '/srv/projects/a', createdAt: 2, updatedAt: 2 })
    await expect(db.insert(shellRules).values({ id: 'srl_FFFFFFFFFFFFFFFF', projectId: PROJECT_A, prefix: 'ls', createdAt: 6 })).resolves.toBeDefined()
  })

  it('records the compact and subagent usage purposes (text column without a CHECK)', async () => {
    const { db } = await freshDatabase()
    await db.insert(usage).values([
      { providerId: 'mock', modelId: 'compact', input: 1, purpose: 'compact' },
      { providerId: 'mock', modelId: 'subagent', input: 2, purpose: 'subagent' },
    ])
    expect((await db.select({ purpose: usage.purpose }).from(usage).orderBy(usage.input)).map(row => row.purpose)).toEqual(['compact', 'subagent'])
  })
})

describe('phase 10 schema (0007: ADR-044 personal definitions, ADR-046 background tasks)', () => {
  const CHAT_ID = '0199a8f0-0000-7000-8000-00000000a001'
  const OTHER_CHAT_ID = '0199a8f0-0000-7000-8000-00000000a002'

  function taskRow(id: string, chatId: string, createdAt: number): typeof backgroundTasks.$inferInsert {
    return {
      id,
      chatId,
      messageId: 'msg_aaaaaaaaaaaaaaaa',
      toolCallId: 'call_1',
      type: 'explore',
      description: 'Look around',
      status: 'running',
      origin: 'request',
      output: { status: 'running', type: 'explore', description: 'Look around', modelRef: 'mock:echo', steps: [], stepsOmitted: 0, report: '', startedAt: createdAt },
      createdAt,
    }
  }

  it('creates customizations as documented: raw content, denormalized columns, enabled default true, unique (kind, name)', async () => {
    const database = await freshDatabase()
    const info = await columns(database, 'customizations')
    expect(Object.keys(info).sort()).toEqual(['content', 'created_at', 'description', 'enabled', 'id', 'kind', 'name', 'updated_at'])
    for (const name of ['id', 'kind', 'name', 'description', 'content', 'enabled', 'created_at', 'updated_at'])
      expect(info[name]?.notnull, name).toBe(1)
    expect(info.id?.pk).toBe(1)
    expect(info.enabled?.dflt_value).toBe('true')
    expect(await foreignKeys(database, 'customizations')).toEqual([])
    expect(await indexColumns(database, 'customizations_kind_name_uq')).toEqual(['kind', 'name'])
    const list = await database.client.execute(`PRAGMA index_list(customizations)`)
    const flags = Object.fromEntries(list.rows.map(row => [String(row.name), Number(row.unique)]))
    expect(flags.customizations_kind_name_uq).toBe(1)
  })

  it('creates background_tasks as documented: the snapshot columns, a cascading chat foreign key, two indexes', async () => {
    const database = await freshDatabase()
    const info = await columns(database, 'background_tasks')
    expect(Object.keys(info).sort()).toEqual([
      'chat_id',
      'created_at',
      'delivered_at',
      'delivered_message_id',
      'description',
      'finished_at',
      'id',
      'message_id',
      'origin',
      'output',
      'status',
      'tool_call_id',
      'type',
    ])
    for (const name of ['chat_id', 'message_id', 'tool_call_id', 'type', 'description', 'status', 'origin', 'output', 'created_at'])
      expect(info[name]?.notnull, name).toBe(1)
    for (const name of ['finished_at', 'delivered_at', 'delivered_message_id'])
      expect(info[name]?.notnull, name).toBe(0)
    expect(await foreignKeys(database, 'background_tasks')).toEqual(['chat_id -> chats.id (CASCADE)'])
    expect(await indexColumns(database, 'background_tasks_chat_idx')).toEqual(['chat_id', 'created_at'])
    expect(await indexColumns(database, 'background_tasks_pending_idx')).toEqual(['delivered_at', 'status'])
  })

  it('stores personal definitions; a second (kind, name) is a unique violation, the same name of another kind is fine', async () => {
    const { db } = await freshDatabase()
    await db.insert(customizations).values({ id: 'cus_AAAAAAAAAAAAAAAA', kind: 'agent', name: 'reviewer', description: 'Reviews.', content: '---\nname: reviewer\n---\nBody' })
    const [row] = await db.select().from(customizations)
    expect(row).toMatchObject({ id: 'cus_AAAAAAAAAAAAAAAA', kind: 'agent', name: 'reviewer', enabled: true })
    expect(row?.createdAt).toBeGreaterThan(0)
    expect(row?.updatedAt).toBeGreaterThan(0)
    expect(await uniqueViolation(db.insert(customizations).values({ id: 'cus_BBBBBBBBBBBBBBBB', kind: 'agent', name: 'reviewer', description: 'Other.', content: 'x' })))
      .toBe('UNIQUE constraint failed: customizations.kind, customizations.name')
    await db.insert(customizations).values({ id: 'cus_CCCCCCCCCCCCCCCC', kind: 'skill', name: 'reviewer', description: 'A skill.', content: 'y', enabled: false })
    expect((await db.select({ id: customizations.id, enabled: customizations.enabled }).from(customizations).orderBy(customizations.id)))
      .toEqual([{ id: 'cus_AAAAAAAAAAAAAAAA', enabled: true }, { id: 'cus_CCCCCCCCCCCCCCCC', enabled: false }])
  })

  it('stores background tasks with their JSON snapshot; deleting a chat removes its tasks only; the chat must exist', async () => {
    const { db } = await freshDatabase()
    await db.insert(chats).values([{ id: CHAT_ID }, { id: OTHER_CHAT_ID }])
    await db.insert(backgroundTasks).values([taskRow('bgt_AAAAAAAAAAAAAAAA', CHAT_ID, 1), taskRow('bgt_BBBBBBBBBBBBBBBB', CHAT_ID, 2), taskRow('bgt_CCCCCCCCCCCCCCCC', OTHER_CHAT_ID, 3)])
    const [stored] = await db.select().from(backgroundTasks).where(eq(backgroundTasks.id, 'bgt_AAAAAAAAAAAAAAAA'))
    expect(stored).toMatchObject({ status: 'running', origin: 'request', finishedAt: null, deliveredAt: null, deliveredMessageId: null })
    expect(stored?.output).toMatchObject({ status: 'running', type: 'explore', report: '' })
    await expect(db.insert(backgroundTasks).values(taskRow('bgt_DDDDDDDDDDDDDDDD', 'missing', 4))).rejects.toThrow()
    await db.delete(chats).where(eq(chats.id, CHAT_ID))
    expect((await db.select({ id: backgroundTasks.id }).from(backgroundTasks)).map(row => row.id)).toEqual(['bgt_CCCCCCCCCCCCCCCC'])
  })
})

describe('phase 11 schema (0008: ADR-048 personal hooks, ADR-049 project trust, ADR-051 project output style)', () => {
  const PROJECT = 'prj_AAAAAAAAAAAAAAAA'
  const OTHER_PROJECT = 'prj_BBBBBBBBBBBBBBBB'
  const HASH_A = 'a'.repeat(64)
  const HASH_B = 'b'.repeat(64)

  it('creates hooks as documented: text id, nullable matcher and timeout, enabled default true, no index or foreign key', async () => {
    const database = await freshDatabase()
    const info = await columns(database, 'hooks')
    expect(Object.values(info).map(column => [column.name, column.type, column.notnull, column.pk])).toEqual([
      ['id', 'TEXT', 1, 1],
      ['event', 'TEXT', 1, 0],
      ['matcher', 'TEXT', 0, 0],
      ['command', 'TEXT', 1, 0],
      ['timeout', 'INTEGER', 0, 0],
      ['enabled', 'INTEGER', 1, 0],
      ['created_at', 'INTEGER', 1, 0],
      ['updated_at', 'INTEGER', 1, 0],
      // Phase 12 (0009, appended): the handler type and the prompt hook / handler fields.
      ['type', 'TEXT', 1, 0],
      ['prompt', 'TEXT', 0, 0],
      ['model', 'TEXT', 0, 0],
      ['options', 'TEXT', 0, 0],
    ])
    expect(info.enabled?.dflt_value).toBe('true')
    expect(info.matcher?.dflt_value).toBeNull()
    expect(info.timeout?.dflt_value).toBeNull()
    expect(await foreignKeys(database, 'hooks')).toEqual([])
    const list = await database.client.execute(`PRAGMA index_list(hooks)`)
    expect(list.rows.map(row => String(row.origin))).toEqual(['pk'])
  })

  it('creates project_trust as documented: primary key (project_id, sha256), cascading from projects, no other index', async () => {
    const database = await freshDatabase()
    const info = await columns(database, 'project_trust')
    expect(Object.values(info).map(column => [column.name, column.type, column.notnull, column.pk])).toEqual([
      ['project_id', 'TEXT', 1, 1],
      ['sha256', 'TEXT', 1, 2],
      ['kind', 'TEXT', 1, 0],
      ['label', 'TEXT', 1, 0],
      ['created_at', 'INTEGER', 1, 0],
    ])
    expect(await foreignKeys(database, 'project_trust')).toEqual(['project_id -> projects.id (CASCADE)'])
    const list = await database.client.execute(`PRAGMA index_list(project_trust)`)
    expect(list.rows.map(row => String(row.origin))).toEqual(['pk'])
  })

  it('stores personal hooks with their defaults', async () => {
    const { db } = await freshDatabase()
    await db.insert(hooks).values({ id: 'hok_AAAAAAAAAAAAAAAA', event: 'PreToolUse', matcher: 'Bash|Write', command: 'sh .claude/hooks/guard.sh', timeout: 30 })
    await db.insert(hooks).values({ id: 'hok_BBBBBBBBBBBBBBBB', event: 'Stop', command: 'sh check.sh', enabled: false })
    const rows = await db.select().from(hooks).orderBy(hooks.id)
    // Phase 12 (0009): a row written without the new columns is a command hook without prompt, model or options.
    const v18 = { type: 'command', prompt: null, model: null, options: null }
    expect(rows.map(({ createdAt, updatedAt, ...row }) => row)).toEqual([
      { id: 'hok_AAAAAAAAAAAAAAAA', event: 'PreToolUse', matcher: 'Bash|Write', command: 'sh .claude/hooks/guard.sh', timeout: 30, enabled: true, ...v18 },
      { id: 'hok_BBBBBBBBBBBBBBBB', event: 'Stop', matcher: null, command: 'sh check.sh', timeout: null, enabled: false, ...v18 },
    ])
    for (const row of rows) {
      expect(row.createdAt).toBeGreaterThan(0)
      expect(row.updatedAt).toBeGreaterThan(0)
    }
  })

  it('stores approvals; a second (project, sha256) is a primary-key violation; deleting a project cascades to its rows only', async () => {
    const { db } = await freshDatabase()
    await db.insert(projects).values([
      { id: PROJECT, name: 'Demo', path: '/srv/projects/demo' },
      { id: OTHER_PROJECT, name: 'Other', path: '/srv/projects/other', outputStyle: 'learning' },
    ])
    await db.insert(projectTrust).values([
      { projectId: PROJECT, sha256: HASH_A, kind: 'hook', label: 'sh .claude/hooks/guard.sh' },
      { projectId: PROJECT, sha256: HASH_B, kind: 'mcp', label: 'github' },
      // The same hash in another project is another approval.
      { projectId: OTHER_PROJECT, sha256: HASH_A, kind: 'hook', label: 'sh .claude/hooks/guard.sh' },
    ])
    expect(await primaryKeyViolation(db.insert(projectTrust).values({ projectId: PROJECT, sha256: HASH_A, kind: 'command', label: '/status' })))
      .toBe('UNIQUE constraint failed: project_trust.project_id, project_trust.sha256')
    // The project must exist (foreign keys are on).
    await expect(db.insert(projectTrust).values({ projectId: 'prj_CCCCCCCCCCCCCCCC', sha256: HASH_A, kind: 'hook', label: 'x' })).rejects.toThrow()
    expect((await db.select({ outputStyle: projects.outputStyle }).from(projects).orderBy(projects.id)).map(row => row.outputStyle)).toEqual([null, 'learning'])

    await db.delete(projects).where(eq(projects.id, PROJECT))
    expect(await db.select({ projectId: projectTrust.projectId, sha256: projectTrust.sha256 }).from(projectTrust)).toEqual([{ projectId: OTHER_PROJECT, sha256: HASH_A }])
  })
})

describe('phase 12 schema (0009: ADR-053 plugin format, ADR-054 marketplaces, ADR-057 hook handler fields)', () => {
  const NOW = 1_790_000_000_000

  it('creates marketplaces as documented: text id, unique name, JSON source and catalog, nullable fetch state, no foreign key', async () => {
    const database = await freshDatabase()
    const info = await columns(database, 'marketplaces')
    expect(Object.values(info).map(column => [column.name, column.type, column.notnull, column.pk])).toEqual([
      ['id', 'TEXT', 1, 1],
      ['name', 'TEXT', 1, 0],
      ['source', 'TEXT', 1, 0],
      ['resolved_ref', 'TEXT', 0, 0],
      ['catalog', 'TEXT', 0, 0],
      ['fetched_at', 'INTEGER', 0, 0],
      ['last_error', 'TEXT', 0, 0],
      ['created_at', 'INTEGER', 1, 0],
      ['updated_at', 'INTEGER', 1, 0],
    ])
    expect(await foreignKeys(database, 'marketplaces')).toEqual([])
    expect(await indexColumns(database, 'marketplaces_name_unique')).toEqual(['name'])
    const list = await database.client.execute(`PRAGMA index_list(marketplaces)`)
    expect(list.rows.map(row => [String(row.name), Number(row.unique)]).sort()).toEqual([['marketplaces_name_unique', 1], ['sqlite_autoindex_marketplaces_1', 1]])
  })

  it('adds plugins.format (text, not null, default harness) and plugins.origin (nullable text) at the end', async () => {
    const database = await freshDatabase()
    const info = await columns(database, 'plugins')
    expect(Object.keys(info).slice(-2)).toEqual(['format', 'origin'])
    expect(info.format).toEqual({ name: 'format', type: 'TEXT', notnull: 1, dflt_value: '\'harness\'', pk: 0 })
    expect(info.origin).toEqual({ name: 'origin', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 })
    const hookColumns = await columns(database, 'hooks')
    expect(hookColumns.type).toEqual({ name: 'type', type: 'TEXT', notnull: 1, dflt_value: '\'command\'', pk: 0 })
    for (const name of ['prompt', 'model', 'options'])
      expect(hookColumns[name], name).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null })
  })

  it('stores marketplaces with their JSON columns; a second marketplace of the same name is a unique violation', async () => {
    const { db } = await freshDatabase()
    const catalog = { version: 1, marketplace: { name: 'acme', owner: { name: 'Acme' }, plugins: [] }, diagnostics: [] }
    await db.insert(marketplaces).values({ id: 'mkt_AAAAAAAAAAAAAAAA', name: 'acme', source: { type: 'github', repo: 'acme/tools' }, resolvedRef: 'a'.repeat(40), catalog, fetchedAt: NOW })
    await db.insert(marketplaces).values({ id: 'mkt_BBBBBBBBBBBBBBBB', name: 'local', source: { type: 'path', path: '/srv/marketplace' }, lastError: { code: 'not_found', message: 'Gone.' } })
    const stored = await db.select().from(marketplaces).orderBy(marketplaces.id)
    expect(stored.map(({ createdAt, updatedAt, ...row }) => row)).toEqual([
      { id: 'mkt_AAAAAAAAAAAAAAAA', name: 'acme', source: { type: 'github', repo: 'acme/tools' }, resolvedRef: 'a'.repeat(40), catalog, fetchedAt: NOW, lastError: null },
      { id: 'mkt_BBBBBBBBBBBBBBBB', name: 'local', source: { type: 'path', path: '/srv/marketplace' }, resolvedRef: null, catalog: null, fetchedAt: null, lastError: { code: 'not_found', message: 'Gone.' } },
    ])
    for (const row of stored)
      expect(row.createdAt).toBeGreaterThan(0)
    expect(await uniqueViolation(db.insert(marketplaces).values({ id: 'mkt_CCCCCCCCCCCCCCCC', name: 'acme', source: { type: 'url', url: 'https://example.com/marketplace.json' } })))
      .toBe('UNIQUE constraint failed: marketplaces.name')
  })

  it('stores the plugin format and origin; a row without them is a harness plugin without an origin', async () => {
    const { db } = await freshDatabase()
    await db.insert(plugins).values({ id: 'legacy', source: 'zip', version: '1.0.0' })
    const origin = { kind: 'marketplace', marketplaceId: 'mkt_AAAAAAAAAAAAAAAA', marketplace: 'acme', plugin: 'review-kit', sourceKind: 'relative', commit: 'c'.repeat(40), version: '1.2.0', overlay: { name: 'review-kit', strict: true, overlay: {} } }
    await db.insert(plugins).values({ id: 'review-kit', source: 'marketplace', sourceRef: `acme/tools@${'c'.repeat(12)}`, version: '1.2.0', format: 'claude', origin })
    const stored = await db.select({ id: plugins.id, format: plugins.format, origin: plugins.origin }).from(plugins).orderBy(plugins.id)
    expect(stored).toEqual([
      { id: 'legacy', format: 'harness', origin: null },
      { id: 'review-kit', format: 'claude', origin },
    ])
  })

  it('stores a prompt hook (command empty, type prompt, prompt, model, options JSON) next to a command hook', async () => {
    const { db } = await freshDatabase()
    await db.insert(hooks).values({ id: 'hok_CCCCCCCCCCCCCCCC', event: 'Stop', command: '', type: 'prompt', prompt: 'Did the tests run? $ARGUMENTS', model: 'mock:prompt-hook', options: { continueOnBlock: true, statusMessage: 'Checking…' } })
    await db.insert(hooks).values({ id: 'hok_DDDDDDDDDDDDDDDD', event: 'PreToolUse', matcher: 'Bash', command: 'node', options: { args: ['guard.mjs', '--strict'], if: 'Bash(git push:*)' } })
    const stored = await db.select({ id: hooks.id, type: hooks.type, command: hooks.command, prompt: hooks.prompt, model: hooks.model, options: hooks.options }).from(hooks).orderBy(hooks.id)
    expect(stored).toEqual([
      { id: 'hok_CCCCCCCCCCCCCCCC', type: 'prompt', command: '', prompt: 'Did the tests run? $ARGUMENTS', model: 'mock:prompt-hook', options: { continueOnBlock: true, statusMessage: 'Checking…' } },
      { id: 'hok_DDDDDDDDDDDDDDDD', type: 'command', command: 'node', prompt: null, model: null, options: { args: ['guard.mjs', '--strict'], if: 'Bash(git push:*)' } },
    ])
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
