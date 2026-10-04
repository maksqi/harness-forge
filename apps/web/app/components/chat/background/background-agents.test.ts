import { describe, expect, it } from 'vitest'
import { backgroundTask, backgroundTaskId, taskOutput, taskStep } from '~/utils/testing/fixtures'
import {
  announcementFor,
  BACKGROUND_EXPANDED_KEY,
  createAnnouncedTasks,
  endedAnnouncement,
  focusAfterStop,
  headerLine,
  summaryLine,
  taskRunMs,
  taskToolCallCount,
  toggleName,
  visibleTasks,
} from './background-agents'

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

  it('names the toggle and the open list by what runs', () => {
    const live = [running(2, 'Review the diff', T0), running(1, 'Find flaky tests', T0)]
    expect(toggleName(live, false)).toBe('Show background agents, 2 running')
    expect(toggleName([backgroundTask()], false)).toBe('Show background agents, 1 finished')
    expect(toggleName(live, true)).toBe('Hide background agents')
    expect(headerLine([...live, backgroundTask()])).toBe('Background agents · 2 running')
    expect(headerLine([backgroundTask()])).toBe('Background agents')
  })

  it('announces a delivered result by its status', () => {
    expect(endedAnnouncement(taskOutput({ status: 'completed', description: 'Find flaky tests' }))).toBe('Background agent finished: Find flaky tests')
    expect(endedAnnouncement(taskOutput({ status: 'failed', description: 'Find flaky tests' }))).toBe('Background agent failed: Find flaky tests')
    expect(endedAnnouncement(taskOutput({ status: 'aborted', description: 'Find flaky tests' }))).toBe('Background agent stopped: Find flaky tests')
    expect(endedAnnouncement(taskOutput({ status: 'limit', description: 'Find flaky tests' }))).toBe('Background agent reached its step limit: Find flaky tests')
  })

  it('counts tool calls and the run time (ticking while it runs, fixed once it ended)', () => {
    const live = backgroundTask({ status: 'running', finishedAt: null, output: taskOutput({ status: 'running', startedAt: T0, finishedAt: undefined, steps: [taskStep(), taskStep({ toolCallId: 'c2' })], stepsOmitted: 3 }) })
    expect(taskToolCallCount(live)).toBe(5)
    expect(taskRunMs(live, T0 + 5_000)).toBe(5_000)
    expect(taskRunMs(backgroundTask(), T0 + 900_000)).toBe(41_000)
    expect(taskRunMs(live, T0 - 1_000)).toBe(0)
  })

  it('moves focus after a stop to the next running row, else the previous one, else the toggle', () => {
    const order = ['a', 'b', 'c', 'd']
    expect(focusAfterStop(order, 'b', new Set(['a', 'c', 'd']))).toBe('c')
    expect(focusAfterStop(order, 'b', new Set(['a', 'd']))).toBe('d')
    expect(focusAfterStop(order, 'd', new Set(['a', 'b']))).toBe('b')
    expect(focusAfterStop(order, 'b', new Set())).toBeNull()
    expect(focusAfterStop(order, 'x', new Set(['c']))).toBe('c')
  })

  it('remembers announced agents once each, bounded', () => {
    const announced = createAnnouncedTasks(2)
    expect(announced.add('a')).toBe(true)
    expect(announced.add('a')).toBe(false)
    expect(announced.add('b')).toBe(true)
    expect(announced.add('c')).toBe(true)
    expect(announced.has('a')).toBe(false)
    expect(announced.has('c')).toBe(true)
    announced.clear()
    expect(announced.has('c')).toBe(false)
  })
})
