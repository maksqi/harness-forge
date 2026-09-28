// "3h ago" formatting and one shared clock for every RelativeTime on the page.
import type { Ref } from 'vue'
import { onBeforeUnmount, onMounted, ref } from 'vue'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export function toDate(at: string | number | Date): Date | null {
  const date = at instanceof Date ? new Date(at.getTime()) : new Date(at)
  return Number.isNaN(date.getTime()) ? null : date
}

/** "just now", "5m ago", "3h ago", "2d ago", then a short date ("Sep 12", "Sep 12, 2025"). */
export function formatRelativeTime(date: Date, now: number = Date.now()): string {
  const diff = now - date.getTime()
  const abs = Math.abs(diff)
  const future = diff < 0
  if (abs < 45_000)
    return 'just now'
  let amount: string | null = null
  if (abs < HOUR)
    amount = `${Math.max(1, Math.round(abs / MINUTE))}m`
  else if (abs < DAY)
    amount = `${Math.round(abs / HOUR)}h`
  else if (abs < 7 * DAY)
    amount = `${Math.round(abs / DAY)}d`
  if (amount)
    return future ? `in ${amount}` : `${amount} ago`
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
}

/** Full local date and time for the `title` tooltip. */
export function formatAbsoluteTime(date: Date): string {
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

const sharedNow = ref(Date.now())
let subscribers = 0
let timer: ReturnType<typeof setInterval> | undefined

/** A clock that ticks every 30s while at least one component uses it. */
export function useSharedNow(): Ref<number> {
  onMounted(() => {
    subscribers++
    sharedNow.value = Date.now()
    if (timer === undefined) {
      timer = setInterval(() => {
        sharedNow.value = Date.now()
      }, 30_000)
    }
  })
  onBeforeUnmount(() => {
    subscribers--
    if (subscribers <= 0 && timer !== undefined) {
      clearInterval(timer)
      timer = undefined
      subscribers = 0
    }
  })
  return sharedNow
}
