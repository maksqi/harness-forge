// The `current_time` tool of `core-tools` (policy `safe`): the current date and time, optionally in an IANA time zone.
import type { ToolDefinition } from '@harness-forge/plugin-sdk'
import { HarnessError } from '@harness-forge/shared'
import { z } from 'zod'

export const CURRENT_TIME_TOOL_NAME = 'current_time'

export const currentTimeInputSchema = z.object({
  timezone: z
    .string()
    .trim()
    .max(100)
    .optional()
    .describe('IANA time zone name such as "Europe/Berlin", "America/New_York" or "UTC". Default: the server time zone.'),
})
export type CurrentTimeInput = z.infer<typeof currentTimeInputSchema>

export interface CurrentTimeOutput {
  /** UTC, ISO 8601 with milliseconds (`2026-09-28T12:03:04.567Z`). */
  iso: string
  /** Unix epoch milliseconds. */
  unixMs: number
  /** The IANA time zone of `local` / `utcOffset` / `weekday`. */
  timezone: string
  /** Wall-clock time in `timezone`: `YYYY-MM-DD HH:mm:ss`. */
  local: string
  /** Offset of `timezone` from UTC at that instant: `+02:00`, `-05:30`, `+00:00`. */
  utcOffset: string
  /** English weekday name in `timezone`. */
  weekday: string
}

/** The time zone of the server process (`UTC` when it cannot be determined). */
export function serverTimeZone(): string {
  try {
    return new Intl.DateTimeFormat('en-US').resolvedOptions().timeZone || 'UTC'
  }
  catch {
    return 'UTC'
  }
}

/** The canonical name of an IANA time zone (the server zone when empty); `validation_error` for an unknown zone. */
export function resolveTimeZone(value: string | undefined): string {
  const requested = value?.trim() ?? ''
  if (requested === '')
    return serverTimeZone()
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: requested }).resolvedOptions().timeZone
  }
  catch {
    throw new HarnessError({
      code: 'validation_error',
      message: `Unknown time zone "${requested.slice(0, 100)}". Use an IANA name such as "Europe/Berlin", "America/New_York" or "UTC".`,
    })
  }
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0')
}

/** `+HH:MM` / `-HH:MM` for an offset in minutes. */
export function formatUtcOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+'
  const total = Math.abs(minutes)
  return `${sign}${pad(Math.floor(total / 60))}:${pad(total % 60)}`
}

/** The date and time of `date` in `timeZone` (a valid IANA name, see `resolveTimeZone`). */
export function currentTime(date: Date, timeZone: string): CurrentTimeOutput {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    weekday: 'long',
  }).formatToParts(date)
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find(entry => entry.type === type)?.value ?? ''
  const year = Number(part('year'))
  const month = Number(part('month'))
  const day = Number(part('day'))
  // Some ICU versions render midnight as 24 even with h23.
  const hour = Number(part('hour')) % 24
  const minute = Number(part('minute'))
  const second = Number(part('second'))
  const wallClockAsUtc = Date.UTC(year, month - 1, day, hour, minute, second)
  const instant = Math.floor(date.getTime() / 1000) * 1000
  const offsetMinutes = Math.round((wallClockAsUtc - instant) / 60_000)
  return {
    iso: date.toISOString(),
    unixMs: date.getTime(),
    timezone: timeZone,
    local: `${pad(year, 4)}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}:${pad(second)}`,
    utcOffset: formatUtcOffset(offsetMinutes),
    weekday: part('weekday'),
  }
}

export const currentTimeTool: ToolDefinition<CurrentTimeInput, CurrentTimeOutput> = {
  name: CURRENT_TIME_TOOL_NAME,
  description: 'Get the current date and time: UTC ISO 8601 timestamp, local wall-clock time, UTC offset and weekday, optionally in an IANA time zone.',
  inputSchema: currentTimeInputSchema,
  policy: 'safe',
  async execute(input) {
    return currentTime(new Date(), resolveTimeZone(input.timezone))
  },
}
