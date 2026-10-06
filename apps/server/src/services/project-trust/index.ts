// Project trust (Phase 11, ADR-049; ARCHITECTURE.md 6.29; API.md 4.32 / 5.32) behind `ProjectTrustService`
// (./types.ts). Owner: W11.3 (C36 landed the stub with the final factory signature).
//
// C36 stub (P11-0b): `approved` answers the stored hashes of the project (table `project_trust`); `list` answers no
// items (every stored approval counts as orphaned; `available` from the project; an unknown project is `not_found`);
// `approve` and `revoke` reject with `not_implemented`; `pending` answers 0. W11.3 implements the scan, the item list,
// approve (fresh auth, 409 `stale`), revoke, the memoized approved set and the events.
import type { ProjectTrustList } from '@harness-forge/shared'
import type { AppDeps } from '../../types.ts'
import type { ProjectTrustService } from './types.ts'
import { eq } from 'drizzle-orm'
import { projectTrust } from '../../db/schema.ts'
import { rejectsNotImplemented } from '../../not-implemented.ts'
import { guardDb } from '../chats/db-errors.ts'

export function createProjectTrustService(deps: AppDeps): ProjectTrustService {
  async function storedHashes(projectId: string): Promise<string[]> {
    const rows = await guardDb(() => deps.db.select({ sha256: projectTrust.sha256 }).from(projectTrust).where(eq(projectTrust.projectId, projectId)))
    return rows.map(row => row.sha256)
  }

  async function list(projectId: string): Promise<ProjectTrustList> {
    // `not_found` for an unknown project (the route answers 404).
    const project = await deps.projects.get(projectId)
    const stored = await storedHashes(projectId)
    return {
      items: [],
      orphaned: stored.length,
      scannedAt: Date.now(),
      available: project.available,
      ...(project.issue === null ? {} : { issue: project.issue }),
    }
  }

  return {
    approved: async projectId => new Set(await storedHashes(projectId)),
    list,
    approve: rejectsNotImplemented('Approving project items'),
    revoke: rejectsNotImplemented('Revoking a project approval'),
    pending: async () => 0,
  }
}
