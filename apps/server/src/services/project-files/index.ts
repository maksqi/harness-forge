// Project files service (Phase 9, ADR-042, ARCHITECTURE.md 6.21, API.md 4.27 / 5.27): the per-project file index and
// the attach of `@` mentions behind `ProjectFileService` (./types.ts). Owner: W9.6.
//
// - Every call opens the project through `projects.openWorkspace` (checked again each time): an unknown project is
//   `not_found` ("Project <id> not found."), a folder that cannot be opened `validation_error` with the `openWorkspace`
//   message (and its index is dropped).
// - `search`: the project's index (./file-index.ts, cached by ./cache.ts: lazy, single-flight, 30 s TTL, at most
//   `MENTION_INDEX_PROJECTS_MAX` projects) ranked by the shared `rankPaths(q, entries, limit)`; `truncated` is set when
//   more entries matched than `limit` or the index was cut (at `LIMITS.mentionIndexFilesMax` files or by the walk
//   limits), `indexedAt` when its build started.
// - `attach`: ./attach.ts reads the file through the path guard (`.git`, secret-looking paths, links out of the root and
//   folders refused; > 5 MiB is 413), then `files.upload(new File([bytes], name))` sniffs the type and pins the file.
// - Invalidation: the first search subscribes to the event bus; an index is dropped on `workspace.changed` of its
//   project (agent writes, rewind, revert, undo), on `project.changed` (edit or deletion) and when a run of a chat of the
//   project finishes (`run.finished`: shell commands write without `workspace.changed`, and the tool event is coalesced
//   for up to a second, so the search after a run sees what it wrote).
// - `stop()` (shutdown, after the runs): aborts the walks in flight, clears every index and timer and removes the
//   subscription; idempotent, never throws.
// - Logging: counts and durations at `debug` only; never a query, a path or file content (Phase 9 logging rule).
import type { Disposable } from '@harness-forge/plugin-sdk'
import type { ServerEvent } from '@harness-forge/shared'
import type { Logger } from '../../logger.ts'
import type { AppDeps } from '../../types.ts'
import type { OpenWorkspace } from '../projects/types.ts'
import type { ProjectWalk } from './file-index.ts'
import type { ProjectFileService } from './types.ts'
import { HarnessError, LIMITS, rankPaths, validationError } from '@harness-forge/shared'
import { walkWorkspace } from '../../workspace/walk.ts'
import { readMentionedFile } from './attach.ts'
import { createProjectIndexCache, MENTION_INDEX_PROJECTS_MAX } from './cache.ts'
import { buildProjectFileIndex } from './file-index.ts'

export { MENTION_INDEX_PROJECTS_MAX } from './cache.ts'

/** Test seams of `createProjectFileService` (production uses the defaults). */
export interface ProjectFileServiceOptions {
  /** The walker (default `walkWorkspace`). */
  walk?: ProjectWalk
  /** Files kept per index (default `LIMITS.mentionIndexFilesMax`). */
  maxFiles?: number
  /** Index lifetime (default `LIMITS.mentionIndexTtlMs`). */
  ttlMs?: number
  /** Indexes kept at most (default `MENTION_INDEX_PROJECTS_MAX`). */
  maxProjects?: number
  /** Attach size cap (default `LIMITS.mentionFileMaxBytes`). */
  maxAttachBytes?: number
  /** Clock (default `Date.now`, read at every call). */
  now?: () => number
}

function projectNotFound(projectId: string): HarnessError {
  return new HarnessError({ code: 'not_found', message: `Project ${projectId} not found.` })
}

export function createProjectFileService(deps: AppDeps, options: ProjectFileServiceOptions = {}): ProjectFileService {
  const now = options.now ?? (() => Date.now())
  const walk = options.walk ?? walkWorkspace
  const maxFiles = options.maxFiles ?? LIMITS.mentionIndexFilesMax
  const maxAttachBytes = options.maxAttachBytes ?? LIMITS.mentionFileMaxBytes
  let logger: Logger | undefined
  const log = (): Logger => (logger ??= deps.logger.child({ component: 'project-files' }))
  let subscription: Disposable | undefined

  const cache = createProjectIndexCache({
    ttlMs: options.ttlMs ?? LIMITS.mentionIndexTtlMs,
    maxProjects: options.maxProjects ?? MENTION_INDEX_PROJECTS_MAX,
    now,
    build: async (root, signal) => buildProjectFileIndex(root, { maxFiles, walk, signal, now }),
  })

  function invalidate(projectId: string): void {
    try {
      cache.invalidate(projectId)
    }
    catch (error) {
      log().warn('project file index not dropped', { projectId, err: error })
    }
  }

  /** Drops the index of the chat's project when one of its runs finished (the lookup only runs while indexes exist). */
  async function onRunFinished(chatId: string): Promise<void> {
    if (cache.projects().length === 0)
      return
    try {
      const chat = await deps.chats.find(chatId)
      if (chat !== null && chat.projectId !== null)
        invalidate(chat.projectId)
    }
    catch (error) {
      log().debug('project file index: chat lookup failed', { chatId, err: error })
    }
  }

  function onEvent(event: ServerEvent): void {
    if (event.type === 'workspace.changed')
      invalidate(event.data.projectId)
    else if (event.type === 'project.changed')
      invalidate(event.data.id)
    else if (event.type === 'run.finished')
      void onRunFinished(event.data.chatId)
  }

  function subscribe(): void {
    subscription ??= deps.events.subscribe(onEvent)
  }

  async function openProject(projectId: string): Promise<OpenWorkspace> {
    const opened = await deps.projects.openWorkspace(projectId)
    if (opened.ok)
      return opened.workspace
    invalidate(projectId)
    if (opened.name === null)
      throw projectNotFound(projectId)
    throw validationError([{ path: [], message: opened.message, code: 'custom' }], opened.message)
  }

  return {
    search: async (projectId, query) => {
      const workspace = await openProject(projectId)
      subscribe()
      const cachedBefore = cache.cached().includes(projectId)
      const index = await cache.get(projectId, workspace.root)
      const limit = Math.min(Math.max(1, Math.floor(query.limit)), LIMITS.mentionResultsMax)
      const ranked = rankPaths(query.q.slice(0, LIMITS.mentionQueryMaxChars), index.entries, limit)
      log().debug('project files searched', {
        projectId,
        queryChars: query.q.length,
        items: ranked.items.length,
        files: index.files,
        entries: index.entries.length,
        truncated: index.truncated,
        cached: cachedBefore,
        buildMs: index.durationMs,
      })
      return {
        items: ranked.items.map(item => ({ path: item.path, kind: item.kind })),
        truncated: ranked.truncated || index.truncated,
        indexedAt: index.indexedAt,
      }
    },
    attach: async (projectId, body) => {
      const workspace = await openProject(projectId)
      const file = await readMentionedFile(workspace.root, body.path, maxAttachBytes)
      const ref = await deps.files.upload(new File([file.bytes], file.name))
      log().debug('project file attached', { projectId, fileId: ref.id, size: ref.size, mime: ref.mime })
      return ref
    },
    invalidate,
    stop: () => {
      try {
        subscription?.dispose()
      }
      catch (error) {
        log().warn('project file index: unsubscribe failed', { err: error })
      }
      subscription = undefined
      try {
        cache.stop()
      }
      catch (error) {
        log().warn('project file index: stop failed', { err: error })
      }
    },
  }
}
