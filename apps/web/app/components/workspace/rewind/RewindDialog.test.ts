// RewindDialog (docs/UI.md 7.22, 10.5, 13.9, 14.1): the preview on open (loading, ready, empty, error), the file list,
// the force option, the shell commands, Restore files / Restore files and edit, the restoring state, inline errors and
// the refusals handed to the host.
import type { RestoreResult, RewindPreview } from '@harness-forge/shared'
import type { RewindDialogHost } from './rewind'
import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { testIds } from '~/utils/testids'
import { chatId, messageId, restoreResult, rewindPreview } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { REWIND_DIALOG_HOST } from './rewind'
import RewindDialog from './RewindDialog.vue'

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
  document.body.replaceChildren()
})

const U1 = messageId('u1')

function dialog(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(`[data-testid="${testIds.rewindDialog}"]`)
}

function byTestId(id: string): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`)
}

function allByTestId(id: string): HTMLElement[] {
  return [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)]
}

function button(label: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === label)
}

function mountDialog(initial: { open: boolean, messageId: string | null }, options: { host?: RewindDialogHost } = {}) {
  const state = ref(initial)
  const updates: boolean[] = []
  const restored: Array<[RestoreResult, 'none' | 'edit']> = []
  const wrapper = mount(defineComponent({
    setup: () => () => h(TooltipProvider, null, {
      default: () => h(RewindDialog, {
        'open': state.value.open,
        'chatId': chatId(1),
        'messageId': state.value.messageId,
        'onUpdate:open': (value: boolean) => {
          updates.push(value)
          state.value = { ...state.value, open: value }
        },
        'onRestored': (result: RestoreResult, then: 'none' | 'edit') => {
          restored.push([result, then])
        },
      }),
    }),
  }), {
    attachTo: document.body,
    global: options.host ? { provide: { [REWIND_DIALOG_HOST as symbol]: options.host } } : {},
  })
  return { wrapper, state, updates, restored }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

describe('rewindDialog: opening', () => {
  it('renders nothing while closed or without a message', async () => {
    mountDialog({ open: false, messageId: U1 })
    await flushPromises()
    expect(dialog()).toBeNull()
    mountDialog({ open: true, messageId: null })
    await flushPromises()
    expect(dialog()).toBeNull()
    expect(api.changes.rewindPreview).not.toHaveBeenCalled()
  })

  it('loads the preview with a skeleton meanwhile and aborts it when closed', async () => {
    const answer = deferred<RewindPreview>()
    api.changes.rewindPreview.mockReturnValue(answer.promise)
    const { updates } = mountDialog({ open: true, messageId: U1 })
    await flushPromises()
    expect(dialog()?.dataset.state).toBe('loading')
    expect(dialog()?.textContent).toContain('Rewind files to here?')
    expect(dialog()?.textContent).toContain('Files the agent changed after this message go back to how they were before it. The conversation stays as it is.')
    expect(document.body.querySelector('[data-slot="rewind-loading"]')).not.toBeNull()
    expect(api.changes.rewindPreview).toHaveBeenCalledWith({ params: { id: chatId(1) }, query: { messageId: U1 }, signal: expect.any(AbortSignal) })
    const signal = (api.changes.rewindPreview.mock.calls[0]![0] as { signal: AbortSignal }).signal
    expect(byTestId(testIds.rewindRestore)).toBeNull()

    button('Cancel')!.click()
    await flushPromises()
    expect(updates).toEqual([false])
    expect(signal.aborted).toBe(true)
    answer.resolve(rewindPreview())
    await flushPromises()
    expect(api.changes.rewind).not.toHaveBeenCalled()
  })
})

describe('rewindDialog: the preview', () => {
  it('lists the files to restore or delete, the conflict option, the shell commands and other tools', async () => {
    const commands = Array.from({ length: 12 }, (_, index) => ({ command: `echo ${index}\necho second line`, at: 1_000 - index, messageId: messageId('a1') }))
    api.changes.rewindPreview.mockResolvedValue(rewindPreview({
      files: [
        { path: 'src/parser.ts', action: 'restore', conflict: false, edits: 2 },
        { path: 'src/lexer.ts', action: 'delete', conflict: false, edits: 1 },
        { path: 'README.md', action: 'restore', conflict: true, edits: 1 },
        { path: 'big.bin', action: 'unavailable', conflict: false, edits: 1 },
        { path: 'same.txt', action: 'unchanged', conflict: false, edits: 1 },
      ],
      untracked: {
        shellCount: 14,
        shell: commands,
        tools: [{ tool: 'mcp__fs__write', at: 1, messageId: null }, { tool: 'mcp__fs__write', at: 2, messageId: null }, { tool: 'patch', at: 3, messageId: null }],
      },
      truncated: true,
    }))
    mountDialog({ open: true, messageId: U1 })
    await flushPromises()
    expect(dialog()?.dataset.state).toBe('ready')

    const files = allByTestId(testIds.rewindFile)
    expect(files.map(file => [file.dataset.path, file.dataset.action, file.dataset.conflict])).toEqual([
      ['src/parser.ts', 'restore', undefined],
      ['src/lexer.ts', 'delete', undefined],
      ['README.md', 'restore', 'true'],
      ['big.bin', 'unavailable', undefined],
    ])
    // The badge closes each row (text, so screen readers read the action).
    expect(files.map(file => file.lastElementChild?.textContent?.trim())).toEqual(['Restore', 'Delete', 'Restore', 'Can\'t restore'])
    expect(files[3]!.lastElementChild!.getAttribute('tabindex')).toBe('0')
    expect(files[2]!.textContent).toContain('changed outside this chat')
    expect(dialog()!.textContent).toContain('and more files')

    const force = byTestId(testIds.rewindForce)!
    expect(force.dataset.state).toBe('unchecked')
    expect(dialog()!.textContent).toContain('Also restore files changed outside this chat')

    expect(dialog()!.textContent).toContain('Shell changes aren\'t tracked.')
    expect(dialog()!.textContent).toContain('These commands ran after this message; their effects on files stay:')
    const shown = allByTestId(testIds.rewindShellCommand)
    expect(shown).toHaveLength(10)
    expect(shown[0]!.textContent?.trim()).toBe('echo 0')
    expect(shown[0]!.title).toBe('echo 0\necho second line')
    expect(dialog()!.textContent).toContain('and 4 more')
    expect(dialog()!.textContent).toContain('Other tools changed files too: mcp__fs__write, patch. Their changes stay.')

    // Focus starts on Restore files; Cancel · Restore files and edit · Restore files.
    expect(document.activeElement).toBe(byTestId(testIds.rewindRestore))
    expect(byTestId(testIds.rewindRestoreEdit)?.textContent?.trim()).toBe('Restore files and edit')
    expect(button('Cancel')).toBeDefined()
  })

  it('leaves out the conflict option and the command warning when there is nothing to show', async () => {
    api.changes.rewindPreview.mockResolvedValue(rewindPreview({ untracked: { shellCount: 0, shell: [], tools: [] } }))
    mountDialog({ open: true, messageId: U1 })
    await flushPromises()
    expect(allByTestId(testIds.rewindFile)).toHaveLength(1)
    expect(byTestId(testIds.rewindForce)).toBeNull()
    expect(document.body.querySelector('[data-slot="rewind-shell"]')).toBeNull()
    expect(dialog()!.textContent).toContain('Shell changes aren\'t tracked.')
    expect(dialog()!.textContent).not.toContain('and more files')
    expect(dialog()!.textContent).not.toContain('Other tools changed files too')
  })

  it('an empty preview has nothing to restore and offers Close only', async () => {
    api.changes.rewindPreview.mockResolvedValue(rewindPreview({ files: [{ path: 'same.txt', action: 'unchanged', conflict: false, edits: 1 }] }))
    const { updates } = mountDialog({ open: true, messageId: U1 })
    await flushPromises()
    expect(dialog()?.dataset.state).toBe('empty')
    expect(dialog()!.textContent).toContain('Nothing to restore. The files already match.')
    expect(allByTestId(testIds.rewindFile)).toHaveLength(0)
    expect(byTestId(testIds.rewindRestore)).toBeNull()
    expect(byTestId(testIds.rewindRestoreEdit)).toBeNull()
    expect(button('Cancel')).toBeUndefined()
    // The commands that ran stay listed.
    expect(allByTestId(testIds.rewindShellCommand)).toHaveLength(1)
    const close = button('Close')!
    expect(document.activeElement).toBe(close)
    close.click()
    await flushPromises()
    expect(updates).toEqual([false])
  })
})

describe('rewindDialog: restoring', () => {
  it('restores with conflicts skipped, cannot be dismissed meanwhile, then reports the result and closes', async () => {
    api.changes.rewindPreview.mockResolvedValue(rewindPreview())
    const answer = deferred<RestoreResult>()
    api.changes.rewind.mockReturnValue(answer.promise)
    const { updates, restored } = mountDialog({ open: true, messageId: U1 })
    await flushPromises()
    byTestId(testIds.rewindRestore)!.click()
    await flushPromises()
    expect(api.changes.rewind).toHaveBeenCalledWith({ params: { id: chatId(1) }, body: { messageId: U1, conflicts: 'skip' } })
    expect(dialog()?.dataset.state).toBe('restoring')
    expect((byTestId(testIds.rewindRestore) as HTMLButtonElement).disabled).toBe(true)
    expect(byTestId(testIds.rewindRestore)!.getAttribute('aria-busy')).toBe('true')
    expect(button('Cancel')!.disabled).toBe(true)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(updates).toEqual([])
    expect(dialog()).not.toBeNull()

    const result = restoreResult()
    answer.resolve(result)
    await flushPromises()
    expect(restored).toEqual([[result, 'none']])
    expect(updates).toEqual([false])
  })

  it('"Also restore files changed outside this chat" forces, and Restore files and edit asks for the editor', async () => {
    api.changes.rewindPreview.mockResolvedValue(rewindPreview({ files: [{ path: 'README.md', action: 'restore', conflict: true, edits: 1 }] }))
    api.changes.rewind.mockResolvedValue(restoreResult())
    const { restored } = mountDialog({ open: true, messageId: U1 })
    await flushPromises()
    byTestId(testIds.rewindForce)!.click()
    await flushPromises()
    expect(byTestId(testIds.rewindForce)!.dataset.state).toBe('checked')
    byTestId(testIds.rewindRestoreEdit)!.click()
    await flushPromises()
    expect(api.changes.rewind).toHaveBeenCalledWith({ params: { id: chatId(1) }, body: { messageId: U1, conflicts: 'force' } })
    expect(restored.map(([, then]) => then)).toEqual(['edit'])
  })

  it('reopening starts over: the force option is unchecked again', async () => {
    api.changes.rewindPreview.mockResolvedValue(rewindPreview({ files: [{ path: 'README.md', action: 'restore', conflict: true, edits: 1 }] }))
    const { state } = mountDialog({ open: true, messageId: U1 })
    await flushPromises()
    byTestId(testIds.rewindForce)!.click()
    await flushPromises()
    state.value = { open: false, messageId: null }
    await flushPromises()
    state.value = { open: true, messageId: U1 }
    await flushPromises()
    expect(api.changes.rewindPreview).toHaveBeenCalledTimes(2)
    expect(byTestId(testIds.rewindForce)!.dataset.state).toBe('unchecked')
  })
})

describe('rewindDialog: failures', () => {
  it('shows a failed preview inline with its code and offers Close', async () => {
    api.changes.rewindPreview.mockRejectedValue(new HarnessError({ code: 'validation_error', message: 'The project folder /srv/x is not available: missing' }))
    mountDialog({ open: true, messageId: U1 })
    await flushPromises()
    expect(dialog()?.dataset.state).toBe('error')
    const error = byTestId(testIds.rewindError)!
    expect(error.dataset.code).toBe('validation_error')
    expect(error.getAttribute('role')).toBe('alert')
    expect(error.textContent).toContain('Couldn\'t check the files')
    expect(error.textContent).toContain('The project folder /srv/x is not available: missing')
    expect(button('Close')).toBeDefined()
    expect(byTestId(testIds.rewindRestore)).toBeNull()
  })

  it('shows a failed restore inline, keeps the preview and lets the user try again', async () => {
    api.changes.rewindPreview.mockResolvedValue(rewindPreview())
    api.changes.rewind.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'The disk is full.' }))
    const { updates, restored } = mountDialog({ open: true, messageId: U1 })
    await flushPromises()
    byTestId(testIds.rewindRestore)!.click()
    await flushPromises()
    expect(dialog()?.dataset.state).toBe('error')
    expect(byTestId(testIds.rewindError)?.dataset.code).toBe('internal_error')
    expect(byTestId(testIds.rewindError)?.textContent).toContain('Couldn\'t restore the files')
    expect(allByTestId(testIds.rewindFile)).toHaveLength(1)
    expect(updates).toEqual([])
    expect(restored).toEqual([])
    expect(document.activeElement).toBe(byTestId(testIds.rewindRestore))

    api.changes.rewind.mockResolvedValueOnce(restoreResult())
    byTestId(testIds.rewindRestore)!.click()
    await flushPromises()
    expect(restored).toHaveLength(1)
    expect(updates).toEqual([false])
  })

  it('hands a 404 or a running project to the host and closes; without a host they show inline', async () => {
    const refused = vi.fn()
    api.changes.rewindPreview.mockRejectedValueOnce(new HarnessError({ code: 'not_found', message: 'Message not found.' }))
    const first = mountDialog({ open: true, messageId: U1 }, { host: { refused } })
    await flushPromises()
    expect(refused).toHaveBeenCalledOnce()
    expect(refused.mock.calls[0]![0]).toMatchObject({ code: 'not_found' })
    expect(first.updates).toEqual([false])
    first.wrapper.unmount()
    document.body.replaceChildren()

    api.changes.rewindPreview.mockResolvedValue(rewindPreview())
    const running = new HarnessError({ code: 'conflict', message: 'A chat of this project is running.', details: { reason: 'run-active', chatId: chatId(2) } })
    api.changes.rewind.mockRejectedValueOnce(running)
    const second = mountDialog({ open: true, messageId: U1 }, { host: { refused } })
    await flushPromises()
    byTestId(testIds.rewindRestore)!.click()
    await flushPromises()
    expect(refused).toHaveBeenLastCalledWith(running)
    expect(second.updates).toEqual([false])
    expect(second.restored).toEqual([])
    second.wrapper.unmount()
    document.body.replaceChildren()

    api.changes.rewind.mockRejectedValueOnce(running)
    const third = mountDialog({ open: true, messageId: U1 })
    await flushPromises()
    byTestId(testIds.rewindRestore)!.click()
    await flushPromises()
    expect(byTestId(testIds.rewindError)?.dataset.code).toBe('conflict')
    expect(third.updates).toEqual([])
    expect(refused).toHaveBeenCalledTimes(2)
  })
})
