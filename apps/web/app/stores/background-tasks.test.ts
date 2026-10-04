import type { MockApi } from '~/utils/testing/mock-api'
import { createServerEvent, HarnessError } from '@harness-forge/shared'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { backgroundTask, backgroundTaskId, chatId, taskOutput } from '~/utils/testing/fixtures'
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

  it('fetch sends no request before the routes exist (P10-0b)', async () => {
    const store = useBackgroundTasksStore()
    await expect(store.fetch(chatId(1))).resolves.toBeUndefined()
    expect(api.chatTasks.list).not.toHaveBeenCalled()
  })
})

describe('background-tasks store: events', () => {
  it('upserts task.changed newest first and drops a deleted chat', () => {
    const store = useBackgroundTasksStore()
    const finished = backgroundTask()
    store.applyEvent(createServerEvent('task.changed', { chatId: chatId(1), task: finished }, 1))
    store.applyEvent(createServerEvent('task.changed', { chatId: chatId(1), task: running }, 2))
    expect(store.tasks(chatId(1)).map(task => task.id)).toEqual([backgroundTaskId(2), backgroundTaskId(1)])
    const done = { ...running, status: 'completed' as const, finishedAt: 1_759_000_020_000 }
    store.applyEvent(createServerEvent('task.changed', { chatId: chatId(1), task: done }, 3))
    expect(store.byId(chatId(1), backgroundTaskId(2))?.status).toBe('completed')
    expect(store.visible(chatId(1))).toHaveLength(2)
    store.applyEvent(createServerEvent('chat.deleted', { id: chatId(1) }, 4))
    expect(store.tasks(chatId(1))).toEqual([])
  })
})

describe('background-tasks store: stop', () => {
  it('answers stopped for an aborted task, gone for an ended one or a 404, and throws other failures', async () => {
    const store = useBackgroundTasksStore()
    store.applyEvent(createServerEvent('task.changed', { chatId: chatId(1), task: running }, 1))
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
  })

  it('stops every running task in turn and counts the stopped ones', async () => {
    const store = useBackgroundTasksStore()
    const other = { ...running, id: backgroundTaskId(3) }
    for (const task of [running, other, backgroundTask()])
      store.applyEvent(createServerEvent('task.changed', { chatId: chatId(1), task }, 1))
    api.chatTasks.stop.mockImplementation(async ({ params }: { params: { taskId: string } }) => ({ ...running, id: params.taskId, status: 'aborted' }))
    expect(await store.stopAll(chatId(1))).toBe(2)
    expect(api.chatTasks.stop.mock.calls.map(call => (call[0] as { params: { taskId: string } }).params.taskId)).toEqual([backgroundTaskId(2), backgroundTaskId(3)])
  })
})
