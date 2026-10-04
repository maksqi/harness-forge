// The catalog snapshot (Phase 10, ADR-044): `CustomizationCatalog` over a merged entry list, and the route answer
// `CustomizationList` of a snapshot. Pure helpers shared by the service (C30 stub, W10.1) and the test double
// (`testing/fake-customizations.ts`): the merge, the precedence and the states are decided before (`catalog.ts`,
// `resolvePrecedence`); a snapshot only indexes the active entries.
import type {
  CustomizationEntry,
  CustomizationKind,
  CustomizationList,
  CustomizationProjectScan,
  DefinitionDiagnostic,
} from '@harness-forge/shared'
import type { CustomizationCatalog } from './types.ts'
import { AGENT_TYPE_ALIASES, CUSTOMIZATION_KINDS, resolvePrecedence } from '@harness-forge/shared'

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

/** An agent type with its alias resolved (`general-purpose` → `general`); other names unchanged. */
export function resolveAgentAlias(name: string): string {
  const target = Object.hasOwn(AGENT_TYPE_ALIASES, name) ? AGENT_TYPE_ALIASES[name] : undefined
  return target ?? name
}

/** Builds an immutable snapshot; the getters index the `active` entries only (the first active entry of a name wins). */
export function createCatalogSnapshot(input: CatalogSnapshotInput): CustomizationCatalog {
  const entries = Object.freeze(sortCatalogEntries(input.entries))
  const active: Record<CustomizationKind, Map<string, CustomizationEntry>> = { agent: new Map(), command: new Map(), skill: new Map() }
  for (const entry of entries) {
    if (entry.state === 'active' && !active[entry.kind].has(entry.name))
      active[entry.kind].set(entry.name, entry)
  }
  const lists: Record<CustomizationKind, readonly CustomizationEntry[]> = {
    agent: Object.freeze([...active.agent.values()]),
    command: Object.freeze([...active.command.values()]),
    skill: Object.freeze([...active.skill.values()]),
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
    agent: (name: string) => active.agent.get(resolveAgentAlias(name)) ?? null,
    command: (name: string) => active.command.get(name.startsWith('/') ? name.slice(1) : name) ?? null,
    skill: (name: string) => active.skill.get(name) ?? null,
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
