// Referenced file ids of the orphaned file cleanup (ADR-035, ARCHITECTURE.md 6.15). Owner: W7.8 (W7.8-T1).
//
// A loose scan: every column that may hold a file id is read in keyset batches of `REFERENCE_BATCH` rows (by `rowid`),
// pre-filtered in SQL with `instr(column, 'file_') > 0`, and every `file_` followed by 16 letters or digits is taken as
// a reference (the regex `/file_[\dA-Za-z]{16}/g`, matched with a lookahead so overlapping candidates are all found).
// It may keep an extra file (a mention in a text, a longer token), never miss one. The scan holds no lock: a reference
// written after its batch was read is covered by the pins, the grace period and the sweep's DELETE re-check.
//
// `REFERENCE_SOURCES` lists the scanned columns and `UNSCANNED_COLUMNS` every other text / JSON / blob column with the
// reason it cannot hold a file id; `references.test.ts` fails when a column of the schema is in neither list.
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core'
import type { Db } from '../../db/client.ts'
import { Buffer } from 'node:buffer'
import { sql } from 'drizzle-orm'
import { getTableConfig } from 'drizzle-orm/sqlite-core'
import { chats, chatShares, customizations, messages, pluginKv, pluginSettings, projects, settings } from '../../db/schema.ts'
import { guardDb } from '../chats/db-errors.ts'

/** Rows per keyset batch. */
export const REFERENCE_BATCH = 500

/** `file_` + 16 letters or digits (a lookahead, so an id inside a longer match is still found). */
const FILE_ID_IN_TEXT = /file_(?=([\dA-Za-z]{16}))/g

export interface ReferenceSource {
  table: SQLiteTable
  /** Text / JSON columns of `table` that may hold file ids. */
  columns: readonly SQLiteColumn[]
}

/** Every column scanned for file ids (DECISIONS.md ADR-035, ARCHITECTURE.md 6.15). */
export const REFERENCE_SOURCES: readonly ReferenceSource[] = [
  // UI parts (file parts, generated images in tool outputs) and message metadata.
  { table: messages, columns: [messages.parts, messages.metadata] },
  // A share keeps its snapshot after the message version it shows is deleted.
  { table: chatShares, columns: [chatShares.snapshot, chatShares.fileIds] },
  // `ctx.storage` of plugins (a file id may be a key, too) and their settings.
  { table: pluginKv, columns: [pluginKv.key, pluginKv.value] },
  { table: pluginSettings, columns: [pluginSettings.values] },
  { table: settings, columns: [settings.value] },
  { table: chats, columns: [chats.settings] },
  { table: projects, columns: [projects.name, projects.path, projects.instructions] },
  // Phase 10 (ADR-044): personal agents, commands and skills are free text like `projects.instructions`.
  { table: customizations, columns: [customizations.content, customizations.description] },
]

/** Why the columns of `workspace_changes` and `shell_rules` (Phase 8) are not scanned. */
const CHECKPOINT_JOURNAL_REASON = 'checkpoint journal / shell rules: ids, paths, commands, hashes; never a data/files id'

/**
 * Why the columns of `background_tasks` (Phase 10, ADR-046) are not scanned: ids, enums and the sub-agent's snapshot; a
 * delivered result lives on in a `data-task-result` part of `messages.parts` (scanned), and the rows go with their chat.
 */
const BACKGROUND_TASK_REASON = 'background tasks: ids, enums and the sub-agent snapshot (its delivered result is in messages.parts)'

/**
 * `table.column` -> why it is not scanned: every text, JSON or blob column outside `REFERENCE_SOURCES`. A new column
 * must be added to one of the two lists (the schema-coverage test).
 */
export const UNSCANNED_COLUMNS: Readonly<Record<string, string>> = {
  'settings.key': 'setting names',
  'secrets.scope': 'secret scopes',
  'secrets.name': 'secret names',
  'secrets.ciphertext': 'encrypted credentials (never a file id)',
  'secrets.hint': 'masked hints of credentials',
  'provider_configs.provider_id': 'provider ids',
  'provider_configs.options': 'provider credentials that are not secret (base URLs)',
  'provider_configs.status': 'a status enum',
  'provider_configs.last_error': 'provider check errors',
  'model_cache.provider_id': 'provider ids',
  'model_cache.models': 'live model listings',
  'model_cache.error': 'listing errors',
  'model_prefs.provider_id': 'provider ids',
  'model_prefs.model_id': 'model ids',
  'model_prefs.alias': 'display names of models',
  'model_prefs.info': 'metadata of custom models',
  'chats.id': 'chat ids',
  'chats.title': 'chat titles',
  'chats.title_source': 'a title source enum',
  'chats.model_ref': 'model refs',
  'chats.active_leaf_id': 'message ids',
  'chats.project_id': 'project ids',
  'messages.id': 'message ids',
  'messages.chat_id': 'chat ids',
  'messages.parent_id': 'message ids',
  'messages.selected_child_id': 'message ids',
  'messages.role': 'a role enum',
  'messages.search_text': 'a copy of the text parts (`parts` is scanned)',
  'usage.chat_id': 'chat ids',
  'usage.message_id': 'message ids',
  'usage.purpose': 'a purpose enum',
  'usage.provider_id': 'provider ids',
  'usage.model_id': 'model ids',
  'plugins.id': 'plugin ids',
  'plugins.source': 'a source enum',
  'plugins.source_ref': 'install sources (npm specs, URLs, paths)',
  'plugins.version': 'versions',
  'plugins.trusted_hash': 'trust hashes',
  'plugins.last_error': 'plugin load errors',
  'plugin_settings.plugin_id': 'plugin ids',
  'plugin_kv.plugin_id': 'plugin ids',
  'tool_prefs.tool_name': 'tool names',
  'tool_prefs.override': 'a policy enum',
  'mcp_servers.id': 'server ids',
  'mcp_servers.name': 'server names',
  'mcp_servers.transport': 'transport settings (URLs, commands, header and env names)',
  'mcp_servers.policy': 'a policy enum',
  'files.id': 'the file rows themselves (the candidates)',
  'files.sha256': 'content hashes',
  'files.name': 'file names',
  'files.mime': 'media types',
  'chat_shares.id': 'share ids',
  'chat_shares.chat_id': 'chat ids',
  'chat_shares.title': 'share titles',
  'chat_shares.options': 'share options (booleans)',
  'projects.id': 'project ids',
  // Phase 8 (ADR-036 / ADR-038): the checkpoint journal and the shell rules hold ids, project paths, shell commands and
  // hashes, never a file id of `files/` (checkpoint blobs live in their own tree, `<dataDir>/checkpoints`).
  'workspace_changes.chat_id': CHECKPOINT_JOURNAL_REASON,
  'workspace_changes.project_id': CHECKPOINT_JOURNAL_REASON,
  'workspace_changes.message_id': CHECKPOINT_JOURNAL_REASON,
  'workspace_changes.tool_call_id': CHECKPOINT_JOURNAL_REASON,
  'workspace_changes.batch_id': CHECKPOINT_JOURNAL_REASON,
  'workspace_changes.kind': CHECKPOINT_JOURNAL_REASON,
  'workspace_changes.tool': CHECKPOINT_JOURNAL_REASON,
  'workspace_changes.path': CHECKPOINT_JOURNAL_REASON,
  'workspace_changes.command': CHECKPOINT_JOURNAL_REASON,
  'workspace_changes.before_state': CHECKPOINT_JOURNAL_REASON,
  'workspace_changes.before_sha': CHECKPOINT_JOURNAL_REASON,
  'workspace_changes.after_sha': CHECKPOINT_JOURNAL_REASON,
  'shell_rules.id': CHECKPOINT_JOURNAL_REASON,
  'shell_rules.project_id': CHECKPOINT_JOURNAL_REASON,
  'shell_rules.prefix': CHECKPOINT_JOURNAL_REASON,
  // Phase 10 (ADR-044 / ADR-046): `customizations.content` and `.description` are scanned (`REFERENCE_SOURCES`).
  'customizations.id': 'customization ids',
  'customizations.kind': 'a kind enum',
  'customizations.name': 'definition names (`AGENT_NAME_PATTERN` / `COMMAND_NAME_PATTERN`)',
  'background_tasks.id': BACKGROUND_TASK_REASON,
  'background_tasks.chat_id': BACKGROUND_TASK_REASON,
  'background_tasks.message_id': BACKGROUND_TASK_REASON,
  'background_tasks.tool_call_id': BACKGROUND_TASK_REASON,
  'background_tasks.type': BACKGROUND_TASK_REASON,
  'background_tasks.description': BACKGROUND_TASK_REASON,
  'background_tasks.status': BACKGROUND_TASK_REASON,
  'background_tasks.origin': BACKGROUND_TASK_REASON,
  'background_tasks.output': BACKGROUND_TASK_REASON,
  'background_tasks.delivered_message_id': BACKGROUND_TASK_REASON,
}

/** `table.column` names of the scanned columns. */
export function scannedColumnNames(): string[] {
  return REFERENCE_SOURCES.flatMap(source => source.columns.map(column => `${getTableConfig(source.table).name}.${column.name}`))
}

/** Adds every file id found in `value` (text; a blob is read as UTF-8) to `ids`. */
export function collectFileIds(value: unknown, ids: Set<string>): void {
  let text: string
  if (typeof value === 'string')
    text = value
  else if (value instanceof ArrayBuffer)
    text = Buffer.from(value).toString('utf8')
  else if (ArrayBuffer.isView(value))
    text = Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf8')
  else
    return
  if (!text.includes('file_'))
    return
  for (const match of text.matchAll(FILE_ID_IN_TEXT))
    ids.add(`file_${match[1]}`)
}

/** Scans one source in keyset batches by `rowid` (the signal is checked before each batch). */
async function scanSource(db: Db, source: ReferenceSource, ids: Set<string>, batch: number, signal: AbortSignal | undefined): Promise<void> {
  const tableName = getTableConfig(source.table).name
  const columns = source.columns.map(column => sql.identifier(column.name))
  const selected = sql.join(columns.map((column, index) => sql`${column} AS ${sql.identifier(`c${index}`)}`), sql`, `)
  const filter = sql.join(columns.map(column => sql`instr(${column}, 'file_') > 0`), sql` OR `)
  let cursor = Number.MIN_SAFE_INTEGER
  for (;;) {
    signal?.throwIfAborted()
    const after = cursor
    const rows = await guardDb(() => db.all<Record<string, unknown>>(sql`
      SELECT rowid AS k, ${selected} FROM ${sql.identifier(tableName)}
      WHERE rowid > ${after} AND (${filter})
      ORDER BY rowid LIMIT ${batch}
    `))
    for (const row of rows) {
      for (let index = 0; index < columns.length; index++)
        collectFileIds(row[`c${index}`], ids)
    }
    if (rows.length < batch)
      return
    cursor = Number(rows[rows.length - 1]!.k)
  }
}

export interface ReferenceScanOptions {
  /** Rows per batch (default `REFERENCE_BATCH`; tests). */
  batch?: number
  /** Phase 8: stops the scan between batches (the automatic sweep is aborted by `data.stop()`). */
  signal?: AbortSignal
}

/** Every file id referenced by a scanned column (a loose superset of the ids in use). */
export async function collectReferencedFileIds(db: Db, options: ReferenceScanOptions = {}): Promise<Set<string>> {
  const batch = options.batch ?? REFERENCE_BATCH
  const ids = new Set<string>()
  for (const source of REFERENCE_SOURCES)
    await scanSource(db, source, ids, batch, options.signal)
  return ids
}
