import type { ToolCallContext } from '@harness-forge/plugin-sdk'
import { HarnessError } from '@harness-forge/shared'
import { asSchema } from 'ai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { currentTime, currentTimeInputSchema, currentTimeTool, formatUtcOffset, resolveTimeZone, serverTimeZone } from './current-time.ts'

const context: ToolCallContext = {
  chatId: '0199a8f0-0000-7000-8000-000000000001',
  modelRef: 'mock:echo',
  toolCallId: 'call_1',
  messages: [],
  signal: new AbortController().signal,
}

afterEach(() => {
  vi.useRealTimers()
})

describe('currentTime', () => {
  const instant = new Date('2026-09-28T12:03:04.567Z')

  it('formats an instant in a time zone with its offset and weekday', () => {
    expect(currentTime(instant, 'Europe/Berlin')).toEqual({
      iso: '2026-09-28T12:03:04.567Z',
      unixMs: instant.getTime(),
      timezone: 'Europe/Berlin',
      local: '2026-09-28 14:03:04',
      utcOffset: '+02:00',
      weekday: 'Monday',
    })
    expect(currentTime(instant, 'UTC')).toMatchObject({ local: '2026-09-28 12:03:04', utcOffset: '+00:00', weekday: 'Monday' })
    expect(currentTime(instant, 'America/New_York')).toMatchObject({ local: '2026-09-28 08:03:04', utcOffset: '-04:00' })
    expect(currentTime(instant, 'Asia/Kolkata')).toMatchObject({ local: '2026-09-28 17:33:04', utcOffset: '+05:30' })
    expect(currentTime(new Date('2026-09-28T23:30:00Z'), 'Pacific/Auckland')).toMatchObject({ local: '2026-09-29 12:30:00', weekday: 'Tuesday', utcOffset: '+13:00' })
  })

  it('renders midnight as 00', () => {
    expect(currentTime(new Date('2026-01-01T00:00:00Z'), 'UTC').local).toBe('2026-01-01 00:00:00')
  })

  it('formats offsets', () => {
    expect(formatUtcOffset(0)).toBe('+00:00')
    expect(formatUtcOffset(330)).toBe('+05:30')
    expect(formatUtcOffset(-570)).toBe('-09:30')
  })
})

describe('resolveTimeZone', () => {
  it('canonicalizes known zones and defaults to the server zone', () => {
    expect(resolveTimeZone('utc')).toBe('UTC')
    expect(resolveTimeZone(' Europe/Berlin ')).toBe('Europe/Berlin')
    expect(resolveTimeZone(undefined)).toBe(serverTimeZone())
    expect(resolveTimeZone('')).toBe(serverTimeZone())
  })

  it('rejects unknown zones with a validation error', () => {
    expect(() => resolveTimeZone('Mars/Olympus_Mons')).toThrow(HarnessError)
    try {
      resolveTimeZone('Mars/Olympus_Mons')
    }
    catch (error) {
      expect(error).toMatchObject({ code: 'validation_error' })
      expect((error as Error).message).toContain('Unknown time zone "Mars/Olympus_Mons"')
    }
  })
})

describe('current_time tool', () => {
  it('is a safe tool with an object input schema', () => {
    expect(currentTimeTool).toMatchObject({ name: 'current_time', policy: 'safe' })
    expect(asSchema(currentTimeInputSchema).jsonSchema).toMatchObject({ type: 'object', properties: { timezone: { type: 'string' } } })
  })

  it('answers with the current time', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-28T12:03:04.567Z'))
    await expect(currentTimeTool.execute({ timezone: 'Europe/Berlin' }, context)).resolves.toMatchObject({
      iso: '2026-09-28T12:03:04.567Z',
      local: '2026-09-28 14:03:04',
      timezone: 'Europe/Berlin',
    })
    await expect(currentTimeTool.execute({}, context)).resolves.toMatchObject({ timezone: serverTimeZone(), iso: '2026-09-28T12:03:04.567Z' })
    await expect(currentTimeTool.execute({ timezone: 'Nowhere/Land' }, context)).rejects.toMatchObject({ code: 'validation_error' })
  })
})
