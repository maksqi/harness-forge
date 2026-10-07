// `SessionEnd` (Phase 12, ADR-057; ARCHITECTURE.md 6.37). Owner: W12.5.
//
// `HookService.sessionEnd(chat)` runs the `SessionEnd` hooks of a chat the user deleted (`DELETE /chats/:id` only; never
// delete-all, a project delete or shutdown), `reason: 'other'`: a snapshot of the chat's scope (its project's folder
// opened by the service, its tool mode, its model, origin `request`) whose `SessionEnd` handlers run detached from the
// request within a budget of `LIMITS.sessionEndBudgetMs` (1.5 s), raised by the explicit timeouts of the matching
// handlers up to `LIMITS.sessionEndBudgetMaxMs` (60 s); when the budget ends, the running processes are killed. The
// service tracks the run (its `stop()` kills it and waits) and does nothing once stopped. The chat is gone, so the
// payload has no transcript. Failures are logged (never the command or the payload); the promise never rejects.
import type { ChatSettings, ToolMode } from '@harness-forge/shared'
import type { Logger } from '../../logger.ts'
import type { AppDeps } from '../../types.ts'
import type { SnapshotHook } from './snapshot.ts'
import type { HookScope, HookSnapshot, SessionEndChat } from './types.ts'
import { LIMITS } from '@harness-forge/shared'
import { hookMatches } from './snapshot.ts'

/** The `reason` of a `SessionEnd` of a single chat delete. */
export const SESSION_END_REASON = 'other'

/**
 * The time the `SessionEnd` hooks get: `LIMITS.sessionEndBudgetMs`, raised by the explicit timeout of every matching
 * handler, at most `LIMITS.sessionEndBudgetMaxMs`.
 */
export function sessionEndBudgetMs(hooks: readonly SnapshotHook[]): number {
  let budget: number = LIMITS.sessionEndBudgetMs
  for (const hook of hooks) {
    if (hook.event !== 'SessionEnd' || hook.timeoutSec === null || !hookMatches(hook, [SESSION_END_REASON]))
      continue
    budget = Math.max(budget, Math.ceil(hook.timeoutSec) * 1000)
  }
  return Math.min(budget, LIMITS.sessionEndBudgetMaxMs)
}

/** What a `SessionEnd` run needs from the service. */
export interface SessionEndInput {
  readonly deps: Pick<AppDeps, 'projects' | 'settings'>
  readonly logger: Logger
  readonly chat: SessionEndChat
  /** Aborted by the service's `stop()`. */
  readonly stopSignal: AbortSignal
  /** The snapshot of a scope and the handlers it holds (the service's sources). */
  readonly snapshotOf: (scope: HookScope, signal: AbortSignal) => Promise<{ readonly snapshot: HookSnapshot, readonly hooks: readonly SnapshotHook[] }>
}

/** The tool mode of a deleted chat: its own, else the default of the settings, else `ask`. */
async function toolModeOf(deps: Pick<AppDeps, 'settings'>, settings: ChatSettings | null | undefined): Promise<ToolMode> {
  if (settings?.toolMode !== undefined)
    return settings.toolMode
  try {
    return (await deps.settings.get()).defaultToolMode
  }
  catch {
    return 'ask'
  }
}

/** The model of a deleted chat: its own, else the default of the settings, else ''. */
async function modelRefOf(deps: Pick<AppDeps, 'settings'>, modelRef: string | null): Promise<string> {
  if (modelRef !== null && modelRef !== '')
    return modelRef
  try {
    return (await deps.settings.get()).defaultModelRef ?? ''
  }
  catch {
    return ''
  }
}

/** Runs the `SessionEnd` hooks of a deleted chat (see the module comment). Never rejects. */
export async function runSessionEnd(input: SessionEndInput): Promise<void> {
  const { deps, logger, chat, stopSignal } = input
  if (stopSignal.aborted)
    return
  const budget = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const signal = AbortSignal.any([budget.signal, stopSignal])
  try {
    let workspace: HookScope['workspace'] = null
    if (chat.projectId !== null) {
      const opened = await deps.projects.openWorkspace(chat.projectId)
      workspace = opened.ok ? opened.workspace : null
    }
    const scope: HookScope = {
      chatId: chat.id,
      projectId: chat.projectId,
      workspace,
      toolMode: await toolModeOf(deps, chat.settings),
      origin: 'request',
      modelRef: await modelRefOf(deps, chat.modelRef),
    }
    const { snapshot, hooks } = await input.snapshotOf(scope, signal)
    if (!snapshot.has('SessionEnd'))
      return
    const ms = sessionEndBudgetMs(hooks)
    timer = setTimeout(() => budget.abort(new DOMException('The SessionEnd hooks ran out of time.', 'TimeoutError')), ms)
    timer.unref?.()
    await snapshot.run('SessionEnd', { sessionEndReason: SESSION_END_REASON }, { signal, target: SESSION_END_REASON })
  }
  catch (error) {
    if (stopSignal.aborted)
      return
    if (budget.signal.aborted)
      logger.info('hooks: the SessionEnd hooks were stopped at the end of their time', { chatId: chat.id })
    else
      logger.warn('hooks: the SessionEnd hooks failed', { chatId: chat.id, err: error })
  }
  finally {
    clearTimeout(timer)
  }
}
