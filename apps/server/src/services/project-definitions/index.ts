// Project definition files (Phase 12, ADR-056; API.md 5.36, ARCHITECTURE.md 6.36) behind `ProjectDefinitionsService`
// (./types.ts). C43 stub with the final signature (P12-0b): every member answers `not_implemented` (the routes answer
// 501). Owner in P12-A: W12.4 (`paths`, `settings-file`, read / write / remove).
import type { AppDeps } from '../../types.ts'
import type { ProjectDefinitionsService } from './types.ts'
import { rejectsNotImplemented } from '../../not-implemented.ts'

export function createProjectDefinitionsService(_deps: AppDeps): ProjectDefinitionsService {
  return Object.freeze({
    read: rejectsNotImplemented('Reading a project definition file'),
    write: rejectsNotImplemented('Saving a project definition file'),
    remove: rejectsNotImplemented('Deleting a project definition file'),
  })
}
