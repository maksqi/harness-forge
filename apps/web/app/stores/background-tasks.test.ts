import type { BackgroundTask, BackgroundTaskList } from '@harness-forge/shared'
import type { MockApi } from '~/utils/testing/mock-api'
import { createServerEvent, HarnessError } from '@harness-forge/shared'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { backgroundTask, backgroundTaskId, chatId, taskOutput, taskStep } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { useBackgroundTasksStore } from './background-tasks'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))

let pinia: ReturnType<typeof createPinia>
let api: MockApi

beforeEach(() => {
  api = createMockApi()
  mock.api = api
  pinia = createPinia()
  setActivePinia(pinia)
})

afterEach(() => {
  disposePinia(pinia)
})

const running = backgroundTask({ id: backgroundTaskId(2), status: 'running', finishedAt: null, createdAt: 1_759_000_010_000, output: taskOutput({ status: 'running', finishedAt: undefined }) })

/** The running task after `n` tool calls. */
function progressed(n: number): BackgroundTask {
  return { ...running, output: { ...running.output, steps: Array.from({ length: n }, (_, index) => taskStep({ toolCallId: `child_${index}` })) } }
}

function changed(task: BackgroundTask, id = 1) {
  return createServerEvent('task.changed', { chatId: task.chatId, task }, id)
}

function deferredList() {
  let resolve!: (list: BackgroundTaskList) => void
  const promise = new Promise<BackgroundTaskList>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('background-tasks store: shape', () => {
  it('starts empty and answers unknown chats with empty lists', () => {
    const store = useBackgroundTasksStore()
    expect(store.byChat).toEqual({})
    expect(store.loaded).toEqual({})
    expect(store.stopping).toEqual({})
    expect(store.tasks(chatId(1))).toEqual([])
    expect(store.visible(chatId(1))).toEqual([])
    expect(store.byId(chatId(1), backgroundTaskId(1))).toBeNull()
  })
})

describe('background-tasks store: fetch', () => {
  it('lists the chat\'s tasks newest first, marks the chat loaded and throws failures', async () => {
    const store = useBackgroundTasksStore()
    api.chatTasks.list.mockResolvedValueOnce({ items: [backgroundTask(), running] })
    await store.fetch(chatId(1))
    expect(api.chatTasks.list).toHaveBeenCalledWith({ params: { id: chatId(1) } })
    expect(store.loaded[chatId(1)]).toBe(true)
    expect(store.tasks(chatId(1)).map(task => task.id)).toEqual([backgroundTaskId(2), backgroundTaskId(1)])
    expect(store.byId(chatId(1), backgroundTaskId(2))?.status).toBe('running')
    api.chatTasks.list.mockRejectedValueOnce(new HarnessError({ code: 'not_found', message: 'Chat not found.' }))
    await expect(store.fetch(chatId(2))).rejects.toMatchObject({ code: 'not_found' })
    expect(store.loaded[chatId(2)]).toBeUndefined()
  })

  it('a fetch nothing came after replaces the list', async () => {
    const store = useBackgroundTasksStore()
    store.applyEvent(changed(backgroundTask({ id: backgroundTaskId(9) })))
    api.chatTasks.list.mockResolvedValueOnce({ items: [running] })
    await store.fetch(chatId(1))
    expect(store.tasks(chatId(1)).map(task => task.id)).toEqual([backgroundTaskId(2)])
  })

  it('an answer never replaces an event that came after the fetch started (two tabs, a reconnect)', async () => {
    const store = useBackgroundTasksStore()
    const answer = deferredList()
    api.chatTasks.list.mockReturnValueOnce(answer.promise)
    const fetching = store.fetch(chatId(1))
    // The task ended and another one started while the request was in flight.
    const ended = { ...running, status: 'completed' as const, finishedAt: 1_759_000_020_000 }
    const other = { ...running, id: backgroundTaskId(3), createdAt: 1_759_000_030_000 }
    store.applyEvent(changed(ended))
    store.applyEvent(changed(other))
    answer.resolve({ items: [progressed(4), backgroundTask()] })
    await fetching
    expect(store.tasks(chatId(1)).map(task => [task.id, task.status])).toEqual([
      [backgroundTaskId(3), 'running'],
      [backgroundTaskId(2), 'completed'],
      [backgroundTaskId(1), 'completed'],
    ])
    expect(store.loaded[chatId(1)]).toBe(true)
  })

  it('a merged answer still brings a newer snapshot of a listed task', async () => {
    const store = useBackgroundTasksStore()
    store.applyEvent(changed(progressed(1)))
    const answer = deferredList()
    api.chatTasks.list.mockReturnValueOnce(answer.promise)
    const fetching = store.fetch(chatId(1))
    store.applyEvent(changed(backgroundTask({ id: backgroundTaskId(5) })))
    answer.resolve({ items: [progressed(3)] })
    await fetching
    expect(store.byId(chatId(1), backgroundTaskId(2))?.output.steps).toHaveLength(3)
  })

  it('refreshLoaded fetches every loaded chat again; failures keep the old lists', async () => {
    const store = useBackgroundTasksStore()
    api.chatTasks.list.mockResolvedValue({ items: [] })
    await store.fetch(chatId(1))
    await store.fetch(chatId(2))
    api.chatTasks.list.mockClear()
    api.chatTasks.list.mockResolvedValueOnce({ items: [running] })
    api.chatTasks.list.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'Boom' }))
    await expect(store.refreshLoaded()).resolves.toBeUndefined()
    expect(api.chatTasks.list.mock.calls.map(call => (call[0] as { params: { id: string } }).params.id)).toEqual([chatId(1), chatId(2)])
    expect(store.tasks(chatId(1))).toEqual([running])
  })

  it('refreshLoaded also fetches a chat whose running task only events reported (its end may have been missed)', async () => {
    const store = useBackgroundTasksStore()
    store.applyEvent(changed({ ...running, chatId: chatId(3) }))
    store.applyEvent(changed(backgroundTask({ chatId: chatId(4) })))
    const done = { ...running, chatId: chatId(3), status: 'completed' as const, finishedAt: 1_759_000_020_000 }
    api.chatTasks.list.mockResolvedValueOnce({ items: [done] })
    await store.refreshLoaded()
    expect(api.chatTasks.list.mock.calls).toEqual([[{ params: { id: chatId(3) } }]])
    expect(store.tasks(chatId(3))).toEqual([done])
  })
})

describe('background-tasks store: events', () => {
  it('upserts task.changed newest first and drops a deleted chat', () => {
    const store = useBackgroundTasksStore()
    const finished = backgroundTask()
    store.applyEvent(changed(finished, 1))
    store.applyEvent(changed(running, 2))
    expect(store.tasks(chatId(1)).map(task => task.id)).toEqual([backgroundTaskId(2), backgroundTaskId(1)])
    const done = { ...running, status: 'completed' as const, finishedAt: 1_759_000_020_000 }
    store.applyEvent(changed(done, 3))
    expect(store.byId(chatId(1), backgroundTaskId(2))?.status).toBe('completed')
    expect(store.visible(chatId(1))).toHaveLength(2)
    store.applyEvent(createServerEvent('chat.deleted', { id: chatId(1) }, 4))
    expect(store.tasks(chatId(1))).toEqual([])
  })

  it('ignores an older snapshot: fewer tool calls, running after an end, undelivered after the delivery', () => {
    const store = useBackgroundTasksStore()
    store.applyEvent(changed(progressed(3)))
    store.applyEvent(changed(progressed(2)))
    expect(store.byId(chatId(1), running.id)?.output.steps).toHaveLength(3)
    const ended = { ...progressed(3), status: 'completed' as const, finishedAt: 1_759_000_020_000 }
    store.applyEvent(changed(ended))
    store.applyEvent(changed(progressed(5)))
    expect(store.byId(chatId(1), running.id)?.status).toBe('completed')
    const delivered = { ...ended, deliveredAt: 1_759_000_021_000, deliveredMessageId: 'msg_carrier000000001' }
    store.applyEvent(changed(delivered))
    store.applyEvent(changed(ended))
    expect(store.byId(chatId(1), running.id)?.deliveredAt).toBe(1_759_000_021_000)
    expect(store.visible(chatId(1))).toEqual([])
  })

  it('never lists a deleted chat again (late events, fetch answers)', async () => {
    const store = useBackgroundTasksStore()
    const answer = deferredList()
    api.chatTasks.list.mockReturnValueOnce(answer.promise)
    const fetching = store.fetch(chatId(1))
    store.applyEvent(createServerEvent('chat.deleted', { id: chatId(1) }))
    store.applyEvent(changed({ ...running, status: 'aborted', finishedAt: 1_759_000_020_000 }))
    answer.resolve({ items: [running] })
    await fetching
    expect(store.byChat).toEqual({})
    expect(store.loaded).toEqual({})
  })
})

describe('background-tasks store: stop', () => {
  it('answers stopped for an aborted task, gone for an ended one or a 404, and throws other failures', async () => {
    const store = useBackgroundTasksStore()
    store.applyEvent(changed(running))
    api.chatTasks.stop.mockResolvedValueOnce({ ...running, status: 'aborted', finishedAt: 1_759_000_030_000 })
    const pending = store.stop(chatId(1), running.id)
    expect(store.stopping[running.id]).toBe(true)
    expect(await pending).toBe('stopped')
    expect(store.stopping).toEqual({})
    expect(store.byId(chatId(1), running.id)?.status).toBe('aborted')
    api.chatTasks.stop.mockResolvedValueOnce(backgroundTask())
    expect(await store.stop(chatId(1), backgroundTaskId(1))).toBe('gone')
    api.chatTasks.stop.mockRejectedValueOnce(new HarnessError({ code: 'not_found', message: 'Not found.' }))
    expect(await store.stop(chatId(1), backgroundTaskId(9))).toBe('gone')
    api.chatTasks.stop.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'Boom' }))
    await expect(store.stop(chatId(1), backgroundTaskId(9))).rejects.toMatchObject({ code: 'internal_error' })
    expect(store.stopping).toEqual({})
  })

  it('a second stop of the same task joins the one in flight', async () => {
    const store = useBackgroundTasksStore()
    store.applyEvent(changed(running))
    api.chatTasks.stop.mockResolvedValueOnce({ ...running, status: 'aborted', finishedAt: 1_759_000_030_000 })
    const first = store.stop(chatId(1), running.id)
    const second = store.stop(chatId(1), running.id)
    expect(await Promise.all([first, second])).toEqual(['stopped', 'stopped'])
    expect(api.chatTasks.stop).toHaveBeenCalledOnce()
  })

  it('stops every running task in turn and counts the stopped ones', async () => {
    const store = useBackgroundTasksStore()
    const other = { ...running, id: backgroundTaskId(3) }
    for (const task of [running, other, backgroundTask()])
      store.applyEvent(changed(task))
    api.chatTasks.stop.mockImplementation(async ({ params }: { params: { taskId: string } }) => ({ ...running, id: params.taskId, status: 'aborted' }))
    expect(await store.stopAll(chatId(1))).toBe(2)
    expect(api.chatTasks.stop.mock.calls.map(call => (call[0] as { params: { taskId: string } }).params.taskId)).toEqual([backgroundTaskId(2), backgroundTaskId(3)])
    expect(store.visible(chatId(1)).every(task => task.status !== 'running')).toBe(true)
  })

  it('stop all keeps going after a failure and throws the first one at the end', async () => {
    const store = useBackgroundTasksStore()
    const other = { ...running, id: backgroundTaskId(3) }
    store.applyEvent(changed(running))
    store.applyEvent(changed(other))
    api.chatTasks.stop.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'Boom' }))
    api.chatTasks.stop.mockResolvedValueOnce({ ...other, status: 'aborted' })
    await expect(store.stopAll(chatId(1))).rejects.toMatchObject({ code: 'internal_error' })
    expect(api.chatTasks.stop).toHaveBeenCalledTimes(2)
    expect(store.byId(chatId(1), backgroundTaskId(3))?.status).toBe('aborted')
  })
})
