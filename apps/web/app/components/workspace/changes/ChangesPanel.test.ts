// ChangesPanel (docs/UI.md 7.21, 10.5, 14): the header (h2, view tabs, Refresh, Close), the states of the 7.21 table,
// the summary and footer notes, the rows with lazy diffs, the refresh triggers it owns (mount, view switch, Refresh,
// window focus on the Git view) and the revert flow (expectedSha from the shown diff, the polite announcement, focus to
// the next row, a stale revert reopening the row).
import type { ChatChanges, GitStatus } from '@harness-forge/shared'
import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { CHANGES_VIEW_KEY, useChangesPanel } from '~/composables/useChangesPanel'
import { testIds } from '~/utils/testids'
import { chatChangeFile, chatChanges, chatId, fileDiff, gitStatus, gitStatusFile, projectId, restoreResult } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { stubLocalStorage } from '~/utils/testing/storage'
import ChangesPanel from './ChangesPanel.vue'

const mocks = vi.hoisted(() => ({
  api: null as unknown,
  toast: Object.assign(vi.fn(), { custom: vi.fn(), error: vi.fn(), success: vi.fn(), dismiss: vi.fn() }),
}))
vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api }))
vi.mock('vue-sonner', () => ({ toast: mocks.toast }))

let pinia: ReturnType<typeof createPinia>
let api: MockApi
let storage: Storage

beforeEach(() => {
  storage = stubLocalStorage()
  api = createMockApi()
  mocks.api = api
  for (const fn of [mocks.toast, mocks.toast.custom, mocks.toast.error, mocks.toast.success])
    fn.mockReset()
  pinia = createPinia()
  setActivePinia(pinia)
  useChangesPanel().view.value = 'chat'
})

afterEach(() => {
  useChangesPanel().view.value = 'chat'
  disposePinia(pinia)
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

// Unmount every tree after each test (before the next one changes the shared panel state).
enableAutoUnmount(afterEach)

const threeFiles = chatChanges({
  files: [
    chatChangeFile({ path: 'src/parser.ts', added: 12, removed: 3 }),
    chatChangeFile({ path: 'src/lexer.ts', status: 'added', added: 10, removed: 0 }),
    chatChangeFile({ path: 'old/util.ts', status: 'deleted', added: 0, removed: 4, changedOutside: true }),
  ],
  untracked: { shellCommands: 3, toolCalls: 1 },
})

function mountPanel(options: { variant?: 'pane' | 'sheet', onClose?: () => void } = {}) {
  return mount(defineComponent({
    setup: () => () => h(TooltipProvider, null, {
      default: () => h(ChangesPanel, { chatId: chatId(1), projectId: projectId(1), variant: options.variant ?? 'pane', onClose: options.onClose }),
    }),
  }), { attachTo: document.body })
}

function el(id: string): HTMLElement {
  const found = document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  if (!found)
    throw new Error(`no ${id}`)
  return found
}

function maybe(id: string): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`)
}

function rows(): HTMLElement[] {
  return [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${testIds.changesFile}"]`)]
}

function row(path: string): HTMLElement {
  const found = rows().find(item => item.dataset.path === path)
  if (!found)
    throw new Error(`no row ${path}`)
  return found
}

function tab(value: 'chat' | 'git'): HTMLElement {
  return [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${testIds.changesViewOption}"]`)].find(item => item.dataset.value === value)!
}

async function selectTab(value: 'chat' | 'git') {
  tab(value).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
  await flushPromises()
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('changesPanel: header and states', () => {
  it('shows 3 skeleton rows on the first load, then the summary, the rows and the notes', async () => {
    const answer = deferred<ChatChanges>()
    api.changes.list.mockReturnValueOnce(answer.promise)
    mountPanel()
    await nextTick()
    const panel = el(testIds.changesPanel)
    expect(panel.dataset).toMatchObject({ view: 'chat', state: 'loading' })
    expect(panel.id).toBe('hf-changes-panel')
    expect(panel.querySelector('h2')?.textContent?.trim()).toBe('Changes')
    expect(panel.querySelector('h2')?.id).toBe('hf-changes-heading')
    expect(panel.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThanOrEqual(3)
    expect(el(testIds.changesRefresh).getAttribute('aria-busy')).toBe('true')
    expect(el(testIds.changesRefresh).getAttribute('aria-label')).toBe('Refresh changes')
    expect(el(testIds.changesClose).getAttribute('aria-label')).toBe('Close changes')
    expect(tab('chat').dataset.state).toBe('active')
    expect(tab('chat').textContent?.trim()).toBe('This chat')
    expect(tab('git').textContent?.trim()).toBe('Git')

    answer.resolve(threeFiles)
    await flushPromises()
    expect(panel.dataset.state).toBe('ready')
    expect(el(testIds.changesRefresh).hasAttribute('aria-busy')).toBe(false)
    expect(el(testIds.changesSummary).textContent?.trim()).toBe('3 files changed · +22 −7')
    expect(el(testIds.changesSummary).dataset.count).toBe('3')
    expect(rows().map(item => item.dataset.path)).toEqual(['src/parser.ts', 'src/lexer.ts', 'old/util.ts'])
    expect(row('old/util.ts').dataset.conflict).toBe('true')
    expect(panel.querySelector('[data-slot="changes-untracked"]')?.textContent?.trim())
      .toBe('3 shell commands and 1 other tool call in this chat may have changed files too. They aren\'t listed here.')
    expect(panel.querySelector('[data-slot="changes-truncated"]')).toBeNull()
  })

  it('shows the capped-list footer and the empty state of This chat', async () => {
    api.changes.list.mockResolvedValueOnce(chatChanges({ truncated: true }))
    const first = mountPanel()
    await flushPromises()
    expect(document.body.querySelector('[data-slot="changes-truncated"]')?.textContent?.trim()).toBe('Showing the first 500 files.')
    first.unmount()

    api.changes.list.mockResolvedValueOnce(chatChanges({ files: [chatChangeFile({ status: 'unchanged' })] }))
    mountPanel()
    await flushPromises()
    expect(el(testIds.changesPanel).dataset.state).toBe('ready')
    expect(el(testIds.changesEmpty).dataset.reason).toBe('none')
    expect(el(testIds.changesEmpty).textContent?.trim()).toBe('No file changes in this chat yet.')
    expect(maybe(testIds.changesSummary)).toBeNull()
  })

  it.each([
    ['chat', { available: false, reason: 'folder-unavailable', files: [] }, 'folder-unavailable', 'The project folder wasn\'t found.'],
    ['git', { available: false, reason: 'not-a-repo', branch: null, head: null, files: [] }, 'not-a-repo', 'This project isn\'t a Git repository.'],
    ['git', { available: false, reason: 'git-missing', branch: null, head: null, files: [] }, 'git-missing', 'Git isn\'t installed on the server.'],
    ['git', { available: false, reason: 'refused', branch: null, head: null, files: [] }, 'refused', 'Git refused to read this repository. It may belong to another user (see the projects guide).'],
  ] as const)('%s view unavailable: %o', async (view, overrides, reason, text) => {
    useChangesPanel().view.value = view
    if (view === 'chat')
      api.changes.list.mockResolvedValueOnce(chatChanges(overrides as unknown as Partial<ChatChanges>))
    else
      api.changes.git.mockResolvedValueOnce(gitStatus(overrides as unknown as Partial<GitStatus>))
    mountPanel()
    await flushPromises()
    expect(el(testIds.changesPanel).dataset.state).toBe('unavailable')
    expect(el(testIds.changesEmpty).dataset.reason).toBe(reason)
    expect(el(testIds.changesEmpty).textContent?.trim()).toBe(text)
    expect(maybe(testIds.changesSummary)).toBeNull()
  })

  it('shows "On {branch}" and the clean state of a clean Git tree', async () => {
    useChangesPanel().view.value = 'git'
    api.changes.git.mockResolvedValueOnce(gitStatus({ files: [] }))
    mountPanel()
    await flushPromises()
    expect(el(testIds.changesPanel).dataset).toMatchObject({ view: 'git', state: 'ready' })
    expect(el(testIds.changesSummary).textContent?.trim()).toBe('On main')
    expect(el(testIds.changesSummary).dataset.count).toBe('0')
    expect(el(testIds.changesEmpty).dataset.reason).toBe('clean')
    expect(api.changes.list).not.toHaveBeenCalled()
  })

  it('shows the error alert with Retry; earlier rows stay', async () => {
    api.changes.list.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'The server failed.' }))
    mountPanel()
    await flushPromises()
    expect(el(testIds.changesPanel).dataset.state).toBe('error')
    expect(el(testIds.changesError).dataset.code).toBe('internal_error')
    expect(el(testIds.changesError).textContent).toContain('Couldn\'t load the changes')
    expect(el(testIds.changesError).textContent).toContain('The server failed.')

    api.changes.list.mockResolvedValueOnce(threeFiles)
    el(testIds.changesError).querySelector('button')!.click()
    await flushPromises()
    expect(el(testIds.changesPanel).dataset.state).toBe('ready')
    expect(maybe(testIds.changesError)).toBeNull()

    api.changes.list.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'Again.' }))
    el(testIds.changesRefresh).click()
    await flushPromises()
    expect(el(testIds.changesPanel).dataset.state).toBe('error')
    expect(rows()).toHaveLength(3)
  })

  it('emits close', async () => {
    api.changes.list.mockResolvedValue(threeFiles)
    const onClose = vi.fn()
    mountPanel({ variant: 'sheet', onClose })
    await flushPromises()
    expect(el(testIds.changesClose).className).toContain('size-10')
    el(testIds.changesClose).click()
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('changesPanel: views and refresh', () => {
  it('switches to Git (persisted), loads it, and reloads Git on window focus only while it shows', async () => {
    api.changes.list.mockResolvedValue(threeFiles)
    api.changes.git.mockResolvedValue(gitStatus({ files: [gitStatusFile(), gitStatusFile({ path: 'src/merge.ts', status: 'conflicted' })] }))
    mountPanel()
    await flushPromises()
    window.dispatchEvent(new Event('focus'))
    await flushPromises()
    expect(api.changes.git).not.toHaveBeenCalled()

    await selectTab('git')
    expect(useChangesPanel().view.value).toBe('git')
    expect(storage.getItem(CHANGES_VIEW_KEY)).toBe('git')
    expect(el(testIds.changesPanel).dataset.view).toBe('git')
    expect(api.changes.git).toHaveBeenCalledTimes(1)
    expect(el(testIds.changesSummary).textContent?.trim()).toBe('On main · 2 files changed')
    expect(row('src/merge.ts').querySelector(`[data-testid="${testIds.changesFileRevert}"]`)).toBeNull()
    expect(row('src/index.ts').querySelector(`[data-testid="${testIds.changesFileRevert}"]`)).not.toBeNull()

    window.dispatchEvent(new Event('focus'))
    await flushPromises()
    expect(api.changes.git).toHaveBeenCalledTimes(2)

    await selectTab('chat')
    expect(api.changes.list).toHaveBeenCalledTimes(2)
  })

  it('refresh reloads the view and the diffs of open rows', async () => {
    api.changes.list.mockResolvedValue(threeFiles)
    api.changes.diff.mockResolvedValue(fileDiff({ path: 'src/parser.ts' }))
    mountPanel()
    await flushPromises()
    row('src/parser.ts').querySelector<HTMLElement>('button[aria-expanded]')!.click()
    await flushPromises()
    expect(row('src/parser.ts').dataset.state).toBe('open')
    expect(api.changes.diff).toHaveBeenCalledWith({ params: { id: chatId(1) }, query: { source: 'chat', path: 'src/parser.ts' }, signal: expect.any(AbortSignal) })
    expect(row('src/parser.ts').querySelector('[data-slot="changes-diff"]')?.getAttribute('data-state')).toBe('ready')

    el(testIds.changesRefresh).click()
    await flushPromises()
    expect(api.changes.list).toHaveBeenCalledTimes(2)
    expect(api.changes.diff).toHaveBeenCalledTimes(2)

    row('src/parser.ts').querySelector<HTMLElement>('button[aria-expanded]')!.click()
    await flushPromises()
    expect(row('src/parser.ts').dataset.state).toBe('closed')
    expect(row('src/parser.ts').querySelector('[data-slot="changes-diff"]')).toBeNull()
  })
})

describe('changesPanel: revert', () => {
  async function revertFrom(path: string) {
    row(path).querySelector<HTMLElement>(`[data-testid="${testIds.changesFileRevert}"]`)!.click()
    await flushPromises()
    el(testIds.changesRevertConfirm).click()
    await flushPromises()
    await new Promise(resolve => setTimeout(resolve, 0))
    await flushPromises()
  }

  it('sends the sha of the diff the user saw, announces the revert and moves focus to the next row', async () => {
    api.changes.list.mockResolvedValue(threeFiles)
    api.changes.diff.mockResolvedValue(fileDiff({ path: 'src/parser.ts', currentSha: 'c'.repeat(64) }))
    api.changes.revert.mockResolvedValue(restoreResult({ restored: ['src/parser.ts'] }))
    mountPanel()
    await flushPromises()
    row('src/parser.ts').querySelector<HTMLElement>('button[aria-expanded]')!.click()
    await flushPromises()

    await revertFrom('src/parser.ts')
    expect(api.changes.revert).toHaveBeenCalledWith({ params: { id: chatId(1) }, body: { source: 'chat', path: 'src/parser.ts', expectedSha: 'c'.repeat(64) } })
    const region = document.body.querySelector('[aria-live="polite"]')!
    expect(region.textContent?.trim()).toBe('Reverted src/parser.ts')
    expect(region.getAttribute('aria-atomic')).toBe('true')
    expect(document.activeElement).toBe(row('src/lexer.ts').querySelector('button[aria-expanded]'))
    expect(mocks.toast.custom).toHaveBeenCalledTimes(1)
  })

  it('sends no sha for a row whose diff was never shown; the last row moves focus to the previous one', async () => {
    api.changes.list.mockResolvedValue(threeFiles)
    api.changes.revert.mockResolvedValue(restoreResult({ restored: [], deleted: ['old/util.ts'] }))
    mountPanel()
    await flushPromises()
    await revertFrom('old/util.ts')
    expect(api.changes.revert).toHaveBeenCalledWith({ params: { id: chatId(1) }, body: { source: 'chat', path: 'old/util.ts' } })
    expect(document.activeElement).toBe(row('src/lexer.ts').querySelector('button[aria-expanded]'))
  })

  it('moves focus to the view tabs when no other row is left', async () => {
    api.changes.list.mockResolvedValue(chatChanges({ files: [chatChangeFile({ path: 'only.ts' })] }))
    api.changes.revert.mockResolvedValue(restoreResult({ restored: ['only.ts'] }))
    mountPanel()
    await flushPromises()
    await revertFrom('only.ts')
    expect(document.activeElement).toBe(tab('chat'))
  })

  it('returns focus to the row\'s Revert button when the dialog is canceled', async () => {
    api.changes.list.mockResolvedValue(threeFiles)
    mountPanel()
    await flushPromises()
    const revert = row('src/lexer.ts').querySelector<HTMLElement>(`[data-testid="${testIds.changesFileRevert}"]`)!
    revert.click()
    await flushPromises()
    expect(document.body.textContent).toContain('Revert lexer.ts?')
    document.body.querySelector<HTMLElement>('[data-slot="alert-dialog-cancel"]')!.click()
    await flushPromises()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(maybe(testIds.changesRevertConfirm)).toBeNull()
    expect(document.activeElement).toBe(revert)
    expect(api.changes.revert).not.toHaveBeenCalled()
  })

  it('reopens the row after a stale revert so its diff reloads', async () => {
    api.changes.list.mockResolvedValue(threeFiles)
    api.changes.diff.mockResolvedValue(fileDiff({ path: 'src/lexer.ts' }))
    api.changes.revert.mockRejectedValueOnce(new HarnessError({ code: 'conflict', message: 'The file changed.', details: { reason: 'stale' } }))
    mountPanel()
    await flushPromises()
    expect(row('src/lexer.ts').dataset.state).toBe('closed')
    await revertFrom('src/lexer.ts')
    expect(mocks.toast.error).toHaveBeenCalledWith('src/lexer.ts changed since its diff was loaded. Check it again.')
    expect(row('src/lexer.ts').dataset.state).toBe('open')
    expect(api.changes.list).toHaveBeenCalledTimes(2)
    expect(api.changes.diff).toHaveBeenCalled()
  })
})
