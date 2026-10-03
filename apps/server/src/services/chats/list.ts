// The list query of `GET /chats` (API.md 5.9): the condition of one page or search batch and the plain page query, in
// the order `updated_at` desc, `id` desc with the keyset cursor of ./cursor.ts.
//
// - `archived` is always part of the condition (default false).
// - Phase 7 (ADR-031): `projectId` = a project id lists only its chats, `'none'` only chats without a project, omitted
//   every chat. An unknown (or malformed) project id simply matches nothing. With a project filter SQLite walks the
//   index `chats_project_idx` (`project_id`, `archived`, `updated_at` desc, `id` desc), without one `chats_list_idx`
//   (`archived`, `updated_at` desc, `id` desc); both serve the order without a sort.
import type { SQL } from 'drizzle-orm'
import type { DbExecutor } from '../../db/client.ts'
import type { ChatCursor } from './cursor.ts'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { chats } from '../../db/schema.ts'

/** What a list page or a search batch selects (the cursor and the search text aside). */
export interface ChatListFilter {
  archived: boolean
  /** A project id (only its chats), `'none'` (only chats without a project) or undefined (every chat). */
  projectId?: string
}

/**
 * Keyset condition "after `cursor`" for the order `updated_at` desc, `id` desc: the row value `(updated_at, id) <
 * (cursor.updatedAt, cursor.id)`, which SQLite uses as one range of the list indexes (the equivalent `updated_at < ? OR
 * (updated_at = ? AND id < ?)` becomes a multi-index OR followed by a sort of every older chat).
 */
export function afterCursor(cursor: ChatCursor | null): SQL | undefined {
  if (cursor === null)
    return undefined
  return sql`(${chats.updatedAt}, ${chats.id}) < (${cursor.updatedAt}, ${cursor.id})`
}

/** The project condition of `ChatListQuery.projectId` (undefined = every chat). */
export function projectCondition(projectId: string | undefined): SQL | undefined {
  if (projectId === undefined)
    return undefined
  return projectId === 'none' ? isNull(chats.projectId) : eq(chats.projectId, projectId)
}

/** The WHERE of one list page or search batch: project, archived flag, then the keyset cursor. */
export function chatListWhere(filter: ChatListFilter, after: ChatCursor | null): SQL | undefined {
  return and(projectCondition(filter.projectId), eq(chats.archived, filter.archived), afterCursor(after))
}

/** One page of the plain list (no search): at most `rows` chat rows after `after`. */
export function chatPageQuery(db: DbExecutor, filter: ChatListFilter, after: ChatCursor | null, rows: number) {
  return db
    .select()
    .from(chats)
    .where(chatListWhere(filter, after))
    .orderBy(desc(chats.updatedAt), desc(chats.id))
    .limit(rows)
}
