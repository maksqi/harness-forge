import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCoalescedTask } from './coalesce'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createCoalescedTask', () => {
  it('runs a burst of triggers once', async () => {
    const task = vi.fn(async () => {})
    const refetch = createCoalescedTask(task, 100)
    refetch.schedule()
    refetch.schedule()
    refetch.schedule()
    await vi.advanceTimersByTimeAsync(100)
    expect(task).toHaveBeenCalledTimes(1)
  })

  it('runs once more when triggered during a run, and survives failures', async () => {
    let finish: () => void = () => {}
    const task = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        finish = resolve
      }))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(undefined)
    const refetch = createCoalescedTask(task, 10)
    refetch.schedule()
    await vi.advanceTimersByTimeAsync(10)
    refetch.schedule()
    refetch.schedule()
    finish()
    await vi.advanceTimersByTimeAsync(10)
    expect(task).toHaveBeenCalledTimes(2)
    refetch.schedule()
    await vi.advanceTimersByTimeAsync(10)
    expect(task).toHaveBeenCalledTimes(3)
  })

  it('cancels a scheduled run', async () => {
    const task = vi.fn(async () => {})
    const refetch = createCoalescedTask(task, 10)
    refetch.schedule()
    refetch.cancel()
    await vi.advanceTimersByTimeAsync(100)
    expect(task).not.toHaveBeenCalled()
  })
})
