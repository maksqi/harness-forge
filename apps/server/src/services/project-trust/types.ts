// Frozen interface of project trust (Phase 11, ADR-049; API.md 4.32 / 5.32, ARCHITECTURE.md 6.29): the approved sha256
// of every executable item of a project folder (a hook of its settings files, a `.mcp.json` server, a command file with
// `` !`cmd` `` spans), table `project_trust` (primary key (project, sha256), cascading from `projects`). Implementation:
// `createProjectTrustService(deps)` in `services/project-trust/index.ts` (C36 stub: the stored approvals, no items;
// W11.3 implements the item list, approve, revoke and the pending count). Consumers: the `projectTrust` routes (W11.3),
// the hook snapshot (W11.1), the project MCP manager (W11.4) and the command `!` spans (`CommandContext.expansion
// .trusted`, W11.5). Test double: `createFakeProjectTrustService` (`testing/fake-project-trust.ts`, an in-memory approved
// set), installed with `createTestApp({ projectTrust: 'fake' })`.
//
// A missing approval means pending: the item never runs and nothing asks at run time. Approve and revoke emit
// `project-trust.changed { projectId, pending }` and `hooks.changed { projectId }`; the project MCP manager reacts to
// the event (it is never called from here). Approvals are configuration: never in backups or exports, kept by
// delete-all, deleted with their project (foreign key). Commands, URLs and variable names are never logged at `info`.
import type { ProjectTrustList, TrustApproval } from '@harness-forge/shared'
import type { SensitiveOperationOptions } from '../../types.ts'

/** Project trust. Errors are `HarnessError`s the routes pass through (API.md 2). Frozen after P11-0b. */
export interface ProjectTrustService {
  /**
   * The approved hashes of the project (memoized; dropped on approve, revoke and project deletion); empty for an
   * unknown project. Callers still verify an item right before it runs (`ProjectConfigService.verify`).
   */
  readonly approved: (projectId: string) => Promise<ReadonlySet<string>>
  /**
   * `GET /projects/:id/trust`: the items of a fresh scan (`projectConfig.snapshot(projectId, { refresh: true })`: hooks
   * and `.mcp.json` servers; project command files with `!` spans through the customization catalog and
   * `customizations.load`) with their state (`approved` / `pending`, `changed`), warnings, referenced files and detail,
   * and the count of orphaned approvals. Throws `not_found` for an unknown project; an unavailable folder answers
   * `available: false` and no items.
   */
  readonly list: (projectId: string) => Promise<ProjectTrustList>
  /**
   * `POST /projects/:id/trust`: calls `options.requireFreshAuth()` first when given (the route table marks the route
   * fresh too), scans the folder again (`refresh`) and inserts every requested `{ kind, sha256 }` in one transaction
   * when each is a current item of that kind; otherwise nothing is written and it throws `conflict` with `reason:
   * 'stale'`. Answers the fresh list. Throws `not_found` for an unknown project.
   */
  readonly approve: (projectId: string, items: readonly TrustApproval[], options?: SensitiveOperationOptions) => Promise<ProjectTrustList>
  /**
   * `DELETE /projects/:id/trust/:sha256`: removes the approval (idempotent: an unknown hash is no error) and the
   * project's orphaned approvals; answers the fresh list. Throws `not_found` for an unknown project.
   */
  readonly revoke: (projectId: string, sha256: string) => Promise<ProjectTrustList>
  /**
   * The items of the project that wait for a review (`project-trust.changed.pending`, the trust chip count); 0 for an
   * unknown project or an unavailable folder. Never rejects for a folder problem.
   */
  readonly pending: (projectId: string) => Promise<number>
}
