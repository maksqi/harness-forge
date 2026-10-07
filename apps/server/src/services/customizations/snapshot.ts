// The catalog snapshot (Phase 10, ADR-044): `CustomizationCatalog` over a merged entry list, and the route answer
// `CustomizationList` of a snapshot. Pure helpers shared by the service (C30 stub, W10.1) and the test double
// (`testing/fake-customizations.ts`): the merge, the precedence and the states are decided before (`catalog.ts`,
// `resolvePrecedence`); a snapshot only indexes the active entries.
// Phase 12 (ADR-053, open point 8; W12.7): the getters `agent` / `command` / `skill` / `style(name)` accept a qualified
// name exactly, a bare name by the alias rule of `qualified.ts` (exactly one active entry of the kind ends in `:<bare>`
// and none has the exact name) and a harness plugin's `<pluginId>:<name>` (its bare entry); `agent` also maps the agent
// type aliases (`general-purpose`, Claude Code's `Explore`).
import type {
  CustomizationEntry,
  CustomizationKind,
  CustomizationList,
  CustomizationProjectScan,
  DefinitionDiagnostic,
} from '@harness-forge/shared'
import type { CustomizationCatalog } from './types.ts'
import { AGENT_TYPE_ALIASES, CLAUDE_AGENT_TYPE_ALIASES, CUSTOMIZATION_KINDS, resolvePrecedence } from '@harness-forge/shared'
import { findCatalogEntry } from './qualified.ts'

/** What a snapshot is built from. */
export interface CatalogSnapshotInput {
  readonly projectId: string | null
  /** The merged entries, every source and state. Sorted by `sortCatalogEntries` when the snapshot is built. */
  readonly entries: readonly CustomizationEntry[]
  readonly diagnostics?: readonly DefinitionDiagnostic[]
  readonly project?: CustomizationProjectScan | null
  readonly builtAt: number
}

function kindIndex(kind: CustomizationKind): number {
  return CUSTOMIZATION_KINDS.indexOf(kind)
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * The catalog order: kind (`CUSTOMIZATION_KINDS`), then name, then the active entry first; the other entries of a name
 * keep their input order (the merge lists them in precedence order).
 */
export function sortCatalogEntries(entries: readonly CustomizationEntry[]): CustomizationEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) =>
      kindIndex(a.entry.kind) - kindIndex(b.entry.kind)
      || compareText(a.entry.name, b.entry.name)
      || Number(b.entry.state === 'active') - Number(a.entry.state === 'active')
      || a.index - b.index)
    .map(({ entry }) => entry)
}

/**
 * Applies the precedence of ADR-044 to merged candidates: `invalid` and `off` entries are kept as they are (they shadow
 * nothing); of the others, one winner per kind and name (`resolvePrecedence`) becomes `active` and every other one
 * `shadowed` with `shadowedBy` (the winner's source, path and plugin). Returns the entries in catalog order.
 */
export function applyPrecedence(candidates: readonly CustomizationEntry[]): CustomizationEntry[] {
  const kept = candidates.filter(entry => entry.state === 'invalid' || entry.state === 'off')
  const { active, shadowed } = resolvePrecedence(candidates.filter(entry => entry.state !== 'invalid' && entry.state !== 'off'))
  const winners = active.map(({ shadowedBy: _shadowedBy, ...entry }): CustomizationEntry => ({ ...entry, state: 'active' }))
  const losers = shadowed.map(({ entry, by }): CustomizationEntry => ({
    ...entry,
    state: 'shadowed',
    shadowedBy: {
      source: by.source,
      ...(by.path === undefined ? {} : { path: by.path }),
      ...(by.pluginId === undefined ? {} : { pluginId: by.pluginId }),
    },
  }))
  return sortCatalogEntries([...winners, ...losers, ...kept])
}

/** Claude Code's agent type names (`CLAUDE_AGENT_TYPE_ALIASES`), keyed lowercase (`Explore` and `explore`). */
const CLAUDE_AGENT_TYPES: ReadonlyMap<string, string> = new Map(Object.entries(CLAUDE_AGENT_TYPE_ALIASES).map(([claude, harness]) => [claude.toLowerCase(), harness]))

/**
 * An agent type with its alias resolved (`general-purpose` → `general`; Phase 12: Claude Code's agent type names of
 * `CLAUDE_AGENT_TYPE_ALIASES`, any case, `Explore` → `explore`); other names unchanged.
 */
export function resolveAgentAlias(name: string): string {
  const target = Object.hasOwn(AGENT_TYPE_ALIASES, name) ? AGENT_TYPE_ALIASES[name] : undefined
  if (target !== undefined)
    return target
  return typeof name === 'string' ? CLAUDE_AGENT_TYPES.get(name.toLowerCase()) ?? name : name
}

/** Builds an immutable snapshot; the getters index the `active` entries only (the first active entry of a name wins). */
export function createCatalogSnapshot(input: CatalogSnapshotInput): CustomizationCatalog {
  const entries = Object.freeze(sortCatalogEntries(input.entries))
  const active: Record<CustomizationKind, Map<string, CustomizationEntry>> = { agent: new Map(), command: new Map(), skill: new Map(), style: new Map() }
  for (const entry of entries) {
    if (entry.state === 'active' && !active[entry.kind].has(entry.name))
      active[entry.kind].set(entry.name, entry)
  }
  const lists: Record<CustomizationKind, readonly CustomizationEntry[]> = {
    agent: Object.freeze([...active.agent.values()]),
    command: Object.freeze([...active.command.values()]),
    skill: Object.freeze([...active.skill.values()]),
    style: Object.freeze([...active.style.values()]),
  }
  /** The exact name, else the qualified alias of `qualified.ts` (Phase 12). */
  const lookup = (kind: CustomizationKind, name: string): CustomizationEntry | null => {
    if (typeof name !== 'string')
      return null
    return active[kind].get(name) ?? findCatalogEntry(lists[kind], name)
  }
  return Object.freeze({
    projectId: input.projectId,
    entries,
    diagnostics: Object.freeze([...(input.diagnostics ?? [])]),
    project: input.project ?? null,
    builtAt: input.builtAt,
    agents: () => lists.agent,
    commands: () => lists.command,
    skills: () => lists.skill,
    styles: () => lists.style,
    agent: (name: string) => lookup('agent', resolveAgentAlias(name)),
    command: (name: string) => lookup('command', typeof name === 'string' && name.startsWith('/') ? name.slice(1) : name),
    skill: (name: string) => lookup('skill', name),
    style: (name: string) => lookup('style', name),
  })
}

/** `GET /customizations`: the snapshot as the route answer, the items filtered by `kind`. */
export function catalogList(catalog: CustomizationCatalog, kind?: CustomizationKind): CustomizationList {
  return {
    items: kind === undefined ? [...catalog.entries] : catalog.entries.filter(entry => entry.kind === kind),
    diagnostics: [...catalog.diagnostics],
    project: catalog.project,
    builtAt: catalog.builtAt,
  }
}
