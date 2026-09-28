// Phase 0 stub. Owner: W1.4 (W1.4-T5). Implement `IconService` (./types.ts) and keep the export name and signature:
// `createIconService(deps: AppDeps): IconService` (files of `@lobehub/icons-static-svg` only; resolve the package with
// `resolvePackageDir()` from `paths.ts`).
import type { AppDeps } from '../types.ts'
import type { IconService } from './types.ts'
import { rejectsNotImplemented, throwsNotImplemented } from '../not-implemented.ts'
import { packageVersion } from '../paths.ts'

export function createIconService(_deps: AppDeps): IconService {
  return {
    version: packageVersion('@lobehub/icons-static-svg') ?? '0.0.0',
    list: rejectsNotImplemented('icons.list'),
    read: rejectsNotImplemented('icons.read'),
    lobeRef: throwsNotImplemented('icons.lobeRef'),
  }
}
