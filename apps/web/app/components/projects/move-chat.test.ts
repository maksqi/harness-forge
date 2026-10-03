// useMoveChat (docs/UI.md 7.20, 11.4; W7.9-T3): the optimistic PATCH, the "Moved to {name}" toast with Undo, and the
// error toasts (409 run-active, 404) after the rollback. Never rejects.
import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatsStore } from '~/stores/chats'
import { useProjectsStore } from '~/stores/projects'
import { chatId, chatSummary, projectId, projectSummary } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { stubLocalStorage } from '~/utils/testing/storage'
import { MOVE_NOT_FOUND_MESSAGE, MOVE_RUN_ACTIVE_MESSAGE, MOVE_UNDO_MS, useMoveChat } from './move-chat'
import ProjectMovedToast from './ProjectMovedToast.vue'

const mocks = vi.hoisted(() => ({
  api: null as unknown,
  toast: Object.assign(vi.fn(), { custom: vi.fn(), error: vi.fn(), success: vi.fn(), dismiss: vi.fn() }),
}))

vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api }))
vi.mock('vue-sonner', () => ({ toast: mocks.toast }))

let api: MockApi
let pinia: ReturnType<typeof createPinia>

const chat = chatSummary({ id: chatId(1), title: 'Fix the parser', projectId: null })

beforeEach(async () => {
  api = createMockApi()
  mocks.api = api
  for (const fn of [mocks.toast, mocks.toast.custom, mocks.toast.error, mocks.toast.success])
    fn.mockReset()
  stubLocalStorage()
  pinia = createPinia()
  setActivePinia(pinia)
  useProjectsStore().items = [
    projectSummary({ id: projectId(1), name: 'Website' }),
    projectSummary({ id: projectId(2), name: 'API', path: '/srv/workspaces/api' }),
  ]
  api.chats.list.mockResolvedValueOnce({ items: [chat], nextCursor: null })
  await useChatsStore().fetchPage()
})

afterEach(() => {
  disposePinia(pinia)
  vi.unstubAllGlobals()
})

/** The props vue-sonner would pass to the custom toast. */
function customToast(): { component: unknown, duration: number, title: string, onUndo: () => void } {
  const [component, options] = mocks.toast.custom.mock.lastCall as [unknown, { duration: number, componentProps: { title: string, onUndo: () => void } }]
  return { component, duration: options.duration, ...options.componentProps }
}

describe('useMoveChat', () => {
  it('moves at once, then shows "Moved to {name}" with an Undo that moves the chat back', async () => {
    const chats = useChatsStore()
    let resolve: (value: unknown) => void = () => {}
    api.chats.update.mockReturnValueOnce(new Promise((done) => {
      resolve = done
    }))
    const moving = useMoveChat()(chatId(1), projectId(1))
    expect(api.chats.update).toHaveBeenCalledWith({ params: { id: chatId(1) }, body: { projectId: projectId(1) } })
    expect(chats.byId(chatId(1))?.projectId).toBe(projectId(1))
    resolve({ ...chat, projectId: projectId(1) })
    await moving

    const toast = customToast()
    expect(toast.component).toBe(ProjectMovedToast)
    expect(toast.title).toBe('Moved to Website')
    expect(toast.duration).toBe(MOVE_UNDO_MS)

    api.chats.update.mockResolvedValueOnce({ ...chat, projectId: null })
    toast.onUndo()
    expect(api.chats.update).toHaveBeenLastCalledWith({ params: { id: chatId(1) }, body: { projectId: null } })
    await vi.waitFor(() => expect(chats.byId(chatId(1))?.projectId).toBeNull())
    expect(mocks.toast.custom).toHaveBeenCalledTimes(1)
  })

  it('says "Moved out of {name}" when the chat leaves its project', async () => {
    const chats = useChatsStore()
    api.chats.update.mockResolvedValueOnce({ ...chat, projectId: projectId(2) })
    await chats.update(chatId(1), { projectId: projectId(2) })
    api.chats.update.mockResolvedValueOnce({ ...chat, projectId: null })
    await useMoveChat()(chatId(1), null)
    expect(customToast().title).toBe('Moved out of API')
  })

  it('rolls back and explains a 409 run-active and a 404; other errors show the server message; it never rejects', async () => {
    const chats = useChatsStore()
    const move = useMoveChat()
    api.chats.update.mockRejectedValueOnce(new HarnessError({ code: 'conflict', message: 'A response is running.', details: { reason: 'run-active', chatId: chatId(1) } }))
    await expect(move(chatId(1), projectId(1))).resolves.toBeUndefined()
    expect(mocks.toast.error).toHaveBeenLastCalledWith(MOVE_RUN_ACTIVE_MESSAGE)
    expect(MOVE_RUN_ACTIVE_MESSAGE).toBe('Wait for the response to finish before moving this chat.')
    expect(chats.byId(chatId(1))?.projectId).toBeNull()

    api.chats.update.mockRejectedValueOnce(new HarnessError({ code: 'not_found', message: 'Project not found.' }))
    await move(chatId(1), projectId(2))
    expect(mocks.toast.error).toHaveBeenLastCalledWith(MOVE_NOT_FOUND_MESSAGE)
    expect(MOVE_NOT_FOUND_MESSAGE).toBe('This project no longer exists.')

    api.chats.update.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'Boom.' }))
    await move(chatId(1), projectId(2))
    expect(mocks.toast.error).toHaveBeenLastCalledWith('Couldn\'t move the chat', { description: 'Boom.' })
    expect(chats.byId(chatId(1))?.projectId).toBeNull()
    expect(mocks.toast.custom).not.toHaveBeenCalled()
  })

  it('shows the error toast when the Undo fails', async () => {
    api.chats.update.mockResolvedValueOnce({ ...chat, projectId: projectId(1) })
    await useMoveChat()(chatId(1), projectId(1))
    api.chats.update.mockRejectedValueOnce(new HarnessError({ code: 'conflict', message: 'Busy.', details: { reason: 'run-active' } }))
    customToast().onUndo()
    await vi.waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith(MOVE_RUN_ACTIVE_MESSAGE))
    expect(useChatsStore().byId(chatId(1))?.projectId).toBe(projectId(1))
  })

  it('does nothing when the chat is already there, and offers no Undo for a chat whose project is unknown here', async () => {
    const move = useMoveChat()
    await move(chatId(1), null)
    expect(api.chats.update).not.toHaveBeenCalled()

    api.chats.update.mockResolvedValueOnce(chatSummary({ id: chatId(7), projectId: projectId(2) }))
    await move(chatId(7), projectId(2))
    expect(api.chats.update).toHaveBeenCalledWith({ params: { id: chatId(7) }, body: { projectId: projectId(2) } })
    expect(mocks.toast.success).toHaveBeenCalledWith('Moved to API')
    expect(mocks.toast.custom).not.toHaveBeenCalled()
  })
})
