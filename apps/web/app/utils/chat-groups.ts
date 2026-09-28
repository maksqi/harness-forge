// Date groups of the sidebar chat list (docs/UI.md 5.3): Today, Yesterday, Previous 7 days, Previous 30 days,
// then one group per month ("September", or "August 2025" outside the current year). Calendar days in local
// time. Auto-imported (utils/).

export interface ChatDateGroup<T> {
  label: string
  chats: T[]
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const

const DAY_MS = 86_400_000

/** Local midnight of the day containing `at` (epoch ms). */
export function startOfLocalDay(at: number): number {
  const date = new Date(at)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** Local midnight `days` calendar days before the day of `at` (DST-safe). */
function daysBefore(at: number, days: number): number {
  const date = new Date(at)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - days).getTime()
}

/** The group label of one timestamp relative to `now`. Future timestamps (clock skew) count as today. */
export function chatDateLabel(updatedAt: number, now: number): string {
  if (updatedAt >= daysBefore(now, 0))
    return 'Today'
  if (updatedAt >= daysBefore(now, 1))
    return 'Yesterday'
  if (updatedAt >= daysBefore(now, 7))
    return 'Previous 7 days'
  if (updatedAt >= daysBefore(now, 30))
    return 'Previous 30 days'
  const date = new Date(updatedAt)
  const month = MONTH_NAMES[date.getMonth()]!
  return date.getFullYear() === new Date(now).getFullYear() ? month : `${month} ${date.getFullYear()}`
}

/**
 * Groups chats by `updatedAt` (newest first) into the sidebar date groups; groups keep the order of their first
 * chat, chats keep newest-first order. `now` defaults to the current time.
 */
export function groupChatsByDate<T extends { updatedAt: number }>(
  chats: readonly T[],
  now: number = Date.now(),
): ChatDateGroup<T>[] {
  const sorted = [...chats].sort((a, b) => b.updatedAt - a.updatedAt)
  const groups: ChatDateGroup<T>[] = []
  const byLabel = new Map<string, ChatDateGroup<T>>()
  for (const chat of sorted) {
    const label = chatDateLabel(chat.updatedAt, now)
    let group = byLabel.get(label)
    if (!group) {
      group = { label, chats: [] }
      byLabel.set(label, group)
      groups.push(group)
    }
    group.chats.push(chat)
  }
  return groups
}

/** Milliseconds until the next local midnight after `now` (for refreshing the groups when the day changes). */
export function msUntilNextLocalDay(now: number = Date.now()): number {
  return Math.max(1000, daysBefore(now, -1) - now) || DAY_MS
}
