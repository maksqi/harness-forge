// Phase 0 stub. Owner: W1.4 (W1.4-T3, T4). Implement `ModelCatalog` (./types.ts) and keep the export name and
// signature: `createModelCatalog(deps: AppDeps): ModelCatalog`. `start` / `stop` are no-ops until then.
import type { AppDeps } from '../types.ts'
import type { ModelCatalog } from './types.ts'
import { noopAsync, rejectsNotImplemented } from '../not-implemented.ts'

export function createModelCatalog(_deps: AppDeps): ModelCatalog {
  return {
    start: noopAsync,
    stop: noopAsync,
    list: rejectsNotImplemented('catalog.list'),
    get: rejectsNotImplemented('catalog.get'),
    refresh: rejectsNotImplemented('catalog.refresh'),
    updatePrefs: rejectsNotImplemented('catalog.updatePrefs'),
    addCustom: rejectsNotImplemented('catalog.addCustom'),
    removeCustom: rejectsNotImplemented('catalog.removeCustom'),
    markUsed: rejectsNotImplemented('catalog.markUsed'),
    stats: rejectsNotImplemented('catalog.stats'),
  }
}
