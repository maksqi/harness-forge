// Test double of project trust (Phase 11, C36-T10): an in-memory approved set per project, so the hook service, the
// project MCP manager, command `!` spans and the trust routes can be tested without the `project_trust` table:
//
//   const t = await createTestApp({ projectTrust: 'fake' })   // or overrides: { projectTrust: createFakeProjectTrustService() }
//   const fake = t.deps.projectTrust as FakeProjectTrustService
//   fake.approve(projectId, [{ kind: 'hook', sha256 }])            // or: fake.approvedHashes.set(projectId, new Set([sha256]))
//   fake.items.set(projectId, [trustItemOf(fakeProjectHookItem({ command: 'sh x.sh' }))])   // what `list` reviews
//
// Any id is a project. `list` answers the scripted items with their state from the approved set (`approved` /
// `pending`) and the approvals no item has as `orphaned`. `approve` calls `requireFreshAuth` first when given; when items
// are scripted for the project, a hash that is not one of them (same kind and sha256) is `409 stale` and nothing is
// written; without scripted items every hash is accepted. `revoke` is idempotent. Approve and revoke emit
// `project-trust.changed` and `hooks.changed` on `options.events`. `pending` counts the scripted items not approved.
import type { ProjectTrustList, TrustItem } from '@harness-forge/shared'
import type { EventBus } from '../services/events/types.ts'
import type { ProjectConfigItem } from '../services/project-config/types.ts'
import type { ProjectTrustService } from '../services/project-trust/types.ts'
import { HarnessError, serverVariables } from '@harness-forge/shared'

/** The review DTO of a project config item (state `pending`; `list` sets the state from the approved set). */
export function trustItemOf(item: ProjectConfigItem): TrustItem {
  const base = {
    sha256: item.sha256,
    state: 'pending' as const,
    label: item.label,
    path: item.path,
    refs: item.hashItem.refs.map(ref => ({ path: ref.path, sha256: ref.sha256 })),
    warnings: [...item.warnings],
  }
  if (item.kind === 'hook') {
    const { spec } = item
    return { ...base, kind: 'hook', detail: { event: spec.event, matcher: spec.matcher, command: spec.command, timeout: spec.timeoutSec } }
  }
  const { server } = item
  const transport = server.transport
  const variables = [...new Set(serverVariables(transport).map(ref => ref.name))]
  return {
    ...base,
    kind: 'mcp',
    detail: transport.type === 'stdio'
      ? { name: server.name, id: server.id, transport: 'stdio', command: transport.command, args: [...transport.args], envNames: Object.keys(transport.env), headerNames: [], variables }
      : { name: server.name, id: server.id, transport: transport.type, url: transport.url, envNames: [], headerNames: Object.keys(transport.headers), variables },
  }
}

export interface FakeProjectTrustServiceOptions {
  /** Approved hashes per project id. */
  approved?: Readonly<Record<string, readonly string[]>>
  /** Review items per project id (their `state` is computed). */
  items?: Readonly<Record<string, readonly TrustItem[]>>
  /** Receives `project-trust.changed` and `hooks.changed` on approve and revoke (default: no events). */
  events?: Pick<EventBus, 'emit'>
  /** Clock (epoch ms; default `Date.now`). */
  now?: () => number
}

export interface FakeProjectTrustService extends ProjectTrustService {
  /** Approved hashes per project id; tests may edit them. */
  readonly approvedHashes: Map<string, Set<string>>
  /** Review items per project id; tests may edit them. */
  readonly items: Map<string, TrustItem[]>
  /** Number of calls of each member. */
  readonly calls: Record<keyof ProjectTrustService, number>
}

export function createFakeProjectTrustService(options: FakeProjectTrustServiceOptions = {}): FakeProjectTrustService {
  const now = options.now ?? Date.now
  const approvedHashes = new Map(Object.entries(options.approved ?? {}).map(([projectId, hashes]) => [projectId, new Set(hashes)]))
  const items = new Map(Object.entries(options.items ?? {}).map(([projectId, list]) => [projectId, [...list]]))
  const calls: Record<keyof ProjectTrustService, number> = { approved: 0, list: 0, approve: 0, revoke: 0, pending: 0 }

  function setOf(projectId: string): Set<string> {
    let set = approvedHashes.get(projectId)
    if (set === undefined) {
      set = new Set()
      approvedHashes.set(projectId, set)
    }
    return set
  }

  function pendingCount(projectId: string): number {
    const approved = approvedHashes.get(projectId) ?? new Set()
    return (items.get(projectId) ?? []).filter(item => !approved.has(item.sha256)).length
  }

  function listOf(projectId: string): ProjectTrustList {
    const approved = approvedHashes.get(projectId) ?? new Set()
    const current = items.get(projectId) ?? []
    const known = new Set(current.map(item => item.sha256))
    return {
      items: current.map(item => ({ ...item, state: approved.has(item.sha256) ? 'approved' : 'pending' })),
      orphaned: [...approved].filter(sha256 => !known.has(sha256)).length,
      scannedAt: now(),
      available: true,
    }
  }

  function changed(projectId: string): void {
    options.events?.emit('project-trust.changed', { projectId, pending: pendingCount(projectId) })
    options.events?.emit('hooks.changed', { projectId })
  }

  return {
    approvedHashes,
    items,
    calls,
    approved: async (projectId) => {
      calls.approved += 1
      return new Set(approvedHashes.get(projectId) ?? [])
    },
    list: async (projectId) => {
      calls.list += 1
      return listOf(projectId)
    },
    approve: async (projectId, approvals, sensitive) => {
      calls.approve += 1
      sensitive?.requireFreshAuth()
      const scripted = items.get(projectId)
      if (scripted !== undefined) {
        const stale = approvals.some(approval => !scripted.some(item => item.kind === approval.kind && item.sha256 === approval.sha256))
        if (stale)
          throw new HarnessError({ code: 'conflict', message: 'The project files changed while you reviewed them. Review them again.', details: { reason: 'stale' } })
      }
      const set = setOf(projectId)
      for (const approval of approvals)
        set.add(approval.sha256)
      changed(projectId)
      return listOf(projectId)
    },
    revoke: async (projectId, sha256) => {
      calls.revoke += 1
      approvedHashes.get(projectId)?.delete(sha256)
      changed(projectId)
      return listOf(projectId)
    },
    pending: async (projectId) => {
      calls.pending += 1
      return pendingCount(projectId)
    },
  }
}
