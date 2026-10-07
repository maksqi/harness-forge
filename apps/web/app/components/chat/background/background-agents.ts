// Pure helpers of the background agents list (docs/UI.md 7.29, 11.7, 14, 15; ADR-046): which tasks the dock shows, its
// collapsed summary line, the names of its toggles, the row texts and the announcements of the transitions a tab
// observed. No Vue, no stores. Signatures frozen from Gate P10-0b (C33); W10.10 owns the copy and the details.
// The UI says "background agent", never "task" (docs/UI.md 15: "Tasks" is the todo list).
import type { BackgroundTask, BackgroundTaskStatus, TaskOutput } from '@harness-forge/shared'
import { formatDuration } from '../chat-format'

/** `localStorage` key of the dock list's open state (`1` / `0`). */
export const BACKGROUND_EXPANDED_KEY = 'hf-background-expanded'

/** The footnote of the expanded list (docs/UI.md 7.29). */
export const BACKGROUND_FOOTNOTE = 'They keep running after the reply. Stop in the composer doesn\'t stop them.'

/** The toast when a Stop reaches a background agent that had already ended (docs/UI.md 7.29). */
export const BACKGROUND_GONE_MESSAGE = 'It already finished.'

/** The error toast of a failed stop (docs/UI.md 7.29). */
export const BACKGROUND_STOP_FAILED_MESSAGE = 'Could not stop the background agent'

/**
 * Phase 12 (W12.13, the P12-0a flake of `mobile/agent.spec.ts`): how long the open list keeps a row stopped from it
 * after the row ended, even when its report was delivered at once (the next step of a running reply takes a stopped
 * agent's result, so it would leave the list within milliseconds of its Stop): the Stop shows "Stopped" before the row
 * leaves.
 */
export const BACKGROUND_STOPPED_LINGER_MS = 3000

/** A task that still runs (the dock's Stop applies). */
export function isRunningTask(task: Pick<BackgroundTask, 'status'>): boolean {
  return task.status === 'running'
}

/**
 * The tasks the dock shows: running ones, and finished ones whose result was not delivered yet (`deliveredAt` null).
 * The order is kept (newest first, as the route and the store list them).
 */
export function visibleTasks(tasks: readonly BackgroundTask[]): BackgroundTask[] {
  return tasks.filter(task => isRunningTask(task) || task.deliveredAt === null)
}

function agents(count: number): string {
  return `${count} background agent${count === 1 ? '' : 's'}`
}

/**
 * The collapsed line of the dock list (docs/UI.md 7.29): "2 background agents · {latest description} · 1m 12s" while
 * some run (the newest running one, the duration of the longest-running one), else "1 background agent finished ·
 * report pending" / "2 background agents finished · reports pending"; '' without visible tasks.
 */
export function summaryLine(tasks: readonly BackgroundTask[], now: number): string {
  const visible = visibleTasks(tasks)
  const running = visible.filter(isRunningTask)
  if (running.length > 0) {
    const latest = running.reduce((a, b) => (b.createdAt > a.createdAt ? b : a))
    const oldest = running.reduce((a, b) => (b.createdAt < a.createdAt ? b : a))
    const parts = [agents(running.length), latest.output.description]
    const duration = formatDuration(Math.max(0, now - oldest.createdAt))
    if (duration)
      parts.push(duration)
    return parts.join(' · ')
  }
  if (visible.length === 0)
    return ''
  return `${agents(visible.length)} finished · ${visible.length === 1 ? 'report' : 'reports'} pending`
}

/**
 * The accessible name of the list's toggle: "Show background agents, 2 running" ("…, 1 finished" when none runs) while
 * closed, "Hide background agents" while open.
 */
export function toggleName(tasks: readonly BackgroundTask[], open: boolean): string {
  if (open)
    return 'Hide background agents'
  const running = tasks.filter(isRunningTask).length
  return running > 0 ? `Show background agents, ${running} running` : `Show background agents, ${tasks.length} finished`
}

/** The header of the open list: "Background agents · 2 running" ("Background agents" when none runs). */
export function headerLine(tasks: readonly BackgroundTask[]): string {
  const running = tasks.filter(isRunningTask).length
  return running > 0 ? `Background agents · ${running} running` : 'Background agents'
}

const ANNOUNCEMENTS: Readonly<Record<Exclude<BackgroundTaskStatus, 'running'>, string>> = {
  completed: 'Background agent finished',
  failed: 'Background agent failed',
  aborted: 'Background agent stopped',
  limit: 'Background agent reached its step limit',
}

/** The status word of an ended row (docs/UI.md 7.29: "the final status icon and word"). */
export const ENDED_STATUS_WORDS: Readonly<Record<Exclude<BackgroundTaskStatus, 'running'>, string>> = {
  completed: 'Finished',
  failed: 'Failed',
  aborted: 'Stopped',
  limit: 'Step limit reached',
}

/**
 * What a polite region says about a background agent that ended: "Background agent finished: {description}" ("…
 * failed", "… stopped", "… reached its step limit"). Used for the dock's transitions and for the results of a turn the
 * server started (`ChatView`).
 */
export function endedAnnouncement(output: Pick<TaskOutput, 'status' | 'description'>): string {
  const text = ANNOUNCEMENTS[output.status as Exclude<BackgroundTaskStatus, 'running'>] ?? ANNOUNCEMENTS.completed
  return `${text}: ${output.description}`
}

/**
 * What the dock's polite region says for one update of a task this tab observed: a running task that ended reads
 * "Background agent finished: {description}" (failed, stopped, reached its step limit); anything else, including a
 * task seen for the first time (`previous` null), says nothing.
 */
export function announcementFor(previous: BackgroundTask | null, next: BackgroundTask): string | null {
  if (!previous || !isRunningTask(previous) || isRunningTask(next))
    return null
  return `${ANNOUNCEMENTS[next.status as Exclude<BackgroundTaskStatus, 'running'>]}: ${next.output.description}`
}

/** How many announced task ids a tab remembers (oldest forgotten first). */
const ANNOUNCED_TASKS_MAX = 500

/**
 * The background agents whose ending this tab already announced (coordinator decision at P10-A: exactly once per tab).
 * The dock records the transitions it observed; ChatView announces a carrier turn's results only for the tasks not
 * recorded here (e.g. a result that arrives right after a reload) and records them too. Bounded; tab-wide state (the
 * module lives once per tab), so a dock that was unmounted meanwhile still counts.
 */
export interface AnnouncedTasks {
  has: (taskId: string) => boolean
  /** Records the task; false when it was already recorded (nothing to announce). */
  add: (taskId: string) => boolean
  clear: () => void
}

export function createAnnouncedTasks(max = ANNOUNCED_TASKS_MAX): AnnouncedTasks {
  const ids = new Set<string>()
  return {
    has: taskId => ids.has(taskId),
    add: (taskId) => {
      if (ids.has(taskId))
        return false
      ids.add(taskId)
      if (ids.size > max)
        ids.delete(ids.values().next().value!)
      return true
    },
    clear: () => ids.clear(),
  }
}

/** The tab's record of announced background agents (shared by BackgroundAgents and ChatView). */
export const announcedTasks: AnnouncedTasks = createAnnouncedTasks()

/** Every tool call of a background agent: the kept steps and the earlier ones that were not kept. */
export function taskToolCallCount(task: BackgroundTask): number {
  return task.output.steps.length + task.output.stepsOmitted
}

/** How long a background agent ran: until it finished, else until `now` (clamped at 0). */
export function taskRunMs(task: BackgroundTask, now: number): number {
  const start = task.output.startedAt || task.createdAt
  const end = task.output.finishedAt ?? task.finishedAt ?? (isRunningTask(task) ? now : start)
  return Math.max(0, end - start)
}

/**
 * Where focus goes after the Stop of `stoppedId` (docs/UI.md 14.1): the Stop of the next running row (in `order`, the
 * ids of the rows when Stop was pressed, newest first), else of the previous one, else null (the toggle).
 */
export function focusAfterStop(order: readonly string[], stoppedId: string, runningIds: ReadonlySet<string>): string | null {
  const index = order.indexOf(stoppedId)
  if (index === -1)
    return [...runningIds][0] ?? null
  for (const id of order.slice(index + 1)) {
    if (runningIds.has(id))
      return id
  }
  for (const id of order.slice(0, index).reverse()) {
    if (runningIds.has(id))
      return id
  }
  return null
}
