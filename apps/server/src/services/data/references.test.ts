// Referenced file ids of the orphaned file cleanup (W7.8-T1, ADR-035): every reference source, the loose matcher,
// keyset batches and the schema-coverage test (a text / JSON / blob column that is neither scanned nor excluded fails).
import type { HarnessUIMessage, MessageMetadata } from '@harness-forge/shared'
import type { TestApp } from '../../testing/create-test-app.ts'
import { createFileId } from '@harness-forge/shared'
import { eq, is, sql } from 'drizzle-orm'
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core'
import { afterEach, describe, expect, it } from 'vitest'
import * as schema from '../../db/schema.ts'
import { chats, chatShares, messages, pluginKv, pluginSettings, projects, settings } from '../../db/schema.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { fileUrl } from '../files/index.ts'
import { collectFileIds, collectReferencedFileIds, REFERENCE_BATCH, scannedColumnNames, UNSCANNED_COLUMNS } from './references.ts'

const apps: TestApp[] = []

afterEach(async () => {
  for (const app of apps.splice(0))
    await app.close()
})

async function app(): Promise<TestApp> {
  const t = await createTestApp({ start: false })
  apps.push(t)
  return t
}

const CHAT_ID = '0199a8f0-0000-7000-8000-000000000001'

function mid(n: number): string {
  return `msg_${n.toString().padStart(16, '0')}`
}

async function chat(t: TestApp, values: Partial<typeof chats.$inferInsert> = {}): Promise<void> {
  await t.db.insert(chats).values({ id: CHAT_ID, settings: {}, ...values }).onConflictDoNothing()
}

async function message(t: TestApp, n: number, parts: unknown[], metadata?: unknown): Promise<void> {
  await chat(t)
  await t.db.insert(messages).values({
    id: mid(n),
    chatId: CHAT_ID,
    seq: n,
    role: 'assistant',
    parts: parts as HarnessUIMessage['parts'],
    ...(metadata === undefined ? {} : { metadata: metadata as MessageMetadata }),
  })
}

function filePart(id: string): unknown {
  return { type: 'file', mediaType: 'image/png', url: fileUrl(id) }
}

describe('referenced file ids: every source', () => {
  it.each<[string, (t: TestApp, id: string) => Promise<void>]>([
    ['a file part of a message', (t, id) => message(t, 1, [{ type: 'text', text: 'see' }, filePart(id)])],
    ['a generate_image tool output only', (t, id) => message(t, 1, [{
      type: 'tool-generate_image',
      toolCallId: 'call_1',
      state: 'output-available',
      input: { prompt: 'a fox' },
      output: { modelRef: 'mock:image', images: [{ fileId: id, url: fileUrl(id), mediaType: 'image/png', name: 'image-1.png' }] },
    }])],
    ['message metadata only', (t, id) => message(t, 1, [{ type: 'text', text: 'no file here' }], { modelRef: 'mock:echo', extra: { cover: id } })],
    ['a share snapshot after the message version was deleted', async (t, id) => {
      await message(t, 1, [filePart(id)])
      await t.db.insert(chatShares).values({
        id: 'shr_0000000000000001',
        chatId: CHAT_ID,
        options: { reasoning: false, toolDetails: false, attachments: true },
        snapshot: { title: null, messages: [{ id: mid(1), role: 'assistant', parts: [{ type: 'file', mediaType: 'image/png', url: fileUrl(id) }] }] } as never,
        snapshotAt: 1,
      })
      await t.db.delete(messages).where(eq(messages.id, mid(1)))
    }],
    ['the file ids of a share only', async (t, id) => {
      await chat(t)
      await t.db.insert(chatShares).values({
        id: 'shr_0000000000000001',
        chatId: CHAT_ID,
        options: { reasoning: false, toolDetails: false, attachments: true },
        snapshot: { title: null, messages: [] },
        fileIds: [id],
        snapshotAt: 1,
      })
    }],
    ['a plugin_kv value only', (t, id) => t.db.insert(pluginKv).values({ pluginId: 'gallery', key: 'last', value: { images: [id] } }).then(() => {})],
    ['a plugin_kv key only', (t, id) => t.db.insert(pluginKv).values({ pluginId: 'gallery', key: `thumb:${id}`, value: true }).then(() => {})],
    ['plugin settings values', (t, id) => t.db.insert(pluginSettings).values({ pluginId: 'gallery', values: { logo: fileUrl(id) } }).then(() => {})],
    ['a setting value', (t, id) => t.db.insert(settings).values({ key: '_gallery.cover', value: id }).then(() => {})],
    ['chat settings', (t, id) => chat(t, { settings: { instructions: `Describe ${fileUrl(id)} first.` } })],
    ['project instructions', (t, id) => t.db.insert(projects).values({ id: 'prj_0000000000000001', name: 'Demo', path: '/srv/demo', instructions: `The logo is ${id}.` }).then(() => {})],
    ['a project name', (t, id) => t.db.insert(projects).values({ id: 'prj_0000000000000001', name: `Assets ${id}`, path: '/srv/demo' }).then(() => {})],
  ])('finds an id in %s', async (_label, seed) => {
    const t = await app()
    const id = createFileId()
    await seed(t, id)
    expect([...await collectReferencedFileIds(t.db)]).toEqual([id])
  })

  it('finds nothing in an empty database, and nothing in unscanned columns', async () => {
    const t = await app()
    expect((await collectReferencedFileIds(t.db)).size).toBe(0)
    const id = createFileId()
    await chat(t, { title: `Title ${id}` })
    await message(t, 1, [{ type: 'text', text: 'plain' }])
    await t.db.update(messages).set({ searchText: id }).where(eq(messages.id, mid(1)))
    expect((await collectReferencedFileIds(t.db)).size).toBe(0)
  })
})

describe('referenced file ids: the loose matcher', () => {
  function found(value: unknown): string[] {
    const ids = new Set<string>()
    collectFileIds(value, ids)
    return [...ids]
  }

  it('takes file_ + 16 letters or digits anywhere, including inside longer tokens and overlapping candidates', () => {
    expect(found('x file_ABCDEFGHIJKLMNOP y')).toEqual(['file_ABCDEFGHIJKLMNOP'])
    expect(found('{"url":"/api/files/file_0123456789abcdef"}')).toEqual(['file_0123456789abcdef'])
    // Loose: a longer token keeps its first 16 characters (an extra file may be kept, never one missed).
    expect(found('file_ABCDEFGHIJKLMNOPQRS')).toEqual(['file_ABCDEFGHIJKLMNOP'])
    expect(found('myfile_ABCDEFGHIJKLMNOP')).toEqual(['file_ABCDEFGHIJKLMNOP'])
    // An id that starts inside an earlier match is still found.
    expect(found('file_aaaaaaaaaaaafile_bbbbbbbbbbbbbbbb')).toEqual(['file_aaaaaaaaaaaafile', 'file_bbbbbbbbbbbbbbbb'])
    expect(found('file_short file_ABCDEFGHIJKLMN-OP file_')).toEqual([])
  })

  it('reads blobs as UTF-8 and ignores other values', () => {
    expect(found(new TextEncoder().encode('id file_ABCDEFGHIJKLMNOP'))).toEqual(['file_ABCDEFGHIJKLMNOP'])
    expect(found(new TextEncoder().encode('file_ABCDEFGHIJKLMNOP').buffer)).toEqual(['file_ABCDEFGHIJKLMNOP'])
    for (const value of [null, undefined, 42, { id: 'file_ABCDEFGHIJKLMNOP' }])
      expect(found(value)).toEqual([])
  })
})

describe('referenced file ids: keyset batches', () => {
  it('reads every matching row in batches, whatever the batch size', async () => {
    const t = await app()
    await chat(t)
    const ids = Array.from({ length: REFERENCE_BATCH * 2 + 3 }, () => createFileId())
    const rows = ids.flatMap((id, index) => [
      { id: mid(index * 2 + 1), chatId: CHAT_ID, seq: index * 2 + 1, role: 'user' as const, parts: [filePart(id)] as HarnessUIMessage['parts'] },
      { id: mid(index * 2 + 2), chatId: CHAT_ID, seq: index * 2 + 2, role: 'assistant' as const, parts: [{ type: 'text', text: 'no reference' }] as HarnessUIMessage['parts'] },
    ])
    for (let index = 0; index < rows.length; index += 200)
      await t.db.insert(messages).values(rows.slice(index, index + 200))
    expect([...await collectReferencedFileIds(t.db)].sort()).toEqual([...ids].sort())
    expect([...await collectReferencedFileIds(t.db, { batch: 7 })].sort()).toEqual([...ids].sort())
    expect((await collectReferencedFileIds(t.db, { batch: 1 })).size).toBe(ids.length)
  })
})

describe('referenced file ids: schema coverage', () => {
  const NUMERIC_TYPES = new Set(['integer', 'int', 'real', 'numeric'])
  const scanned = scannedColumnNames()
  const covered = new Set([...scanned, ...Object.keys(UNSCANNED_COLUMNS)])

  /** The text, JSON and blob columns of the Drizzle schema (`table.column`). */
  function schemaColumns(): string[] {
    return (Object.values(schema) as unknown[])
      .filter((value): value is SQLiteTable => is(value, SQLiteTable))
      .flatMap((table) => {
        const config = getTableConfig(table)
        return config.columns.filter(column => !NUMERIC_TYPES.has(column.getSQLType().toLowerCase())).map(column => `${config.name}.${column.name}`)
      })
  }

  /** The same from the migrated database (`PRAGMA table_xinfo`). */
  async function databaseColumns(t: TestApp): Promise<string[]> {
    const tables = await t.db.all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_\\_drizzle%' ESCAPE '\\'`)
    const columns: string[] = []
    for (const { name } of tables) {
      const info = await t.db.all<{ name: string, type: string }>(sql.raw(`PRAGMA table_xinfo("${name.replaceAll('"', '""')}")`))
      for (const column of info) {
        if (!NUMERIC_TYPES.has(column.type.toLowerCase()))
          columns.push(`${name}.${column.name}`)
      }
    }
    return columns
  }

  function uncovered(columns: readonly string[]): string[] {
    return columns.filter(column => !covered.has(column))
  }

  it('scans exactly the reference columns of ADR-035', () => {
    expect(scanned.sort()).toEqual([
      'chat_shares.file_ids',
      'chat_shares.snapshot',
      'chats.settings',
      'messages.metadata',
      'messages.parts',
      'plugin_kv.key',
      'plugin_kv.value',
      'plugin_settings.values',
      'projects.instructions',
      'projects.name',
      'projects.path',
      'settings.value',
    ])
    expect(scanned.filter(column => Object.hasOwn(UNSCANNED_COLUMNS, column))).toEqual([])
  })

  it('every text, JSON or blob column of the schema is scanned or explicitly excluded', async () => {
    const t = await app()
    const fromSchema = schemaColumns()
    const fromDatabase = await databaseColumns(t)
    // A new column must be added to REFERENCE_SOURCES or UNSCANNED_COLUMNS (services/data/references.ts).
    expect(uncovered(fromSchema)).toEqual([])
    expect(uncovered(fromDatabase)).toEqual([])
    // Both lists name real columns only (no stale entries), and the database matches the schema.
    expect([...covered].filter(column => !fromSchema.includes(column))).toEqual([])
    expect(fromDatabase.sort()).toEqual(fromSchema.sort())
    expect(new Set(fromSchema.map(column => column.split('.')[0]))).toEqual(new Set(schema.TABLE_NAMES))
  })

  it('reports a column that is in neither list', () => {
    expect(uncovered(['messages.parts', 'messages.attachments', 'files.thumbnail'])).toEqual(['messages.attachments', 'files.thumbnail'])
  })
})
