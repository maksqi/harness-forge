// The hook service (Phase 11, ADR-048; ARCHITECTURE.md 6.28; API.md 4.31 / 5.31) behind `HookService` (./types.ts).
// Owner: W11.1 (C36 landed the stub with the final factory signature).
//
// C36 stub (P11-0b): nothing runs. `snapshot` answers an empty snapshot (`has()` false, `run()` "nothing ran");
// `list` answers the personal rows of the `hooks` table (run order: oldest first) with their states and the kill
// switches (`switches`; with `projectId` the project's scan from `projectConfig.snapshot`, no project items yet, an
// unknown project is `not_found`); `create` / `update` / `remove` reject with `not_implemented`; `runs` answers `[]`;
// `invalidate` and `stop` are no-ops. W11.1 implements the sources, the runner, the personal CRUD and the run log.
import type { HookEntry, HookEvent, HookList, HookProjectScan, HooksQuery, HookSwitches } from '@harness-forge/shared'
import type { HookRow } from '../../db/schema.ts'
import type { AppDeps } from '../../types.ts'
import type { HookEventResult, HookRunInput, HookRunOptions, HookScope, HookService, HookSnapshot } from './types.ts'
import { compileMatcher } from '@harness-forge/shared'
import { asc } from 'drizzle-orm'
import { hooks } from '../../db/schema.ts'
import { noopAsync, rejectsNotImplemented } from '../../not-implemented.ts'
import { guardDb } from '../chats/db-errors.ts'

/** The result of an event for which no hook ran. */
export const NOTHING_RAN: HookEventResult = Object.freeze({
  ran: false,
  decision: null,
  reason: null,
  context: null,
  block: false,
  continue: true,
  stopReason: null,
  record: null,
})

/** Throws the signal's reason when it is aborted (`AbortSignal.throwIfAborted`, also for a missing signal). */
function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted()
}

/** A snapshot without any hook: `has()` is false for every event and `run()` answers `NOTHING_RAN`. */
export function emptyHookSnapshot(scope: HookScope): HookSnapshot {
  return Object.freeze({
    scope,
    has: (_event: HookEvent) => false,
    run: async (_event: HookEvent, _input: HookRunInput, options: HookRunOptions) => {
      throwIfAborted(options.signal)
      return NOTHING_RAN
    },
  })
}

/** The kill switches of command hooks: the setting, `HF_WORKSPACE_SHELL`, `HF_SAFE_MODE`. */
export async function hookSwitches(deps: Pick<AppDeps, 'settings' | 'env'>): Promise<HookSwitches> {
  const settings = await deps.settings.get()
  return { setting: settings.hooksEnabled, shell: deps.env.workspaceShell, safeMode: deps.env.safeMode }
}

/** Command hooks may run under these switches. */
export function commandHooksAllowed(switches: HookSwitches): boolean {
  return switches.setting && switches.shell && !switches.safeMode
}

/** A personal row as a `GET /hooks` entry: `off` when disabled, `invalid` with a bad matcher, `blocked` by a switch. */
export function personalHookEntry(row: Pick<HookRow, 'id' | 'event' | 'matcher' | 'command' | 'timeout' | 'enabled'>, allowed: boolean): HookEntry {
  const compiled = compileMatcher(row.matcher)
  const state = !row.enabled ? 'off' : !compiled.ok ? 'invalid' : allowed ? 'active' : 'blocked'
  return {
    kind: 'command',
    key: `personal:${row.id}`,
    source: 'personal',
    state,
    id: row.id,
    event: row.event,
    matcher: row.matcher,
    command: row.command,
    timeout: row.timeout,
    diagnostics: compiled.ok
      ? []
      : [{ level: 'error', code: 'invalid-matcher', message: `Invalid matcher: ${compiled.reason}`, event: row.event }],
  }
}

export function createHookService(deps: AppDeps): HookService {
  async function projectScan(projectId: string): Promise<HookProjectScan> {
    // `not_found` for an unknown project (the route answers 404).
    await deps.projects.get(projectId)
    const scan = await deps.projectConfig.snapshot(projectId)
    return {
      id: projectId,
      available: scan.available,
      ...(scan.issue === null ? {} : { issue: scan.issue }),
      files: [...scan.settingsFiles],
      pending: 0,
      scannedAt: scan.scannedAt,
    }
  }

  async function list(query: HooksQuery): Promise<HookList> {
    const project = query.projectId === undefined ? undefined : await projectScan(query.projectId)
    const switches = await hookSwitches(deps)
    const rows = await guardDb(() => deps.db.select().from(hooks).orderBy(asc(hooks.createdAt), asc(hooks.id)))
    const allowed = commandHooksAllowed(switches)
    return {
      items: rows.map(row => personalHookEntry(row, allowed)),
      diagnostics: [],
      switches,
      ...(project === undefined ? {} : { project }),
    }
  }

  return {
    snapshot: async (scope, options) => {
      throwIfAborted(options?.signal)
      return emptyHookSnapshot(scope)
    },
    list,
    create: rejectsNotImplemented('Creating a personal hook'),
    update: rejectsNotImplemented('Changing a personal hook'),
    remove: rejectsNotImplemented('Deleting a personal hook'),
    runs: () => [],
    invalidate: () => {},
    stop: noopAsync,
  }
}
