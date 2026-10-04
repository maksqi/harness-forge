// Background sub-agents (Phase 10, ADR-046; ARCHITECTURE.md 6.26): the per-runner manager behind `BackgroundTasks`
// (./types.ts). C30 stub with the final factory signature: every launch answers one `failed` output
// (`BACKGROUND_UNAVAILABLE_TEXT`), the reads answer empty, the stops answer null / 0, the lifecycle hooks are no-ops.
// W10.4 implements the manager (caps, rows, the detached child, `task.changed`, the inbox, idle delivery, the boot
// sweep) behind the same signature.
import type { TaskOutput } from '@harness-forge/shared'
import type { AppDeps } from '../../types.ts'
import type { BackgroundLaunchInput, BackgroundTasks, BackgroundTasksHost } from './types.ts'
import { BACKGROUND_UNAVAILABLE_TEXT } from './types.ts'

export { BACKGROUND_UNAVAILABLE_TEXT } from './types.ts'

/** Test and wiring options of the manager (W10.4 may add more; all optional). */
export interface BackgroundTasksOptions {
  /** The clock (epoch ms); default `Date.now`. */
  readonly now?: () => number
}

/** The `failed` output of a launch that cannot run (`error` = why), with the call's description and type. */
export function failedLaunchOutput(input: BackgroundLaunchInput, error: string, now: number): TaskOutput {
  return {
    status: 'failed',
    type: input.task.type,
    description: input.task.description,
    modelRef: input.model.modelRef,
    steps: [],
    stepsOmitted: 0,
    report: '',
    startedAt: now,
    finishedAt: now,
    error,
  }
}

/**
 * The background manager of one chat runner (created by `createChatRunnerWith`, `chat/index.ts`). `deps` and `host` are
 * read lazily (never while the manager is constructed).
 */
export function createBackgroundTasks(deps: AppDeps, host: BackgroundTasksHost, options: BackgroundTasksOptions = {}): BackgroundTasks {
  void deps
  void host
  const now = options.now ?? Date.now
  return {
    launch: async input => failedLaunchOutput(input, BACKGROUND_UNAVAILABLE_TEXT, now()),
    takeResults: () => [],
    onChatIdle: () => {},
    list: async () => [],
    stop: async () => null,
    stopChat: async () => 0,
    hasRunning: () => false,
    start: async () => {},
    stopAll: async () => {},
  }
}
