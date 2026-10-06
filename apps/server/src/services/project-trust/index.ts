// Project trust (Phase 11, ADR-049; ARCHITECTURE.md 6.29; API.md 4.32 / 5.32) behind `ProjectTrustService`
// (./types.ts). Owner: W11.3 (C36 landed the stub with the final factory signature).
//
// - Scan: the hooks and `.mcp.json` servers of `projectConfig.snapshot(projectId, { refresh })` plus the active project
//   command files of the customization catalog whose body (`customizations.load`) holds `` !`cmd` `` spans
//   (`planCommandExpansion`; hash input `{ kind: 'command', name, spans, refs }` through `commandTrustSubject`, the
//   same helper the command resolution uses). A command with a span longer than `LIMITS.hookCommandMaxChars` cannot be
//   shown in full, so it is never listed (and never approvable). Command items are memoized per catalog snapshot.
// - `approved(projectId)`: the stored hashes (memoized per project; dropped on approve, revoke and any
//   `project.changed` of the project).
// - `list`: the items of a fresh scan (at most `LIMITS.trustItemsMax`) with their state; `changed` = a pending item
//   whose kind and label match an approved row whose hash the scan no longer finds; `orphaned` = approved rows the scan
//   no longer finds (0 while the folder is unavailable).
// - `approve` (fresh auth through `options.requireFreshAuth` and the route table): a fresh scan; any requested hash that
//   is not a current item of that kind → 409 `conflict` `stale`, nothing written; else one multi-row insert (kind,
//   label).
// - `revoke` (idempotent): deletes the hash, then, when the fresh scan is complete (the folder opened and every command
//   file loaded), the project's orphaned rows.
// - Events: approve and revoke emit `project-trust.changed { projectId, pending }` and `hooks.changed { projectId }`; a
//   list whose pending count differs from the last one announced emits `project-trust.changed`; a deleted project emits
//   `project-trust.changed { projectId, pending: 0 }` (its rows went with it: foreign key). The project MCP manager
//   reacts to the event (it is never called from here).
// - Approve and revoke of one project run one at a time. Approvals are never in backups or exports and survive
//   delete-all. Logging: ids, counts, kinds and hash prefixes only (never a command, a URL or a variable name).
import type { ProjectTrustList, ServerEvent, TrustApproval } from '@harness-forge/shared'
import type { Logger } from '../../logger.ts'
import type { AppDeps } from '../../types.ts'
import type { CustomizationCatalog } from '../customizations/types.ts'
import type { ProjectCommandItem, ProjectTrustScanItem } from './items.ts'
import type { ProjectTrustService } from './types.ts'
import { HarnessError, LIMITS, planCommandExpansion } from '@harness-forge/shared'
import { and, eq, inArray } from 'drizzle-orm'
import { projects, projectTrust } from '../../db/schema.ts'
import { databaseError, guardDb, isConstraintError } from '../chats/db-errors.ts'
import { commandTrustSubject, commandWarnings } from '../project-config/index.ts'
import { trustItemDto } from './items.ts'

export type { ProjectCommandItem, ProjectTrustScanItem } from './items.ts'
export { trustItemDto } from './items.ts'

/** Message of the 409 `stale` answer. */
export const TRUST_STALE_MESSAGE = 'The project files changed while you reviewed them. Review them again.'
/** Projects whose approved set is memoized at most. */
const MEMO_PROJECTS_MAX = 200
const LABEL_MAX_CHARS = 200
const ISSUE_MAX_CHARS = 500
/** Command names of the trust DTO. */
const COMMAND_NAME_MAX_CHARS = 64

/** Test options of the service (all optional). */
export interface ProjectTrustServiceOptions {
  /** The clock of `created_at` (epoch ms); default `Date.now`. */
  readonly now?: () => number
}

/** One scan of a project folder: every executable item (uncapped). */
interface Scan {
  readonly available: boolean
  readonly issue: string | null
  readonly scannedAt: number
  readonly items: readonly ProjectTrustScanItem[]
  /** The folder opened and every command file was loaded: orphaned rows may be removed. */
  readonly complete: boolean
}

interface CommandScan {
  readonly items: readonly ProjectCommandItem[]
  readonly complete: boolean
}

interface TrustRow {
  readonly sha256: string
  readonly kind: string
  readonly label: string
}

function staleError(): HarnessError {
  return new HarnessError({ code: 'conflict', message: TRUST_STALE_MESSAGE, details: { reason: 'stale' } })
}

function projectNotFound(projectId: string): HarnessError {
  return new HarnessError({ code: 'not_found', message: `Project ${projectId} not found.` })
}

export function createProjectTrustService(deps: AppDeps, options: ProjectTrustServiceOptions = {}): ProjectTrustService {
  const now = options.now ?? (() => Date.now())
  let logger: Logger | undefined
  const log = (): Logger => (logger ??= deps.logger.child({ component: 'project-trust' }))
  const memo = new Map<string, Promise<ReadonlySet<string>>>()
  /** The pending count last announced per project (a list that finds another count announces it). */
  const announced = new Map<string, number>()
  const commandScans = new WeakMap<CustomizationCatalog, { root: string, scan: Promise<CommandScan> }>()
  const locks = new Map<string, Promise<unknown>>()
  let subscribed = false

  // ---------- events ----------

  function emitChanged(projectId: string, pending: number, hooks: boolean): void {
    remember(projectId, pending)
    try {
      deps.events.emit('project-trust.changed', { projectId, pending })
      if (hooks)
        deps.events.emit('hooks.changed', { projectId })
    }
    catch (error) {
      log().warn('project-trust.changed not sent', { projectId, err: error })
    }
  }

  function remember(projectId: string, pending: number): void {
    announced.delete(projectId)
    announced.set(projectId, pending)
    for (const key of announced.keys()) {
      if (announced.size <= MEMO_PROJECTS_MAX)
        break
      announced.delete(key)
    }
  }

  function onEvent(event: ServerEvent): void {
    if (event.type !== 'project.changed')
      return
    const projectId = event.data.id
    memo.delete(projectId)
    if (event.data.project === null) {
      announced.delete(projectId)
      // After the delivery of `project.changed` (never re-entrant).
      queueMicrotask(() => {
        try {
          deps.events.emit('project-trust.changed', { projectId, pending: 0 })
        }
        catch (error) {
          log().debug('project-trust.changed not sent', { projectId, err: error })
        }
      })
    }
  }

  function subscribe(): void {
    if (subscribed)
      return
    subscribed = true
    deps.events.subscribe(onEvent)
  }

  // ---------- storage ----------

  async function rowsOf(projectId: string): Promise<TrustRow[]> {
    return guardDb(() => deps.db
      .select({ sha256: projectTrust.sha256, kind: projectTrust.kind, label: projectTrust.label })
      .from(projectTrust)
      .where(eq(projectTrust.projectId, projectId)))
  }

  async function requireProject(projectId: string): Promise<void> {
    const [row] = await guardDb(() => deps.db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).limit(1))
    if (row === undefined)
      throw projectNotFound(projectId)
  }

  function approvedSet(projectId: string): Promise<ReadonlySet<string>> {
    subscribe()
    let pending = memo.get(projectId)
    if (pending === undefined) {
      pending = rowsOf(projectId).then(rows => new Set(rows.map(row => row.sha256)))
      memo.set(projectId, pending)
      // A failed read is never kept.
      pending.catch(() => {
        if (memo.get(projectId) === pending)
          memo.delete(projectId)
      })
      for (const key of memo.keys()) {
        if (memo.size <= MEMO_PROJECTS_MAX)
          break
        memo.delete(key)
      }
    }
    return pending
  }

  /** Runs the writes of one project one at a time. */
  function withLock<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const previous = locks.get(projectId) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(operation)
    const settled = next.catch(() => {})
    locks.set(projectId, settled)
    void settled.then(() => {
      if (locks.get(projectId) === settled)
        locks.delete(projectId)
    })
    return next
  }

  // ---------- scans ----------

  async function loadCommands(catalog: CustomizationCatalog, root: string): Promise<CommandScan> {
    let complete = catalog.project?.available !== false
    const items: ProjectCommandItem[] = []
    const refMemo = new Map<string, Promise<string | null>>()
    const entries = catalog.entries.filter(entry => entry.kind === 'command' && entry.source === 'project' && entry.state === 'active' && entry.path !== undefined)
    for (const entry of entries) {
      let body: string
      try {
        const loaded = await deps.customizations.load(entry)
        if (loaded.definition.kind !== 'command')
          continue
        body = loaded.definition.fields.body
      }
      catch (error) {
        complete = false
        log().debug('project trust: command file not loaded', { name: entry.name, err: error })
        continue
      }
      const spans = planCommandExpansion(body).shellCommands
      if (spans.length === 0)
        continue
      if (entry.name.length > COMMAND_NAME_MAX_CHARS || spans.some(span => span.length > LIMITS.hookCommandMaxChars)) {
        log().debug('project trust: command file not listed (too long to show)', { name: entry.name })
        continue
      }
      const subject = await commandTrustSubject(root, entry.name, spans, { memo: refMemo })
      const hashItem = subject.hashItem as ProjectCommandItem['hashItem']
      items.push(Object.freeze({
        kind: 'command',
        sha256: subject.sha256,
        hashItem,
        path: entry.path!,
        label: `/${entry.name}`.slice(0, LABEL_MAX_CHARS),
        warnings: commandWarnings(spans, hashItem.refs),
        name: entry.name,
        spans: Object.freeze([...spans]),
      }))
    }
    return { items, complete }
  }

  async function commandScan(projectId: string, root: string, refresh: boolean): Promise<CommandScan> {
    let catalog: CustomizationCatalog
    try {
      catalog = await deps.customizations.catalog(projectId, { refresh })
    }
    catch (error) {
      log().debug('project trust: catalog not read', { projectId, err: error })
      return { items: [], complete: false }
    }
    const known = commandScans.get(catalog)
    if (known !== undefined && known.root === root)
      return known.scan
    const scan = loadCommands(catalog, root)
    commandScans.set(catalog, { root, scan })
    return scan
  }

  async function scanProject(projectId: string, refresh: boolean): Promise<Scan> {
    const snapshot = await deps.projectConfig.snapshot(projectId, { refresh })
    if (!snapshot.available || snapshot.root === null)
      return { available: false, issue: snapshot.issue, scannedAt: snapshot.scannedAt, items: [], complete: false }
    const commands = await commandScan(projectId, snapshot.root, refresh)
    return {
      available: true,
      issue: null,
      scannedAt: snapshot.scannedAt,
      items: [...snapshot.hooks, ...snapshot.mcpServers, ...commands.items],
      complete: commands.complete,
    }
  }

  function pendingOf(scan: Scan, approved: ReadonlySet<string>): number {
    return scan.items.filter(item => !approved.has(item.sha256)).length
  }

  function listOf(scan: Scan, rows: readonly TrustRow[]): ProjectTrustList {
    const approved = new Set(rows.map(row => row.sha256))
    const current = new Set(scan.items.map(item => item.sha256))
    const orphans = scan.available ? rows.filter(row => !current.has(row.sha256)) : []
    const items = scan.items.slice(0, LIMITS.trustItemsMax).map((item) => {
      const isApproved = approved.has(item.sha256)
      const changed = !isApproved && orphans.some(row => row.kind === item.kind && row.label === item.label)
      return trustItemDto(item, isApproved ? 'approved' : 'pending', changed)
    })
    return {
      items,
      orphaned: orphans.length,
      scannedAt: scan.scannedAt,
      available: scan.available,
      ...(scan.issue === null ? {} : { issue: scan.issue.slice(0, ISSUE_MAX_CHARS) }),
    }
  }

  // ---------- the service ----------

  return {
    approved: async projectId => approvedSet(projectId),

    list: async (projectId) => {
      subscribe()
      await requireProject(projectId)
      const scan = await scanProject(projectId, true)
      const rows = await rowsOf(projectId)
      const pending = pendingOf(scan, new Set(rows.map(row => row.sha256)))
      const last = announced.get(projectId)
      if (last !== undefined && last !== pending)
        emitChanged(projectId, pending, false)
      else
        remember(projectId, pending)
      return listOf(scan, rows)
    },

    approve: async (projectId, approvals: readonly TrustApproval[], sensitive) => {
      sensitive?.requireFreshAuth()
      subscribe()
      await requireProject(projectId)
      return withLock(projectId, async () => {
        const scan = await scanProject(projectId, true)
        const byHash = new Map(scan.items.map(item => [item.sha256, item]))
        if (approvals.some(approval => byHash.get(approval.sha256)?.kind !== approval.kind)) {
          log().info('project trust: approval refused (stale)', { projectId, items: approvals.length })
          throw staleError()
        }
        const createdAt = now()
        try {
          await deps.db.insert(projectTrust).values(approvals.map(approval => ({
            projectId,
            sha256: approval.sha256,
            kind: approval.kind,
            label: byHash.get(approval.sha256)!.label,
            createdAt,
          }))).onConflictDoNothing()
        }
        catch (error) {
          // The project was deleted meanwhile (foreign key).
          if (isConstraintError(error))
            throw projectNotFound(projectId)
          throw databaseError(error)
        }
        memo.delete(projectId)
        const rows = await rowsOf(projectId)
        const kinds: Record<string, number> = {}
        for (const approval of approvals)
          kinds[approval.kind] = (kinds[approval.kind] ?? 0) + 1
        log().info('project items approved', { projectId, items: approvals.length, kinds })
        emitChanged(projectId, pendingOf(scan, new Set(rows.map(row => row.sha256))), true)
        return listOf(scan, rows)
      })
    },

    revoke: async (projectId, sha256) => {
      subscribe()
      await requireProject(projectId)
      return withLock(projectId, async () => {
        await guardDb(() => deps.db.delete(projectTrust).where(and(eq(projectTrust.projectId, projectId), eq(projectTrust.sha256, sha256))))
        memo.delete(projectId)
        const scan = await scanProject(projectId, true)
        let rows = await rowsOf(projectId)
        let orphansRemoved = 0
        if (scan.available && scan.complete) {
          const current = new Set(scan.items.map(item => item.sha256))
          const orphans = rows.filter(row => !current.has(row.sha256)).map(row => row.sha256)
          if (orphans.length > 0) {
            await guardDb(() => deps.db.delete(projectTrust).where(and(eq(projectTrust.projectId, projectId), inArray(projectTrust.sha256, orphans))))
            rows = rows.filter(row => !orphans.includes(row.sha256))
            orphansRemoved = orphans.length
          }
        }
        memo.delete(projectId)
        log().info('project item approval revoked', { projectId, sha256: sha256.slice(0, 12), orphansRemoved })
        emitChanged(projectId, pendingOf(scan, new Set(rows.map(row => row.sha256))), true)
        return listOf(scan, rows)
      })
    },

    pending: async (projectId) => {
      try {
        const [scan, approved] = await Promise.all([scanProject(projectId, false), approvedSet(projectId)])
        const pending = pendingOf(scan, approved)
        remember(projectId, pending)
        return pending
      }
      catch (error) {
        log().debug('project trust: pending count failed', { projectId, err: error })
        return 0
      }
    },
  }
}
