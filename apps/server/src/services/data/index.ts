// Bulk data (ADR-024, API.md 5.19, ARCHITECTURE.md 6.9). Owner: W5.3. Implements `DataService` (./types.ts) behind
// `createDataService(deps)`.
//
// Phase 5 skeleton (P5-0b): every member answers `not_implemented` (HTTP 501) until W5.3 implements the service.
import type { AppDeps } from '../../types.ts'
import type { DataService } from './types.ts'
import { rejectsNotImplemented } from '../../not-implemented.ts'

export function createDataService(_deps: AppDeps): DataService {
  return {
    summary: rejectsNotImplemented('DataService.summary (W5.3)'),
    exportBackup: rejectsNotImplemented('DataService.exportBackup (W5.3)'),
    importData: rejectsNotImplemented('DataService.importData (W5.3)'),
    deleteAll: rejectsNotImplemented('DataService.deleteAll (W5.3)'),
  }
}
