// The message tree of one chat (ADR-023, ARCHITECTURE.md 6.8): pure functions over its light rows
// `(id, parent_id, seq, role)`. `parent_id` is the previous message of a path (`null` for a first message); siblings
// (the same parent; the first messages of a chat are siblings of each other) are the versions of a message; `seq` is
// the creation order, so a parent always has a lower `seq` than its children; the active leaf (`chats.active_leaf_id`)
// is the last message of the path the user sees.
//
// Bad data never loops: a parent counts only when it is a message of the same chat with a lower `seq` (the guard of
// the recursive `listPath` query); any other parent (missing, in another chat, part of a cycle) makes the message a
// first message. Every walk up the tree therefore sees strictly decreasing `seq` values and every walk down strictly
// increasing ones.
import type { MessageBranch } from '@harness-forge/shared'
import type { MessageRole } from '../../db/schema.ts'

/** One message of a chat without its content. */
export interface TreeRow {
  id: string
  /** The stored `parent_id` (checked by `buildTree`). */
  parentId: string | null
  seq: number
  role: MessageRole
}

/** An index over the rows of one chat (`buildTree`). */
export interface MessageTree {
  /** Every row, in `seq` order. */
  readonly rows: readonly TreeRow[]
  readonly byId: ReadonlyMap<string, TreeRow>
  /** The effective parent of every message (see the module comment); `null` = a first message. */
  readonly parentOf: ReadonlyMap<string, string | null>
  /** The children of every message by effective parent (`null` = the first messages), in `seq` order. */
  readonly childrenOf: ReadonlyMap<string | null, readonly string[]>
}

/** Indexes the rows of one chat (any order). */
export function buildTree(rows: readonly TreeRow[]): MessageTree {
  const sorted = [...rows].sort((a, b) => a.seq - b.seq)
  const byId = new Map<string, TreeRow>()
  for (const row of sorted)
    byId.set(row.id, row)
  const parentOf = new Map<string, string | null>()
  const childrenOf = new Map<string | null, string[]>()
  for (const row of sorted) {
    const parent = row.parentId === null ? undefined : byId.get(row.parentId)
    const effective = parent !== undefined && parent.seq < row.seq ? parent.id : null
    parentOf.set(row.id, effective)
    const siblings = childrenOf.get(effective)
    if (siblings === undefined)
      childrenOf.set(effective, [row.id])
    else
      siblings.push(row.id)
  }
  return { rows: sorted, byId, parentOf, childrenOf }
}

/** The ids of the path that ends at `leafId`, first message first; `[]` for `null` or an id outside the chat. */
export function pathTo(tree: MessageTree, leafId: string | null): string[] {
  const path: string[] = []
  let current = leafId !== null && tree.byId.has(leafId) ? leafId : null
  while (current !== null) {
    path.push(current)
    current = tree.parentOf.get(current) ?? null
  }
  return path.reverse()
}

/** The versions of a message: every message with its parent (itself included), in `seq` order; `[]` when unknown. */
export function siblingsOf(tree: MessageTree, messageId: string): readonly string[] {
  if (!tree.byId.has(messageId))
    return []
  return tree.childrenOf.get(tree.parentOf.get(messageId) ?? null) ?? []
}

/**
 * `ChatDetail.branches` of a path: every path message with at least two versions, keyed by its id, with its siblings
 * (`seq` order) and its index among them. Ids outside the chat are skipped.
 */
export function branchesOf(tree: MessageTree, path: readonly string[]): Record<string, MessageBranch> {
  const branches: Record<string, MessageBranch> = {}
  for (const id of path) {
    const siblings = siblingsOf(tree, id)
    if (siblings.length >= 2)
      branches[id] = { siblings: [...siblings], index: siblings.indexOf(id) }
  }
  return branches
}

/**
 * The most recent leaf under `messageId`: the message with the highest `seq` in its subtree (itself when it has no
 * children; the highest `seq` of a subtree is always a leaf). Null when `messageId` is not a message of the chat.
 */
export function latestLeafUnder(tree: MessageTree, messageId: string): string | null {
  const start = tree.byId.get(messageId)
  if (start === undefined)
    return null
  // One pass in `seq` order: a child always comes after its parent, so the subtree is complete when a row is reached.
  const subtree = new Set([start.id])
  let latest = start.id
  for (const row of tree.rows) {
    if (row.seq <= start.seq)
      continue
    const parent = tree.parentOf.get(row.id) ?? null
    if (parent !== null && subtree.has(parent)) {
      subtree.add(row.id)
      latest = row.id
    }
  }
  return latest
}

/**
 * The last message of the active path: the stored `chats.active_leaf_id` when it is a message of the chat (during a
 * run it may have children: the path ends at the message committed when the run started), else the most recent
 * message of the chat (the highest `seq`), null for an empty chat.
 */
export function resolveLeaf(tree: MessageTree, storedLeafId: string | null): string | null {
  if (storedLeafId !== null && tree.byId.has(storedLeafId))
    return storedLeafId
  return tree.rows.at(-1)?.id ?? null
}
