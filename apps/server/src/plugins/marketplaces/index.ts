// The marketplace service (Phase 12, ADR-054; API.md 5.34, ARCHITECTURE.md 6.34) behind `MarketplaceService`
// (./types.ts). C43 stub with the final signature (P12-0b): `list` answers no marketplace, the suggestions and no update;
// `get` answers `not_found` (there is none); the writes throw `not_implemented`; `stop` is a no-op. Owner in P12-A: W12.2
// (the store, the GitHub resolution through `safeFetch`, the catalog, the entry sources, the updates, `HF_OFFLINE`, the
// reserved names).
import type { MarketplaceDetail, MarketplaceList } from '@harness-forge/shared'
import type { AppDeps } from '../../types.ts'
import type { MarketplaceService, MarketplaceServiceOptions } from './types.ts'
import { HarnessError, MARKETPLACE_SUGGESTIONS } from '@harness-forge/shared'
import { noopAsync, rejectsNotImplemented } from '../../not-implemented.ts'

export function createMarketplaceService(_deps: AppDeps, _options: MarketplaceServiceOptions = {}): MarketplaceService {
  return Object.freeze({
    list: async (): Promise<MarketplaceList> => ({ items: [], suggestions: [...MARKETPLACE_SUGGESTIONS], updates: [] }),
    add: rejectsNotImplemented('Adding a marketplace'),
    get: async (id: string): Promise<MarketplaceDetail> => {
      throw new HarnessError({ code: 'not_found', message: `Marketplace ${id} not found.` })
    },
    refresh: rejectsNotImplemented('Refreshing a marketplace'),
    remove: rejectsNotImplemented('Removing a marketplace'),
    stop: noopAsync,
  })
}
