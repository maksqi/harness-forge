import type { LogLevel, PluginLogEntry } from '@harness-forge/shared'
import type { GuardServices } from './guard.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryLogger } from '../logger.ts'
import { createRedactor } from '../security/redact.ts'
import {
  createPluginLogStore,
  formatDuration,
  guardCall,
  isGuardTimeout,
  PLUGIN_LOG_CAPACITY,
  PLUGIN_LOG_EVENTS_PER_SECOND,
  PLUGIN_LOG_MESSAGE_MAX_BYTES,
  PluginTimeoutError,
  thrownMessage,
  truncateUtf8,
} from './guard.ts'

interface Logged { pluginId: string, level: LogLevel, message: string, data?: unknown }

function services(overrides: Partial<GuardServices> = {}): GuardServices & { logged: Logged[] } {
  const logged: Logged[] = []
  return {
    logged,
    log: (pluginId, level, message, data) => void logged.push({ pluginId, level, message, data }),
    redactText: text => text.replaceAll('sk-secret-value', '[redacted]'),
    lifecycleSignal: () => undefined,
    isInactive: () => false,
    ...overrides,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('guardCall', () => {
  it('resolves with the value and passes an abort signal', async () => {
    const s = services()
    let received: AbortSignal | undefined
    await expect(guardCall(s, 'p', (signal) => {
      received = signal
      return 42
    }, { timeoutMs: 1000, phase: 'tool' })).resolves.toBe(42)
    expect(received?.aborted).toBe(false)
    expect(s.logged).toEqual([])
  })

  it('turns a throw into plugin_error with the message and logs it (redacted)', async () => {
    const s = services()
    const error = await guardCall(s, 'acme', () => {
      throw new Error('bad key sk-secret-value')
    }, { timeoutMs: 1000, phase: 'setup' }).catch(caught => caught)
    expect(error).toMatchObject({ code: 'plugin_error', message: 'bad key [redacted]', details: { pluginId: 'acme', phase: 'setup' } })
    expect(s.logged).toEqual([expect.objectContaining({ pluginId: 'acme', level: 'error', message: 'setup failed: bad key [redacted]' })])
  })

  it('handles rejections, non-Error throws and empty messages', async () => {
    const s = services()
    await expect(guardCall(s, 'p', async () => Promise.reject(new Error('async failure')), { timeoutMs: 1000, phase: 'hook', label: 'chat.params' })).rejects.toMatchObject({ message: 'async failure' })
    expect(s.logged.at(-1)?.message).toBe('hook chat.params failed: async failure')
    await expect(guardCall(s, 'p', () => {
      // eslint-disable-next-line no-throw-literal -- plugins may throw anything
      throw 'plain string'
    }, { timeoutMs: 1000, phase: 'tool' })).rejects.toMatchObject({ message: 'plain string' })
    const empty = new Error('placeholder')
    empty.message = ''
    await expect(guardCall(s, 'p', () => {
      throw empty
    }, { timeoutMs: 1000, phase: 'tool' })).rejects.toMatchObject({ message: 'Unknown error' })
  })

  it('times out, aborts the signal passed to the code and logs the timeout', async () => {
    vi.useFakeTimers()
    const s = services()
    let received: AbortSignal | undefined
    const pending = guardCall(s, 'slow', (signal) => {
      received = signal
      return new Promise(() => {})
    }, { timeoutMs: 10_000, phase: 'setup' })
    const outcome = pending.catch(error => error)
    await vi.advanceTimersByTimeAsync(9999)
    expect(received?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const error = await outcome
    expect(error).toMatchObject({ code: 'plugin_error', message: 'Timed out after 10 s (setup).', details: { pluginId: 'slow', phase: 'setup' } })
    expect(isGuardTimeout(error)).toBe(true)
    expect(received?.aborted).toBe(true)
    expect(received?.reason).toBeInstanceOf(PluginTimeoutError)
    expect(s.logged).toEqual([expect.objectContaining({ level: 'error', message: 'Timed out after 10 s (setup).' })])
  })

  it('ignores a settlement after the timeout (no unhandled rejection)', async () => {
    vi.useFakeTimers()
    const s = services()
    let reject: (error: Error) => void = () => {}
    const pending = guardCall(s, 'late', () => new Promise((_resolve, rejectFn) => {
      reject = rejectFn
    }), { timeoutMs: 100, phase: 'hook' }).catch(error => error)
    await vi.advanceTimersByTimeAsync(100)
    expect(isGuardTimeout(await pending)).toBe(true)
    reject(new Error('too late'))
    await vi.advanceTimersByTimeAsync(10)
    expect(s.logged).toHaveLength(1)
  })

  it('stops waiting when the caller aborts (not logged as a failure)', async () => {
    const s = services()
    const controller = new AbortController()
    let received: AbortSignal | undefined
    const pending = guardCall(s, 'p', (signal) => {
      received = signal
      return new Promise(() => {})
    }, { timeoutMs: 60_000, phase: 'tool', signal: controller.signal })
    controller.abort(new Error('user stop'))
    await expect(pending).rejects.toThrow('user stop')
    expect(received?.aborted).toBe(true)
    expect(s.logged).toEqual([])
    await expect(guardCall(s, 'p', () => 1, { timeoutMs: 10, phase: 'tool', signal: controller.signal })).rejects.toThrow('user stop')
  })

  it('fails tool and hook calls with "tool unavailable" when the plugin is disposed', async () => {
    const lifecycle = new AbortController()
    const s = services({ lifecycleSignal: () => lifecycle.signal })
    const pending = guardCall(s, 'dice', () => new Promise(() => {}), { timeoutMs: 60_000, phase: 'tool' })
    lifecycle.abort()
    await expect(pending).rejects.toMatchObject({ code: 'plugin_error', message: 'Tool unavailable: the plugin "dice" was disabled.', details: { phase: 'tool' } })
    await expect(guardCall(s, 'dice', () => 1, { timeoutMs: 100, phase: 'hook' })).rejects.toMatchObject({ message: /was disabled/ })
    // Other phases (dispose) do not follow the lifecycle signal.
    await expect(guardCall(s, 'dice', () => 'disposed', { timeoutMs: 100, phase: 'dispose' })).resolves.toBe('disposed')
    const inactive = services({ isInactive: () => true })
    await expect(guardCall(inactive, 'dice', () => 1, { timeoutMs: 100, phase: 'tool' })).rejects.toMatchObject({ message: /Tool unavailable/ })
  })

  it('clamps timeouts', async () => {
    vi.useFakeTimers()
    const s = services()
    const pending = guardCall(s, 'p', () => new Promise(() => {}), { timeoutMs: 10_000_000, phase: 'tool' }).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(await pending).toMatchObject({ message: 'Timed out after 600 s (tool).' })
  })
})

describe('helpers', () => {
  it('formats durations and messages', () => {
    expect(formatDuration(800)).toBe('800 ms')
    expect(formatDuration(3000)).toBe('3 s')
    expect(formatDuration(1500)).toBe('1.5 s')
    const typeError = new TypeError('placeholder')
    typeError.message = ''
    expect(thrownMessage(typeError)).toBe('TypeError')
    expect(thrownMessage({ weird: true })).toBe('Unknown error')
    expect(thrownMessage('x'.repeat(2000))).toHaveLength(1003)
  })

  it('truncates UTF-8 on code point boundaries', () => {
    const text = 'é'.repeat(3000)
    const cut = truncateUtf8(text, 100)
    expect(new TextEncoder().encode(cut).length).toBeLessThanOrEqual(100)
    expect(cut.endsWith(' [truncated]')).toBe(true)
    expect(truncateUtf8('short', 100)).toBe('short')
  })
})

describe('plugin log store', () => {
  function store(now: () => number = Date.now) {
    const published: Array<{ pluginId: string, entry: PluginLogEntry }> = []
    const memory = createMemoryLogger()
    const redactor = createRedactor()
    redactor.addSecret('super-secret-token')
    const logs = createPluginLogStore({ logger: memory.logger, redactor, publish: (pluginId, entry) => published.push({ pluginId, entry }), now })
    return { logs, published, memory }
  }

  it('keeps the last 500 entries per plugin with increasing sequence numbers', () => {
    const { logs } = store()
    for (let i = 1; i <= PLUGIN_LOG_CAPACITY + 20; i++)
      logs.append('p', 'info', `entry ${i}`)
    logs.append('q', 'info', 'other plugin')
    const all = logs.entries('p', { limit: 500 })
    expect(all).toHaveLength(PLUGIN_LOG_CAPACITY)
    expect(all[0]?.seq).toBe(21)
    expect(all.at(-1)?.seq).toBe(520)
    expect(logs.entries('p')).toHaveLength(200)
    expect(logs.entries('p').at(-1)?.message).toBe('entry 520')
    expect(logs.entries('p', { after: 510 }).map(entry => entry.seq)).toEqual([511, 512, 513, 514, 515, 516, 517, 518, 519, 520])
    expect(logs.entries('p', { after: 30, limit: 2 }).map(entry => entry.seq)).toEqual([31, 32])
    expect(logs.entries('q')).toEqual([expect.objectContaining({ seq: 1, message: 'other plugin' })])
    logs.clear('p')
    expect(logs.entries('p')).toEqual([])
  })

  it('redacts secrets, caps messages and keeps only JSON data', () => {
    const { logs, memory } = store()
    const entry = logs.append('p', 'warn', `token super-secret-token ${'x'.repeat(5000)}`, { apiKey: 'abc', nested: { value: 'super-secret-token' }, fn: () => 1 })
    expect(entry.message).not.toContain('super-secret-token')
    expect(new TextEncoder().encode(entry.message).length).toBeLessThanOrEqual(PLUGIN_LOG_MESSAGE_MAX_BYTES)
    expect(JSON.stringify(entry.data)).not.toContain('super-secret-token')
    expect(entry.data).toMatchObject({ apiKey: '[redacted]' })
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(logs.append('p', 'info', 'circular', circular).data).toBeDefined()
    expect(logs.append('p', 'info', 'big', { text: 'y'.repeat(20_000) }).data).toMatchObject({ truncated: true })
    expect(logs.append('p', 'info', 'bigint', 10n).data).toBe('10')
    expect(memory.records.some(record => record.pluginId === 'p' && record.level === 'warn')).toBe(true)
    expect(memory.text()).not.toContain('super-secret-token')
  })

  it('publishes at most 20 events per second and summarizes the rest', async () => {
    vi.useFakeTimers()
    const { logs, published } = store()
    for (let i = 0; i < 30; i++)
      logs.append('noisy', 'debug', `line ${i}`)
    expect(published).toHaveLength(PLUGIN_LOG_EVENTS_PER_SECOND)
    expect(logs.entries('noisy', { limit: 500 })).toHaveLength(30)
    await vi.advanceTimersByTimeAsync(1000)
    expect(published).toHaveLength(PLUGIN_LOG_EVENTS_PER_SECOND + 1)
    expect(published.at(-1)?.entry).toMatchObject({ level: 'warn', message: expect.stringContaining('10 log entries were not streamed live') })
    logs.append('noisy', 'info', 'after the window')
    expect(published.at(-1)?.entry.message).toBe('after the window')
    logs.stop()
  })
})
