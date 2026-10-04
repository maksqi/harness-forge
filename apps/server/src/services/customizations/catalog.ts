// The merge of the catalog (Phase 10, ADR-044; ARCHITECTURE.md 6.23 "The catalog"). Owner: W10.1.
//
// Candidates, lowest precedence first: the builtin agents `explore` / `general` (`builtins.ts`) < the plugin agents,
// skills and commands (`plugins.ts`) < the personal rows (`store.ts`) < the project's `.claude` files < its `.harness`
// files (`discover.ts`). Every candidate is checked against the live state (`checkEntry`: unknown tools, unconfigured
// model providers; warnings only), then the shared `resolvePrecedence` (through `applyPrecedence`) keeps one active
// entry per kind and name: the losers are `shadowed` with `shadowedBy` and a `shadowed` info (`duplicate-name` within
// one folder, where the first sorted path wins); `invalid` and `off` entries shadow nothing. The same name in two kinds
// never shadows. The result is the immutable snapshot of `snapshot.ts`.
import type { CustomizationEntry, CustomizationProjectScan, DefinitionDiagnostic } from '@harness-forge/shared'
import type { CatalogCheckContext } from './entries.ts'
import type { CustomizationCatalog } from './types.ts'
import { checkEntry, withShadowDiagnostic } from './entries.ts'
import { applyPrecedence, createCatalogSnapshot } from './snapshot.ts'

/** The project part of a catalog. */
export interface CatalogProjectPart {
  readonly scan: CustomizationProjectScan
  readonly entries: readonly CustomizationEntry[]
  /** Folder-level diagnostics (`link`, `limit`, `read-failed`, `project-unavailable`). */
  readonly diagnostics: readonly DefinitionDiagnostic[]
}

export interface CatalogMergeInput {
  readonly projectId: string | null
  /** The builtin, plugin and personal entries, in that order. */
  readonly global: readonly CustomizationEntry[]
  /** null for the global catalog. */
  readonly project: CatalogProjectPart | null
  readonly checks: CatalogCheckContext
  readonly builtAt: number
}

/** Merges the sources into one snapshot (see the module comment). */
export function mergeCatalog(input: CatalogMergeInput): CustomizationCatalog {
  const candidates = [...input.global, ...(input.project?.entries ?? [])].map(entry => checkEntry(entry, input.checks))
  const entries = applyPrecedence(candidates).map(withShadowDiagnostic)
  return createCatalogSnapshot({
    projectId: input.projectId,
    entries,
    diagnostics: input.project?.diagnostics ?? [],
    project: input.project?.scan ?? null,
    builtAt: input.builtAt,
  })
}

/**
 * What a rebuilt project catalog is compared on: its project entries (with their states and diagnostics), the folder
 * diagnostics, the folders read and whether the folder was available. Equal fingerprints = nothing on disk changed.
 */
export function projectFingerprint(catalog: CustomizationCatalog): string {
  return JSON.stringify({
    available: catalog.project?.available ?? null,
    folders: catalog.project?.folders ?? [],
    diagnostics: catalog.diagnostics,
    entries: catalog.entries.filter(entry => entry.source === 'project'),
  })
}
