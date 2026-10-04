import { describe, expect, it } from 'vitest'
import { backgroundTask, backgroundTaskId, taskOutput } from '~/utils/testing/fixtures'
import { announcementFor, BACKGROUND_EXPANDED_KEY, summaryLine, visibleTasks } from './background-agents'

const T0 = 1_759_000_000_000

function running(n: number, description: string, createdAt: number) {
  return backgroundTask({ id: backgroundTaskId(n), status: 'running', finishedAt: null, createdAt, output: taskOutput({ status: 'running', description, finishedAt: undefined }) })
}

describe('background agents', () => {
  it('shows running tasks and finished ones not delivered yet, in order', () => {
    const delivered = backgroundTask({ id: backgroundTaskId(3), deliveredAt: T0 + 50_000, deliveredMessageId: 'msg_carrier000000001' })
    const pending = backgroundTask({ id: backgroundTaskId(2) })
    const live = running(1, 'Find flaky tests', T0)
    expect(visibleTasks([live, pending, delivered]).map(task => task.id)).toEqual([backgroundTaskId(1), backgroundTaskId(2)])
    expect(BACKGROUND_EXPANDED_KEY).toBe('hf-background-expanded')
  })

  it('summarizes the running ones (newest description, longest duration), else the pending reports', () => {
    const tasks = [running(2, 'Review the diff', T0 + 30_000), running(1, 'Find flaky tests', T0)]
    expect(summaryLine(tasks, T0 + 72_000)).toBe('2 background agents · Review the diff · 1m 12s')
    expect(summaryLine([backgroundTask()], T0)).toBe('1 background agent finished · report pending')
    expect(summaryLine([backgroundTask(), backgroundTask({ id: backgroundTaskId(2) })], T0)).toBe('2 background agents finished · reports pending')
    expect(summaryLine([], T0)).toBe('')
  })

  it('announces a transition this tab saw, never a state it only loaded', () => {
    const before = running(1, 'Find flaky tests', T0)
    expect(announcementFor(before, { ...before, status: 'completed' })).toBe('Background agent finished: Find flaky tests')
    expect(announcementFor(before, { ...before, status: 'failed' })).toBe('Background agent failed: Find flaky tests')
    expect(announcementFor(before, { ...before, status: 'aborted' })).toBe('Background agent stopped: Find flaky tests')
    expect(announcementFor(before, { ...before, status: 'limit' })).toBe('Background agent reached its step limit: Find flaky tests')
    expect(announcementFor(null, { ...before, status: 'completed' })).toBeNull()
    expect(announcementFor(before, before)).toBeNull()
  })
})
