// Read-only share links (ADR-025, API.md 5.20, ARCHITECTURE.md 6.10 / 10.7). Owner: W5.4. Implements `ShareService`
// (./types.ts) behind `createShareService(deps)`.
//
// Phase 5 skeleton (P5-0b): every member answers `not_implemented` (HTTP 501) until W5.4 implements the service.
import type { AppDeps } from '../../types.ts'
import type { ShareService } from './types.ts'
import { rejectsNotImplemented } from '../../not-implemented.ts'

export function createShareService(_deps: AppDeps): ShareService {
  return {
    list: rejectsNotImplemented('ShareService.list (W5.4)'),
    create: rejectsNotImplemented('ShareService.create (W5.4)'),
    update: rejectsNotImplemented('ShareService.update (W5.4)'),
    remove: rejectsNotImplemented('ShareService.remove (W5.4)'),
    view: rejectsNotImplemented('ShareService.view (W5.4)'),
    openFile: rejectsNotImplemented('ShareService.openFile (W5.4)'),
  }
}
