// The revert toasts (docs/UI.md 7.21, 15): the failure kinds, Undo's outcomes ("Restored {path}", "{path} changed after
// the revert, so it was not restored.") and its errors, and the Undo button of RevertedToast (toast-undo).
import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { testIds } from '~/utils/testids'
import { changeBatchId, chatId, restoreResult } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { REVERT_UNDO_MS, revertFailure, showReverted, undoRevert } from './revert-toasts'
import RevertedToast from './RevertedToast.vue'

const mocks = vi.hoisted(() => ({
  api: null as unknown,
  toast: Object.assign(vi.fn(), { custom: vi.fn(), error: vi.fn(), success: vi.fn(), dismiss: vi.fn() }),
}))
vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api }))
vi.mock('vue-sonner', () => ({ toast: mocks.toast }))

let pinia: ReturnType<typeof createPinia>
let api: MockApi

beforeEach(() => {
  api = createMockApi()
  mocks.api = api
  for (const fn of [mocks.toast, mocks.toast.custom, mocks.toast.error, mocks.toast.success])
    fn.mockReset()
  pinia = createPinia()
  setActivePinia(pinia)
})

afterEach(() => {
  disposePinia(pinia)
})

describe('revertFailure', () => {
  it('reads the conflict reason, not_found, or anything else', () => {
    const conflict = (details?: unknown) => new HarnessError({ code: 'conflict', message: 'x', details })
    expect(revertFailure(conflict({ reason: 'run-active', chatId: chatId(1) }))).toBe('run-active')
    expect(revertFailure(conflict())).toBe('run-active')
    expect(revertFailure(conflict({ reason: 'stale' }))).toBe('stale')
    expect(revertFailure(conflict({ reason: 'busy' }))).toBe('other')
    expect(revertFailure(new HarnessError({ code: 'not_found', message: 'x' }))).toBe('not-found')
    expect(revertFailure(new HarnessError({ code: 'validation_error', message: 'x' }))).toBe('other')
  })
})

describe('undoRevert', () => {
  it('says "Restored {path}", or that the file changed after the revert', async () => {
    api.changes.undo.mockResolvedValueOnce(restoreResult())
    await undoRevert(chatId(1), changeBatchId(1), 'src/index.ts')
    expect(api.changes.undo).toHaveBeenCalledWith({ params: { id: chatId(1) }, body: { batchId: changeBatchId(1), conflicts: 'skip' } })
    expect(mocks.toast.success).toHaveBeenLastCalledWith('Restored src/index.ts')

    api.changes.undo.mockResolvedValueOnce(restoreResult({ restored: [], skipped: [{ path: 'src/index.ts', reason: 'conflict', message: 'Changed.' }] }))
    await undoRevert(chatId(1), changeBatchId(1), 'src/index.ts')
    expect(mocks.toast).toHaveBeenLastCalledWith('src/index.ts changed after the revert, so it was not restored.')
  })

  it('never rejects: run-active waits, anything else names the file', async () => {
    api.changes.undo.mockRejectedValueOnce(new HarnessError({ code: 'conflict', message: 'Running.', details: { reason: 'run-active' } }))
    await expect(undoRevert(chatId(1), changeBatchId(1), 'a.ts')).resolves.toBeUndefined()
    expect(mocks.toast.error).toHaveBeenLastCalledWith('Wait for the responses in this project to finish before reverting files.')
    api.changes.undo.mockRejectedValueOnce(new HarnessError({ code: 'not_found', message: 'Change batch not found.' }))
    await undoRevert(chatId(1), changeBatchId(1), 'a.ts')
    expect(mocks.toast.error).toHaveBeenLastCalledWith('Couldn\'t restore a.ts', { description: 'Change batch not found.' })
  })
})

describe('showReverted and RevertedToast', () => {
  it('offers Undo for a batch for a while; the button carries toast-undo and closes the toast', async () => {
    showReverted(chatId(1), 'src/index.ts', restoreResult())
    const [component, options] = mocks.toast.custom.mock.lastCall as [unknown, { duration: number, componentProps: { title: string, onUndo: () => void } }]
    expect(component).toBe(RevertedToast)
    expect(options.duration).toBe(REVERT_UNDO_MS)

    const undo = vi.fn()
    const wrapper = mount(RevertedToast, { props: { title: options.componentProps.title, onUndo: undo } })
    expect(wrapper.text()).toContain('Reverted src/index.ts')
    await wrapper.get(`[data-testid="${testIds.toastUndo}"]`).trigger('click')
    expect(undo).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('closeToast')).toHaveLength(1)
  })
})
