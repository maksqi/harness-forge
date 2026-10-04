// The customization service (Phase 10, ADR-044 / ADR-045; ARCHITECTURE.md 6.23) behind `CustomizationService`
// (./types.ts). C30 stub with the final factory signature: a builtins-only catalog (the agent types `explore` and
// `general` of `core-agent`) for every project and the global catalog; `load` of a builtin works; the personal
// definitions (`get`, `create`, `update`, `remove`, `exportBackup`, `restoreBackup`) and `source` answer
// `not_implemented`; `invalidate` and `stop` are no-ops. W10.1 implements discovery, the user store, the merge, the cache
// and `load` behind the same signature.
import type { CustomizationProjectScan } from '@harness-forge/shared'
import type { AppDeps } from '../../types.ts'
import type { CustomizationCatalog, CustomizationService } from './types.ts'
import { notImplementedError, rejectsNotImplemented } from '../../not-implemented.ts'
import { builtinCatalogEntries, loadBuiltin } from './builtins.ts'
import { catalogList, createCatalogSnapshot } from './snapshot.ts'

/** Test options of the service (W10.1 may add more; all optional). */
export interface CustomizationServiceOptions {
  /** The clock (epoch ms); default `Date.now`. */
  readonly now?: () => number
}

export function createCustomizationService(deps: AppDeps, options: CustomizationServiceOptions = {}): CustomizationService {
  const now = options.now ?? Date.now

  /** The stub catalog: the builtins only; a project scan that read no definition folder. */
  function snapshot(projectId: string | null): CustomizationCatalog {
    const builtAt = now()
    const project: CustomizationProjectScan | null = projectId === null ? null : { id: projectId, available: true, folders: [], scannedAt: builtAt }
    return createCatalogSnapshot({ projectId, entries: builtinCatalogEntries(), diagnostics: [], project, builtAt })
  }

  return {
    catalog: async (projectId, catalogOptions) => {
      catalogOptions?.signal?.throwIfAborted()
      return snapshot(projectId)
    },
    list: async (query) => {
      // An unknown project is `not_found` (the project service's error).
      if (query.projectId !== undefined)
        await deps.projects.get(query.projectId)
      return catalogList(snapshot(query.projectId ?? null), query.kind)
    },
    source: rejectsNotImplemented('Customization sources'),
    load: async (entry, signal) => {
      signal?.throwIfAborted()
      const loaded = loadBuiltin(entry)
      if (loaded === null)
        throw notImplementedError('Loading customizations')
      return loaded
    },
    get: rejectsNotImplemented('Personal customizations'),
    create: rejectsNotImplemented('Personal customizations'),
    update: rejectsNotImplemented('Personal customizations'),
    remove: rejectsNotImplemented('Personal customizations'),
    exportBackup: rejectsNotImplemented('Customization backups'),
    restoreBackup: rejectsNotImplemented('Customization backups'),
    invalidate: () => {},
    stop: () => {},
  }
}
