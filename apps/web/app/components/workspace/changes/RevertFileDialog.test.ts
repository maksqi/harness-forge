// RevertFileDialog (docs/UI.md 7.21, 10.5, 15): the title and text per view and status, the changed-outside warning,
// `expectedSha` (sent only when a diff was loaded), the "Reverted {path}" toast with Undo, `reverted`, the error toasts
// (409 run-active / stale, 404, 400, a skipped file) and no dismissing while the request runs.
import type { RestoreResult } from '@harness-forge/shared'
import type { ChangesRow, ChangesView } from './changes-rows'
import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { testIds } from '~/utils/testids'
import { changeBatchId, changesRow, chatId, restoreResult } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { CHANGES_PANEL_CONTEXT } from './changes-context'
import RevertedToast from './RevertedToast.vue'
import RevertFileDialog from './RevertFileDialog.vue'

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
  document.body.replaceChildren()
})

// Unmount every tree after each test (before the next one changes the shared panel state).
enableAutoUnmount(afterEach)

interface Options {
  view?: ChangesView
  row?: ChangesRow | null
  expectedSha?: string | null
}

function mountDialog(options: Options = {}) {
  const open = ref(true)
  const updates: boolean[] = []
  const reverted: Array<[RestoreResult, string]> = []
  const context = { diffLoaded: vi.fn(), revertStale: vi.fn() }
  const props: Record<string, unknown> = {
    'chatId': chatId(1),
    'view': options.view ?? 'chat',
    'row': options.row === undefined ? changesRow({ path: 'src/parser.ts' }) : options.row,
    'onUpdate:open': (value: boolean) => {
      updates.push(value)
      open.value = value
    },
    'onReverted': (result: RestoreResult, path: string) => reverted.push([result, path]),
  }
  if ('expectedSha' in options)
    props.expectedSha = options.expectedSha
  const wrapper = mount(defineComponent({ setup: () => () => h(RevertFileDialog as never, { ...props, open: open.value }) }), {
    attachTo: document.body,
    global: { provide: { [CHANGES_PANEL_CONTEXT as symbol]: context } },
  })
  return { wrapper, open, updates, reverted, context }
}

function dialogText(): string {
  return document.body.querySelector('[data-slot="confirm-dialog"]')?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
}

function confirmButton(): HTMLButtonElement {
  return document.body.querySelector<HTMLButtonElement>(`[data-testid="${testIds.changesRevertConfirm}"]`)!
}

describe('revertFileDialog: copy', () => {
  it('is closed without a row', async () => {
    mountDialog({ row: null })
    await flushPromises()
    expect(confirmButton()).toBeNull()
  })

  it.each([
    ['chat', changesRow({ path: 'src/parser.ts' }), 'Revert parser.ts?', 'src/parser.ts goes back to how it was before this chat changed it.'],
    ['chat', changesRow({ path: 'src/lexer.ts', status: 'added' }), 'Revert lexer.ts?', 'src/lexer.ts is deleted. This chat created it.'],
    ['git', changesRow({ path: 'src/parser.ts' }), 'Revert parser.ts?', 'src/parser.ts goes back to the last commit.'],
    ['git', changesRow({ path: 'notes.txt', status: 'untracked' }), 'Revert notes.txt?', 'notes.txt is deleted. Git doesn\'t track it.'],
    ['git', changesRow({ path: 'new.ts', status: 'added' }), 'Revert new.ts?', 'new.ts is deleted. It isn\'t in the last commit.'],
    ['git', changesRow({ path: 'src/lexer.ts', origPath: 'src/lex.ts', status: 'renamed' }), 'Revert lexer.ts?', 'src/lex.ts comes back and src/lexer.ts is deleted.'],
  ] as const)('%s view, %o', async (view, row, title, text) => {
    mountDialog({ view, row })
    await flushPromises()
    expect(dialogText()).toContain(title)
    expect(dialogText()).toContain(text)
    expect(dialogText()).toContain('The current version is saved first, so you can undo this.')
    expect(dialogText()).not.toContain('changed outside this chat')
    expect(confirmButton().textContent?.trim()).toBe('Revert file')
  })

  it('warns when the file changed outside this chat', async () => {
    mountDialog({ row: changesRow({ path: 'README.md', changedOutside: true }) })
    await flushPromises()
    expect(dialogText()).toContain('It also changed outside this chat after the agent\'s last edit. Those changes are reverted too.')
  })
})

describe('revertFileDialog: revert', () => {
  it('sends the shown currentSha, closes, shows "Reverted {path}" with Undo and emits reverted', async () => {
    const result = restoreResult({ restored: ['src/parser.ts'] })
    api.changes.revert.mockResolvedValueOnce(result)
    const { updates, reverted } = mountDialog({ expectedSha: 'a'.repeat(64) })
    await flushPromises()
    confirmButton().click()
    await flushPromises()
    expect(api.changes.revert).toHaveBeenCalledWith({ params: { id: chatId(1) }, body: { source: 'chat', path: 'src/parser.ts', expectedSha: 'a'.repeat(64) } })
    expect(updates).toEqual([false])
    expect(reverted).toEqual([[result, 'src/parser.ts']])
    const [component, options] = mocks.toast.custom.mock.lastCall as [unknown, { componentProps: { title: string, onUndo: () => void } }]
    expect(component).toBe(RevertedToast)
    expect(options.componentProps.title).toBe('Reverted src/parser.ts')

    api.changes.undo.mockResolvedValueOnce(restoreResult({ batchId: changeBatchId(2) }))
    options.componentProps.onUndo()
    await flushPromises()
    expect(api.changes.undo).toHaveBeenCalledWith({ params: { id: chatId(1) }, body: { batchId: changeBatchId(1), conflicts: 'skip' } })
    expect(mocks.toast.success).toHaveBeenLastCalledWith('Restored src/parser.ts')
  })

  it('sends null for a diff that showed the file missing, and nothing when no diff was loaded', async () => {
    api.changes.revert.mockResolvedValue(restoreResult())
    const missing = mountDialog({ view: 'git', expectedSha: null })
    await flushPromises()
    confirmButton().click()
    await flushPromises()
    expect(api.changes.revert).toHaveBeenLastCalledWith({ params: { id: chatId(1) }, body: { source: 'git', path: 'src/parser.ts', expectedSha: null } })
    missing.wrapper.unmount()

    mountDialog()
    await flushPromises()
    confirmButton().click()
    await flushPromises()
    expect(api.changes.revert).toHaveBeenLastCalledWith({ params: { id: chatId(1) }, body: { source: 'chat', path: 'src/parser.ts' } })
  })

  it('cannot be dismissed while the request runs', async () => {
    let resolve: (value: RestoreResult) => void = () => {}
    api.changes.revert.mockReturnValueOnce(new Promise((done) => {
      resolve = done
    }))
    const { updates } = mountDialog()
    await flushPromises()
    confirmButton().click()
    await nextTick()
    expect(confirmButton().disabled).toBe(true)
    expect(confirmButton().getAttribute('aria-busy')).toBe('true')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await nextTick()
    expect(updates).toEqual([])
    resolve(restoreResult())
    await flushPromises()
    expect(updates).toEqual([false])
  })

  it('says "Reverted {path}" without Undo when nothing was written', async () => {
    api.changes.revert.mockResolvedValueOnce(restoreResult({ batchId: null, restored: [], unchanged: ['src/parser.ts'] }))
    const { reverted } = mountDialog()
    await flushPromises()
    confirmButton().click()
    await flushPromises()
    expect(mocks.toast.success).toHaveBeenCalledWith('Reverted src/parser.ts')
    expect(mocks.toast.custom).not.toHaveBeenCalled()
    expect(reverted).toHaveLength(1)
  })

  it('reports a skipped file as a failure', async () => {
    api.changes.revert.mockResolvedValueOnce(restoreResult({ batchId: null, restored: [], skipped: [{ path: 'src/parser.ts', reason: 'unavailable', message: 'The earlier version is no longer stored.' }] }))
    const { reverted, updates } = mountDialog()
    await flushPromises()
    confirmButton().click()
    await flushPromises()
    expect(mocks.toast.error).toHaveBeenCalledWith('Couldn\'t revert src/parser.ts', { description: 'The earlier version is no longer stored.' })
    expect(reverted).toEqual([])
    expect(updates).toEqual([false])
  })
})

describe('revertFileDialog: errors', () => {
  async function failWith(error: HarnessError, options: Options = {}) {
    api.changes.revert.mockRejectedValueOnce(error)
    api.changes.list.mockResolvedValue({ available: true, reason: null, projectId: null, files: [], truncated: false, untracked: { shellCommands: 0, toolCalls: 0 } })
    const mounted = mountDialog(options)
    await flushPromises()
    confirmButton().click()
    await flushPromises()
    expect(mounted.updates).toEqual([false])
    expect(mounted.reverted).toEqual([])
    return mounted
  }

  it('409 run-active: waits for the project\'s responses', async () => {
    await failWith(new HarnessError({ code: 'conflict', message: 'A chat of this project is running.', details: { reason: 'run-active', chatId: chatId(2) } }))
    expect(mocks.toast.error).toHaveBeenCalledWith('Wait for the responses in this project to finish before reverting files.')
    expect(api.changes.list).not.toHaveBeenCalled()
  })

  it('409 stale: says so, refreshes the view and asks the panel to reopen the row', async () => {
    const { context } = await failWith(new HarnessError({ code: 'conflict', message: 'The file changed.', details: { reason: 'stale' } }), { expectedSha: 'b'.repeat(64) })
    expect(mocks.toast.error).toHaveBeenCalledWith('src/parser.ts changed since its diff was loaded. Check it again.')
    expect(api.changes.list).toHaveBeenCalledTimes(1)
    expect(context.revertStale).toHaveBeenCalledWith('chat', 'src/parser.ts')
  })

  it('404: the stale-chat toast and a refresh', async () => {
    await failWith(new HarnessError({ code: 'not_found', message: 'Chat not found.' }))
    expect(mocks.toast.error).toHaveBeenCalledWith('This chat changed elsewhere and was reloaded.')
    expect(api.changes.list).toHaveBeenCalledTimes(1)
  })

  it('400: "Couldn\'t revert {path}" with the server message', async () => {
    await failWith(new HarnessError({ code: 'validation_error', message: 'The file is conflicted.' }), { view: 'git' })
    expect(mocks.toast.error).toHaveBeenCalledWith('Couldn\'t revert src/parser.ts', { description: 'The file is conflicted.' })
  })
})
