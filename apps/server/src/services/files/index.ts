// Phase 0 stub. Owner: W1.5 (W1.5-T5). Implement `FilesService` (./types.ts) and keep the export name and signature:
// `createFilesService(deps: AppDeps): FilesService` (table `files`, bytes in `deps.env.paths.files`).
import type { AppDeps } from '../../types.ts'
import type { FilesService } from './types.ts'
import { rejectsNotImplemented, throwsNotImplemented } from '../../not-implemented.ts'

export function createFilesService(_deps: AppDeps): FilesService {
  return {
    upload: rejectsNotImplemented('files.upload'),
    get: rejectsNotImplemented('files.get'),
    read: rejectsNotImplemented('files.read'),
    open: rejectsNotImplemented('files.open'),
    idFromUrl: throwsNotImplemented('files.idFromUrl'),
  }
}
