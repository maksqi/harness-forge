// StorageCleanupSection (docs/UI.md 9.8, 10.4; docs/API.md 5.19; W7.13): Check for unused files and its summary,
// "No unused files.", Remove… with its confirmation, the result toast, the reloads afterwards and the busy answers.
import type { DataCleanupPreview, DataCleanupResult } from '@harness-forge/shared'
import type { VueWrapper } from '@vue/test-utils'
import type { Mock } from 'vitest'
import type { DataSettingsContext } from './data-context'
import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { testIds } from '~/utils/testids'
import { dataCleanupPreview } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { BUSY_MESSAGE } from './data'
import { dataSettingsContextKey } from './data-context'
import StorageCleanupSection from './StorageCleanupSection.vue'

const mocks = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api }))

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('vue-sonner', () => ({ toast: Object.assign(vi.fn(), toasts) }))

const MB = 1024 * 1024
const busy = () => new HarnessError({ code: 'conflict', message: 'Another data task is running. Try again when it finishes.', details: { reason: 'busy' } })

function cleanupResult(overrides: Partial<DataCleanupResult> = {}): DataCleanupResult {
  return { files: 12, fileBytes: 48 * MB, blobs: 12, diskBytes: 48 * MB, tempFiles: 0, ranAt: Date.now(), pluginData: 'complete', ...overrides }
}

let api: MockApi
let page: { [K in keyof DataSettingsContext]: Mock<DataSettingsContext[K]> }
let wrappers: VueWrapper[] = []

beforeEach(() => {
  api = createMockApi()
  mocks.api = api
  toasts.success.mockReset()
  toasts.error.mockReset()
  page = { reloadSummary: vi.fn(), reloadShares: vi.fn() }
})

afterEach(() => {
  for (const wrapper of wrappers)
    wrapper.unmount()
  wrappers = []
  document.body.replaceChildren()
})

async function mountSection(): Promise<VueWrapper> {
  const wrapper = mount(StorageCleanupSection, {
    attachTo: document.body,
    global: { provide: { [dataSettingsContextKey as symbol]: page } },
  })
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}

function byTestId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.body.querySelector<T>(`[data-testid="${id}"]`)
}

function checkButton(): HTMLButtonElement {
  return byTestId<HTMLButtonElement>(testIds.dataCleanupCheck)!
}

function removeButton(): HTMLButtonElement {
  return byTestId<HTMLButtonElement>(testIds.dataCleanupRun)!
}

function summaryLines(): string[] {
  const summary = byTestId(testIds.dataCleanupSummary)
  return [...(summary?.querySelectorAll('p') ?? [])].map(line => line.textContent?.replace(/\s+/g, ' ').trim() ?? '')
}

async function click(element: HTMLElement | null | undefined): Promise<void> {
  expect(element).toBeTruthy()
  element!.click()
  await flushPromises()
}

async function checkWith(preview: DataCleanupPreview): Promise<void> {
  api.data.cleanupPreview.mockResolvedValueOnce(preview)
  await click(checkButton())
}

describe('storageCleanupSection', () => {
  it('renders the "Storage cleanup" section with its root test id and checks nothing on its own', async () => {
    const wrapper = await mountSection()
    const root = wrapper.get(`[data-testid="${testIds.dataCleanupSection}"]`)
    expect(root.element).toBe(wrapper.element)
    expect(root.attributes('data-slot')).toBe('settings-section')
    expect(root.get('h2').text()).toBe('Storage cleanup')
    expect(root.text()).toContain('Files from the last 24 hours are kept, and deleting a chat or a version keeps its files until the next cleanup.')
    expect(api.data.cleanupPreview).not.toHaveBeenCalled()
    expect(checkButton().textContent?.trim()).toBe('Check for unused files')
    expect(removeButton().textContent?.trim()).toBe('Remove…')
    expect(removeButton().disabled).toBe(true)
    expect(byTestId(testIds.dataCleanupSummary)).toBeNull()
  })

  it('shows a spinner while the check runs, then the summary', async () => {
    let answer!: (preview: DataCleanupPreview) => void
    api.data.cleanupPreview.mockReturnValueOnce(new Promise<DataCleanupPreview>((resolve) => {
      answer = resolve
    }))
    await mountSection()
    await click(checkButton())
    expect(checkButton().disabled).toBe(true)
    expect(checkButton().getAttribute('aria-busy')).toBe('true')
    expect(checkButton().querySelector('[role="status"]')).not.toBeNull()

    answer(dataCleanupPreview({ files: 12, fileBytes: 48 * MB, blobs: 0, tempFiles: 0, recentFiles: 3, lastRunAt: Date.now() - 2 * 86_400_000 }))
    await flushPromises()
    expect(checkButton().disabled).toBe(false)
    expect(summaryLines()).toEqual([
      '12 files · 48 MB can be removed',
      '3 recent files are kept for 24 hours.',
      'Last cleanup 2d ago',
    ])
    expect(byTestId(testIds.dataCleanupSummary)?.dataset.state).toBe('removable')
    expect(removeButton().disabled).toBe(false)
    expect(document.body.querySelector('[role="status"][aria-live="polite"]')?.textContent?.trim()).toBe('12 files · 48 MB can be removed')
  })

  it('mentions leftover files on disk and leaves out what is not there', async () => {
    await mountSection()
    await checkWith(dataCleanupPreview({ files: 1, fileBytes: 2048, blobs: 2, tempFiles: 1 }))
    expect(summaryLines()).toEqual(['1 file · 2 KB can be removed, and 3 leftover files on disk'])
  })

  it('says "No unused files." and keeps Remove disabled when nothing can be removed', async () => {
    await mountSection()
    await checkWith(dataCleanupPreview({ recentFiles: 1 }))
    expect(summaryLines()).toEqual(['No unused files.', '1 recent file is kept for 24 hours.'])
    expect(byTestId(testIds.dataCleanupSummary)?.dataset.state).toBe('empty')
    expect(removeButton().disabled).toBe(true)
    await click(removeButton())
    expect(byTestId(testIds.dataCleanupConfirm)).toBeNull()
  })

  it('removes the files after the confirmation, then checks again and reloads the summary line', async () => {
    await mountSection()
    await checkWith(dataCleanupPreview({ files: 12, fileBytes: 48 * MB, blobs: 12 }))
    await click(removeButton())

    const confirm = byTestId<HTMLButtonElement>(testIds.dataCleanupConfirm)
    const dialog = confirm?.closest('[role="alertdialog"]')
    expect(dialog?.textContent).toContain('Remove unused files?')
    expect(dialog?.textContent).toContain('This deletes 12 files (48 MB). It can\'t be undone.')
    expect(confirm?.textContent?.trim()).toBe('Remove files')
    expect(api.data.cleanup).not.toHaveBeenCalled()

    api.data.cleanup.mockResolvedValue(cleanupResult())
    api.data.cleanupPreview.mockResolvedValueOnce(dataCleanupPreview({ lastRunAt: Date.now() }))
    await click(confirm)

    expect(api.data.cleanup).toHaveBeenCalledTimes(1)
    expect(api.data.cleanup).toHaveBeenCalledWith()
    expect(toasts.success).toHaveBeenCalledWith('Removed 12 files (48 MB)')
    expect(byTestId(testIds.dataCleanupConfirm)).toBeNull()
    expect(page.reloadSummary).toHaveBeenCalledTimes(1)
    expect(api.data.cleanupPreview).toHaveBeenCalledTimes(2)
    expect(summaryLines()).toEqual(['No unused files.', 'Last cleanup just now'])
    expect(removeButton().disabled).toBe(true)
  })

  it('does nothing when the confirmation is cancelled', async () => {
    await mountSection()
    await checkWith(dataCleanupPreview({ files: 2, fileBytes: 4096 }))
    await click(removeButton())
    const dialog = byTestId(testIds.dataCleanupConfirm)!.closest('[role="alertdialog"]')!
    await click([...dialog.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Cancel'))

    expect(byTestId(testIds.dataCleanupConfirm)).toBeNull()
    expect(api.data.cleanup).not.toHaveBeenCalled()
    expect(removeButton().disabled).toBe(false)
  })

  it('keeps the confirmation open while the cleanup runs', async () => {
    let finish!: (result: DataCleanupResult) => void
    api.data.cleanup.mockReturnValue(new Promise<DataCleanupResult>((resolve) => {
      finish = resolve
    }))
    await mountSection()
    await checkWith(dataCleanupPreview({ files: 2, fileBytes: 4096 }))
    await click(removeButton())
    await click(byTestId(testIds.dataCleanupConfirm))

    const confirm = byTestId<HTMLButtonElement>(testIds.dataCleanupConfirm)!
    expect(confirm.disabled).toBe(true)
    expect(checkButton().disabled).toBe(true)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(byTestId(testIds.dataCleanupConfirm)).not.toBeNull()

    api.data.cleanupPreview.mockResolvedValueOnce(dataCleanupPreview())
    finish(cleanupResult({ files: 2, fileBytes: 4096, blobs: 2, diskBytes: 4096 }))
    await flushPromises()
    expect(toasts.success).toHaveBeenCalledWith('Removed 2 files (4 KB)')
    expect(byTestId(testIds.dataCleanupConfirm)).toBeNull()
  })

  it('shows the busy toast when another data task runs during the check', async () => {
    api.data.cleanupPreview.mockRejectedValueOnce(busy())
    await mountSection()
    await click(checkButton())
    expect(toasts.error).toHaveBeenCalledWith(BUSY_MESSAGE)
    expect(byTestId(testIds.dataCleanupSummary)).toBeNull()
    expect(removeButton().disabled).toBe(true)
    expect(checkButton().disabled).toBe(false)
  })

  it('shows the busy toast and keeps the confirmation open when the cleanup is refused', async () => {
    api.data.cleanup.mockRejectedValue(busy())
    await mountSection()
    await checkWith(dataCleanupPreview({ files: 2, fileBytes: 4096 }))
    await click(removeButton())
    await click(byTestId(testIds.dataCleanupConfirm))

    expect(toasts.error).toHaveBeenCalledWith(BUSY_MESSAGE)
    expect(toasts.success).not.toHaveBeenCalled()
    expect(page.reloadSummary).not.toHaveBeenCalled()
    expect(byTestId<HTMLButtonElement>(testIds.dataCleanupConfirm)?.disabled).toBe(false)
  })

  it('shows other failures as an error toast', async () => {
    api.data.cleanupPreview.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'The database is locked.' }))
    await mountSection()
    await click(checkButton())
    expect(toasts.error).toHaveBeenCalledWith('Something went wrong', { description: 'The database is locked.' })
  })
})
