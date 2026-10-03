// Project files service (Phase 9, ADR-042, ARCHITECTURE.md 6.21): the per-project file index and the attach of `@`
// mentions behind `ProjectFileService` (./types.ts). P9-0b stub (C24) with the final factory signature: `search` and
// `attach` reject with `not_implemented` (the routes answer 501 until W9.6), `invalidate` and `stop` are no-ops (the
// index builds lazily, so there is no boot step).
import type { AppDeps } from '../../types.ts'
import type { ProjectFileService } from './types.ts'
import { rejectsNotImplemented } from '../../not-implemented.ts'

export function createProjectFileService(_deps: AppDeps): ProjectFileService {
  return {
    search: rejectsNotImplemented('Project file search'),
    attach: rejectsNotImplemented('Project file attach'),
    invalidate: () => {},
    stop: () => {},
  }
}
