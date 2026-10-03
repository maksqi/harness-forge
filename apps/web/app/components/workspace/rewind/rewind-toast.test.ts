// The rewind result toast (docs/UI.md 7.22): its text, Undo -> workspace.undo, the undo's own toast and its failure.
import type { Mock } from 'vitest'
import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { testIds } from '~/utils/testids'
import { changeBatchId, chatId, restoreResult } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { REWIND_TOAST_MS, REWIND_UNDO_FAILED_TITLE, useRewindResultToast } from './rewind-toast'
import RewindResultToast from './RewindResultToast.vue'

const mock = vi.hoisted(() => ({
  api: null as unknown,
  toast: { custom: null as unknown as Mock, error: null as unknown as Mock },
}))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))
vi.mock('vue-sonner', () => ({
  toast: {
    custom: (...args: unknown[]) => mock.toast.custom(...args),
    error: (...args: unknown[]) => mock.toast.error(...args),
  },
}))

interface ToastProps { title: string, lines: string[], undoable: boolean, onUndo?: () => void }

let api: MockApi
let pinia: ReturnType<typeof createPinia>

beforeEach(() => {
  api = createMockApi()
  mock.api = api
  mock.toast.custom = vi.fn()
  mock.toast.error = vi.fn()
  pinia = createPinia()
  setActivePinia(pinia)
})

afterEach(() => {
  disposePinia(pinia)
})

function lastToast(): { component: unknown, options: { duration: number, componentProps: ToastProps } } {
  const [component, options] = mock.toast.custom.mock.lastCall as [unknown, { duration: number, componentProps: ToastProps }]
  return { component, options }
}

describe('useRewindResultToast', () => {
  it('shows the result with Undo, which undoes the batch and reports the undo', async () => {
    const show = useRewindResultToast()
    show(chatId(1), restoreResult({ restored: ['a', 'b'], skipped: [{ path: 'c', reason: 'conflict', message: 'Changed.' }] }))
    const { component, options } = lastToast()
    expect(component).toBe(RewindResultToast)
    expect(options.duration).toBe(REWIND_TOAST_MS)
    expect(options.componentProps).toMatchObject({ title: 'Restored 2 files', lines: ['Skipped 1 file changed outside this chat'], undoable: true })

    api.changes.undo.mockResolvedValue(restoreResult({ batchId: changeBatchId(2), restored: ['a', 'b'] }))
    options.componentProps.onUndo!()
    await flushPromises()
    expect(api.changes.undo).toHaveBeenCalledWith({ params: { id: chatId(1) }, body: { batchId: changeBatchId(1), conflicts: 'skip' } })
    expect(mock.toast.custom).toHaveBeenCalledTimes(2)
    expect(lastToast().options.componentProps).toMatchObject({ title: 'Restored 2 files', lines: [], undoable: false })
  })

  it('offers no Undo when nothing was written, and reports a failed undo', async () => {
    const show = useRewindResultToast()
    show(chatId(1), restoreResult({ batchId: null, restored: [], unchanged: ['a'] }))
    expect(lastToast().options.componentProps).toMatchObject({ title: 'The files already match.', undoable: false })
    expect(lastToast().options.componentProps.onUndo).toBeUndefined()

    show(chatId(1), restoreResult())
    api.changes.undo.mockRejectedValue(new HarnessError({ code: 'conflict', message: 'A chat of this project is running.', details: { reason: 'run-active' } }))
    lastToast().options.componentProps.onUndo!()
    await flushPromises()
    expect(mock.toast.error).toHaveBeenCalledWith(REWIND_UNDO_FAILED_TITLE, { description: 'A chat of this project is running.' })
  })
})

describe('rewindResultToast', () => {
  it('renders the title, the lines and Undo (toast-undo), which also closes the toast', async () => {
    const wrapper = mount(RewindResultToast, { props: { title: 'Restored 2 files', lines: ['Skipped 1 file changed outside this chat'], undoable: true } })
    expect(wrapper.text()).toContain('Restored 2 files')
    expect(wrapper.text()).toContain('Skipped 1 file changed outside this chat')
    await wrapper.get(`[data-testid="${testIds.toastUndo}"]`).trigger('click')
    expect(wrapper.emitted('undo')).toHaveLength(1)
    expect(wrapper.emitted('closeToast')).toHaveLength(1)
    expect(mount(RewindResultToast, { props: { title: 'Nothing was restored.' } }).find(`[data-testid="${testIds.toastUndo}"]`).exists()).toBe(false)
  })
})
