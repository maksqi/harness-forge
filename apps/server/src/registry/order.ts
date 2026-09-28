// "Registry order" (registry/types.ts): builtins first in load order (`BUILTIN_PLUGIN_IDS`), then user plugins by id
// (ASCII), then registration order within a plugin. Plugin load order is the same comparison.
import { BUILTIN_PLUGIN_IDS } from '@harness-forge/shared'

const BUILTIN_RANK: ReadonlyMap<string, number> = new Map(BUILTIN_PLUGIN_IDS.map((id, index) => [id, index]))

/** True for the id of a builtin plugin (`core-providers`, `core-tools`, `core-commands`, `core-mcp`, `mock`). */
export function isBuiltinPluginId(id: string): boolean {
  return BUILTIN_RANK.has(id)
}

/** Plugin load order: builtins in `BUILTIN_PLUGIN_IDS` order, then every other id in ASCII order. */
export function comparePluginIds(a: string, b: string): number {
  if (a === b)
    return 0
  const rankA = BUILTIN_RANK.get(a)
  const rankB = BUILTIN_RANK.get(b)
  if (rankA !== undefined && rankB !== undefined)
    return rankA - rankB
  if (rankA !== undefined)
    return -1
  if (rankB !== undefined)
    return 1
  return a < b ? -1 : 1
}

/** Something registered by a plugin, with a registry-wide sequence number. */
export interface Ordered {
  readonly pluginId: string
  readonly seq: number
}

/** Registry order: plugin load order, then registration order. */
export function compareRegistrations(a: Ordered, b: Ordered): number {
  return comparePluginIds(a.pluginId, b.pluginId) || a.seq - b.seq
}
