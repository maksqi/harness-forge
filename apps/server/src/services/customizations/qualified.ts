// Qualified catalog names and the bare alias (Phase 12, ADR-053; open point 8). Owner: W12.7.
//
// The entries of Claude Code plugins have qualified names `<pluginId>:<seg>…:<name>` (`QUALIFIED_NAME_PATTERN`); harness
// plugins, personal rows, project files and the builtins keep bare names. A lookup by name, in this order:
//   1. the exact name;
//   2. a bare name (no `:`) resolves to a qualified entry only when exactly ONE distinct active name ends in `:<bare>`
//      and nothing has the exact name (Claude Code's "the prefix is optional unless there is a collision");
//   3. a qualified name `<pluginId>:<name>` with one segment resolves to the bare entry `<name>` of that plugin (a
//      harness plugin's entries are callable with their plugin id).
// Pure helpers over plain `{ name, source?, pluginId? }` records, shared by the snapshot getters (`snapshot.ts`) and the
// slash command resolution (`chat/commands.ts`, which applies them across commands and user-invocable skills). Names are
// compared as given (the callers lowercase what a model or a user typed).
import { AGENT_NAME_PATTERN, splitQualifiedName } from '@harness-forge/shared'

/** What a name lookup needs of an entry (`CustomizationEntry`, a registered command, …). */
export interface NamedEntry {
  readonly name: string
  readonly source?: string
  readonly pluginId?: string
}

/** True when `name` is qualified (`<pluginId>:<name>`). */
export function isQualifiedName(name: string): boolean {
  return splitQualifiedName(name) !== null
}

/** The distinct qualified names of `entries` whose last segment is `bare`, in first-seen order. */
export function bareAliasNames(entries: Iterable<NamedEntry>, bare: string): string[] {
  const names: string[] = []
  if (typeof bare !== 'string' || !AGENT_NAME_PATTERN.test(bare))
    return names
  const suffix = `:${bare}`
  for (const entry of entries) {
    if (typeof entry.name === 'string' && entry.name.endsWith(suffix) && !names.includes(entry.name) && isQualifiedName(entry.name))
      names.push(entry.name)
  }
  return names
}

/**
 * The name `wanted` stands for among `entries` (see the module comment): the exact name, the one qualified name of a
 * unique bare alias, or the bare name of a harness plugin entry called `<pluginId>:<name>`; null when nothing matches or
 * a bare alias is ambiguous.
 */
export function resolveCatalogName(entries: readonly NamedEntry[], wanted: string): string | null {
  if (typeof wanted !== 'string' || wanted === '')
    return null
  if (entries.some(entry => entry.name === wanted))
    return wanted
  if (!wanted.includes(':')) {
    const aliases = bareAliasNames(entries, wanted)
    return aliases.length === 1 ? aliases[0]! : null
  }
  const parts = splitQualifiedName(wanted)
  if (parts === null || parts.segments.length !== 1)
    return null
  const bare = entries.find(entry => entry.name === parts.name && entry.source === 'plugin' && entry.pluginId === parts.pluginId)
  return bare === undefined ? null : bare.name
}

/** The first entry `resolveCatalogName` points at, or null. */
export function findCatalogEntry<T extends NamedEntry>(entries: readonly T[], wanted: string): T | null {
  const name = resolveCatalogName(entries, wanted)
  return name === null ? null : entries.find(entry => entry.name === name) ?? null
}
