// The home-folder import (Phase 12, ADR-055; API.md 5.35, ARCHITECTURE.md 6.35) behind `ClaudeImportService`
// (./types.ts). W12.3 implements the C43 stub:
//
// - `home()`: one `stat` of `env.claudeHome` (never a file read);
// - `scan()` (fresh auth): `HF_CLAUDE_HOME=0` → 409 `disabled`; ./collect-disk.ts reads the allowlist (10 s deadline;
//   aborted by `stop()`: 409 `busy`, nothing kept), then a plan is built and kept;
// - `upload()`: ./collect-upload.ts (folder files or a zip, plus `~/.claude.json`), then a plan is built and kept;
// - `apply()` (fresh auth): ./apply.ts against the kept plan (404 when it is unknown or expired; dropped once applied).
//
// A plan is the shared `planClaudeImport(files, baseline)` over the collected files and a fresh baseline
// (./baseline.ts); the answer is its DTO without payloads (`planDto`): contents and env / header values never leave the
// server. Plans live in ./plans.ts (10 minutes, at most 4; dropped on apply, expiry, `key.rotated` and `stop()`).
// Logging: `info` = the source, the counts and the duration; the root path only at `debug`; never a content, a command,
// a prompt or a value.
import type { Disposable } from '@harness-forge/plugin-sdk'
import type { ClaudeHomeFile, ClaudeImportHome, ClaudeImportPlan, ClaudeImportPlanDraft, ClaudeImportPlanItem, ClaudeImportPlanItemDto } from '@harness-forge/shared'
import type { Env } from '../../env.ts'
import type { AppDeps } from '../../types.ts'
import type { CollectDiskOptions, DiskFs } from './collect-disk.ts'
import type { CollectedHome, CollectedSkip } from './collected.ts'
import type { PlanStore } from './plans.ts'
import type { ClaudeImportService } from './types.ts'
import { stat } from 'node:fs/promises'
import { createImportPlanId, HarnessError, LIMITS, planClaudeImport } from '@harness-forge/shared'
import { applyClaudeImport, checkApplyBody } from './apply.ts'
import { buildClaudeImportBaseline } from './baseline.ts'
import { collectDiskHome } from './collect-disk.ts'
import { collectUpload } from './collect-upload.ts'
import { createPlanStore } from './plans.ts'

/** `stat` errors that mean "nothing there" (a missing folder, or a file on the way). */
const MISSING_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR'])

/** Diagnostics of an item DTO (`claudeImportPlanItemSchema`). */
const ITEM_DIAGNOSTICS_MAX = 50
/** Characters of the plan's `root`. */
const ROOT_MAX_CHARS = LIMITS.workspacePathMaxChars

/**
 * `GET /claude-import/home` (ADR-055): whether the import scan can read `env.claudeHome`. One `stat` of the folder
 * (links followed: a dotfile manager may link `~/.claude`); no file is opened and nothing is listed.
 */
export async function claudeImportHome(env: Pick<Env, 'claudeHome'>): Promise<ClaudeImportHome> {
  const path = env.claudeHome
  if (path === null)
    return { available: false, reason: 'disabled', path: null }
  try {
    const info = await stat(path)
    return info.isDirectory() ? { available: true, path } : { available: false, reason: 'missing', path }
  }
  catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    return { available: false, reason: code !== undefined && MISSING_CODES.has(code) ? 'missing' : 'unreadable', path }
  }
}

/** The 409 of a scan while `HF_CLAUDE_HOME=0`. */
export function scanDisabledError(): HarnessError {
  return new HarnessError({
    code: 'conflict',
    message: 'Scanning a Claude Code folder on the server is turned off (HF_CLAUDE_HOME=0). Upload the folder instead.',
    details: { reason: 'disabled' },
  })
}

/**
 * The 409 of a scan stopped by `stop()` (shutdown) while it read the folder: `details.reason: 'busy'` (W12.18-T3; the
 * conflict details need a reason). Nothing is kept.
 */
export function scanStoppedError(): HarnessError {
  return new HarnessError({
    code: 'conflict',
    message: 'The scan of the Claude Code folder was stopped.',
    details: { reason: 'busy' },
  })
}

/** The 404 of an unknown or expired plan. */
export function planExpiredError(): HarnessError {
  return new HarnessError({ code: 'not_found', message: 'The import plan expired. Read the folder again.' })
}

/** An item without its payload (what the browser sees). */
function itemDto(item: ClaudeImportPlanItem): ClaudeImportPlanItemDto {
  return {
    key: item.key,
    kind: item.kind,
    name: item.name,
    source: item.source.project === undefined ? { file: item.source.file } : { file: item.source.file, project: item.source.project },
    status: item.status,
    actions: [...item.actions],
    defaultAction: item.defaultAction,
    ...(item.renameTo === undefined ? {} : { renameTo: item.renameTo }),
    summary: item.summary,
    warnings: [...item.warnings],
    diagnostics: item.diagnostics.slice(0, ITEM_DIAGNOSTICS_MAX).map(entry => ({ level: entry.level, code: entry.code, message: entry.message })),
    ...(item.variables === undefined ? {} : { variables: [...item.variables] }),
    executable: item.executable,
  }
}

function comparePaths(a: CollectedSkip, b: CollectedSkip): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0
}

export interface PlanDtoInput {
  readonly id: string
  readonly source: ClaudeImportPlan['source']
  readonly root: string
  readonly createdAt: number
  readonly ttlMs: number
  readonly collected: CollectedHome
  readonly draft: ClaudeImportPlanDraft
}

/**
 * The answer of a scan or an upload: the planner's items without payloads, the skipped files of the intake and of the
 * planner (sorted, at most `LIMITS.claudeImportSkippedMax`), the diagnostics of both (at most 200). Never a content or
 * a value: the env values of the draft stay out.
 */
export function planDto(input: PlanDtoInput): ClaudeImportPlan {
  const skippedAll = [...input.collected.skipped, ...input.draft.skipped].sort(comparePaths)
  const diagnostics = [...input.collected.diagnostics, ...input.draft.diagnostics].map(entry => ({ level: entry.level, code: entry.code, message: entry.message }))
  if (skippedAll.length > LIMITS.claudeImportSkippedMax)
    diagnostics.push({ level: 'info', code: 'too-many', message: `${skippedAll.length - LIMITS.claudeImportSkippedMax} more files were skipped.` })
  return {
    id: input.id,
    source: input.source,
    root: input.root.length <= ROOT_MAX_CHARS ? input.root : `${input.root.slice(0, ROOT_MAX_CHARS - 3)}...`,
    createdAt: input.createdAt,
    expiresAt: input.createdAt + input.ttlMs,
    items: input.draft.items.slice(0, LIMITS.claudeImportItemsMax).map(itemDto),
    skipped: skippedAll.slice(0, LIMITS.claudeImportSkippedMax).map(entry => ({ path: entry.path, reason: entry.reason.slice(0, 300) })),
    diagnostics: diagnostics.slice(0, 200),
  }
}

/** Test seams of the service (the production factory passes none). */
export interface ClaudeImportServiceOptions {
  /** Clock of the plans (epoch ms; default `Date.now`). */
  readonly now?: () => number
  /** The file system calls of the scan (tests watch every `open`). */
  readonly fs?: DiskFs
  /** The scan deadline in milliseconds (default `LIMITS.claudeImportScanTimeoutMs`). */
  readonly scanTimeoutMs?: number
}

export function createClaudeImportService(deps: AppDeps, options: ClaudeImportServiceOptions = {}): ClaudeImportService {
  const now = options.now ?? Date.now
  const plans: PlanStore = createPlanStore({ max: LIMITS.claudeImportPlansMax, now })
  const scans = new Set<AbortController>()
  let subscription: Disposable | null = null

  /** Drops every plan on a master-key rotation (subscribed with the first kept plan). */
  function subscribe(): void {
    if (subscription !== null)
      return
    subscription = deps.events.subscribe((event) => {
      if (event.type === 'key.rotated')
        plans.clear()
    })
  }

  async function keep(source: ClaudeImportPlan['source'], root: string, collected: CollectedHome, started: number): Promise<ClaudeImportPlan> {
    const baseline = await buildClaudeImportBaseline(deps)
    const draft = planClaudeImport(collected.files, baseline)
    const createdAt = now()
    const dto = planDto({ id: createImportPlanId(), source, root, createdAt, ttlMs: LIMITS.claudeImportPlanTtlMs, collected, draft })
    const files: ClaudeHomeFile[] = collected.files.map(file => ({ ...file }))
    subscribe()
    plans.put({ dto, files })
    deps.logger.info('claude import planned', {
      source,
      files: files.length,
      items: dto.items.length,
      skipped: dto.skipped.length,
      durationMs: Date.now() - started,
    })
    return dto
  }

  const service: ClaudeImportService = {
    home: () => claudeImportHome(deps.env),

    scan: async (sensitive) => {
      sensitive?.requireFreshAuth()
      const root = deps.env.claudeHome
      if (root === null)
        throw scanDisabledError()
      const started = Date.now()
      deps.logger.debug('claude import scan', { root })
      const controller = new AbortController()
      scans.add(controller)
      try {
        const collect: CollectDiskOptions = {
          root,
          dataDir: deps.env.dataDir,
          signal: controller.signal,
          ...(options.scanTimeoutMs === undefined ? {} : { timeoutMs: options.scanTimeoutMs }),
          ...(options.fs === undefined ? {} : { fs: options.fs }),
        }
        let collected: CollectedHome
        try {
          collected = await collectDiskHome(collect)
        }
        catch (error) {
          // The collector's own "stopped" error has no reason: a stopped scan always answers `scanStoppedError()`.
          if (controller.signal.aborted)
            throw scanStoppedError()
          throw error
        }
        if (controller.signal.aborted)
          throw scanStoppedError()
        return await keep('scan', root, collected, started)
      }
      finally {
        scans.delete(controller)
      }
    },

    upload: async (input) => {
      const started = Date.now()
      const collected = await collectUpload(input)
      return keep('upload', input.label ?? '.claude', collected, started)
    },

    apply: async (body, sensitive) => {
      sensitive?.requireFreshAuth()
      const held = plans.get(body.planId)
      if (held === undefined)
        throw planExpiredError()
      checkApplyBody(held.dto, body)
      if (plans.take(body.planId) === undefined)
        throw planExpiredError()
      return applyClaudeImport(deps, { files: held.files, body, ...(sensitive === undefined ? {} : { options: sensitive }) })
    },

    stop: async () => {
      for (const controller of scans)
        controller.abort()
      scans.clear()
      plans.clear()
      const current = subscription
      subscription = null
      try {
        current?.dispose()
      }
      catch {
        // A bus that already stopped: nothing to remove.
      }
    },
  }
  return Object.freeze(service)
}
