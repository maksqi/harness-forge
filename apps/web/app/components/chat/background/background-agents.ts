// Pure helpers of the background agents list (docs/UI.md 7.29, 11.7; ADR-046): which tasks the dock shows, its
// collapsed summary line and the announcements of the transitions a tab observed. No Vue, no stores.
// Signatures frozen from Gate P10-0b (C33); W10.10 owns the copy and the details in P10-A.
import type { BackgroundTask, BackgroundTaskStatus } from '@harness-forge/shared'
import { formatDuration } from '../chat-format'

/** `localStorage` key of the dock list's open state (`1` / `0`). */
export const BACKGROUND_EXPANDED_KEY = 'hf-background-expanded'

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

const ANNOUNCEMENTS: Readonly<Record<Exclude<BackgroundTaskStatus, 'running'>, string>> = {
  completed: 'Background agent finished',
  failed: 'Background agent failed',
  aborted: 'Background agent stopped',
  limit: 'Background agent reached its step limit',
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
