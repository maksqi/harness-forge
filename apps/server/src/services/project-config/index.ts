// The project config reader (Phase 11, ADR-049 / ADR-050; ARCHITECTURE.md 6.29) behind `ProjectConfigService`
// (./types.ts). Owner: W11.3 (C36 landed the stub with the final factory signature).
//
// C36 stub (P11-0b): `snapshot` opens the project folder (`projects.openWorkspace`: `available`, `issue`, `root`) and
// reads nothing in it (no settings file, no `.mcp.json`, no items); `verify` answers false (fail closed: no item is
// known); `invalidate` and `stop` are no-ops. W11.3 implements the reads through the path guard, the parsing with the
// shared helpers, the hashes of the items and their referenced files, the 10 s cache and `verify`.
import type { TrustHashItem } from '@harness-forge/shared'
import type { AppDeps } from '../../types.ts'
import type { ProjectConfigService, ProjectConfigSnapshot } from './types.ts'
import { createHash } from 'node:crypto'
import { trustHashInput } from '@harness-forge/shared'

/** The trust hash of an item: sha256 (lowercase hex) of the shared canonical `trustHashInput(item)`. */
export function trustSha256(item: TrustHashItem): string {
  return createHash('sha256').update(trustHashInput(item), 'utf8').digest('hex')
}

/** A snapshot without items (a folder that opened but holds nothing executable, or one that did not open). */
export function emptyProjectConfigSnapshot(projectId: string, fields: Pick<ProjectConfigSnapshot, 'available' | 'issue' | 'root'>, scannedAt: number): ProjectConfigSnapshot {
  return Object.freeze({
    projectId,
    available: fields.available,
    issue: fields.issue,
    root: fields.root,
    settingsFiles: [],
    mcpFile: false,
    hooks: [],
    mcpServers: [],
    hookDiagnostics: [],
    mcpDiagnostics: [],
    scannedAt,
  })
}

export function createProjectConfigService(deps: AppDeps): ProjectConfigService {
  return {
    snapshot: async (projectId, options) => {
      options?.signal?.throwIfAborted()
      const opened = await deps.projects.openWorkspace(projectId)
      options?.signal?.throwIfAborted()
      const fields = opened.ok
        ? { available: true, issue: null, root: opened.workspace.root }
        : { available: false, issue: opened.message, root: null }
      return emptyProjectConfigSnapshot(projectId, fields, Date.now())
    },
    verify: async (_projectId, _item, signal) => {
      signal?.throwIfAborted()
      return false
    },
    invalidate: () => {},
    stop: () => {},
  }
}
