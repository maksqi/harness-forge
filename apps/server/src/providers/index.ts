// Phase 0 stub. Owner: W1.4 (W1.4-T1, T2). Implement `ProviderService` (./types.ts) and keep the export name and
// signature: `createProviderService(deps: AppDeps): ProviderService`.
import type { AppDeps } from '../types.ts'
import type { ProviderService } from './types.ts'
import { rejectsNotImplemented, throwsNotImplemented } from '../not-implemented.ts'

export function createProviderService(_deps: AppDeps): ProviderService {
  return {
    list: rejectsNotImplemented('providers.list'),
    get: rejectsNotImplemented('providers.get'),
    isEnabled: rejectsNotImplemented('providers.isEnabled'),
    setEnabled: rejectsNotImplemented('providers.setEnabled'),
    test: rejectsNotImplemented('providers.test'),
    resolveModel: rejectsNotImplemented('providers.resolveModel'),
    runtime: rejectsNotImplemented('providers.runtime'),
    mapError: throwsNotImplemented('providers.mapError'),
    recordOutcome: rejectsNotImplemented('providers.recordOutcome'),
  }
}
