// StorageCleanupSection (docs/UI.md 9.8, 10.4; docs/API.md 5.19; W7.13, W8.11-T3): Check for unused files and its
// summary (the plugin data warning included), "No unused files.", Remove… with its confirmation, the result toast, the
// reloads afterwards and the busy answers; Automatic cleanup: the switch and the interval writing `fileSweep`
// (optimistic, rolled back with a toast) and the status line from `GET /api/data`.
import type { DataCleanupPreview, DataCleanupResult, FileSweepStatus, Settings } from '@harness-forge/shared'
import type { VueWrapper } from '@vue/test-utils'
import type { Mock } from 'vitest'
import type { DataSettingsContext } from './data-context'
import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { useSettingsStore } from '~/stores/settings'
import { testIds } from '~/utils/testids'
import { dataCleanupPreview, dataSummary, fileSweepStatus, settings } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { BUSY_MESSAGE } from './data'
import { dataSettingsContextKey } from './data-context'
import StorageCleanupSection from './StorageCleanupSection.vue'

const mocks = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api }))

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('vue-sonner', () => ({ toast: Object.assign(vi.fn(), toasts) }))

const MB = 1024 * 1024
const HOUR = 3_600_000
const DAY = 24 * HOUR
const busy = () => new HarnessError({ code: 'conflict', message: 'Another data task is running. Try again when it finishes.', details: { reason: 'busy' } })

function cleanupResult(overrides: Partial<DataCleanupResult> = {}): DataCleanupResult {
  return { files: 12, fileBytes: 48 * MB, blobs: 12, diskBytes: 48 * MB, tempFiles: 0, ranAt: Date.now(), pluginData: 'complete', ...overrides }
}

let api: MockApi
let pinia: ReturnType<typeof createPinia>
let page: { [K in keyof DataSettingsContext]: Mock<DataSettingsContext[K]> }
let wrappers: VueWrapper[] = []

beforeEach(() => {
  api = createMockApi()
  mocks.api = api
  toasts.success.mockReset()
  toasts.error.mockReset()
  page = { reloadSummary: vi.fn(), reloadShares: vi.fn() }
  pinia = createPinia()
  setActivePinia(pinia)
  api.data.summary.mockResolvedValue(dataSummary())
})

afterEach(() => {
  for (const wrapper of wrappers)
    wrapper.unmount()
  wrappers = []
  disposePinia(pinia)
  document.body.replaceChildren()
})

async function mountSection(): Promise<VueWrapper> {
  const wrapper = mount(StorageCleanupSection, {
    attachTo: document.body,
    global: { plugins: [pinia], provide: { [dataSettingsContextKey as symbol]: page } },
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

describe('storageCleanupSection: plugin data', () => {
  it('warns when the scan of the plugin data stopped at its budget', async () => {
    await mountSection()
    await checkWith(dataCleanupPreview({ files: 1, fileBytes: 2048, pluginData: 'partial' }))
    const warning = document.body.querySelector<HTMLElement>('[data-slot="cleanup-plugin-data"]')
    expect(warning?.textContent?.trim()).toBe('Plugin data is too large to scan completely, so a file only a plugin remembers may be removed.')
    expect(removeButton().disabled).toBe(false)
    await checkWith(dataCleanupPreview({ files: 1, fileBytes: 2048 }))
    expect(document.body.querySelector('[data-slot="cleanup-plugin-data"]')).toBeNull()
  })
})

describe('storageCleanupSection: automatic cleanup', () => {
  function autoSwitch(): HTMLButtonElement {
    return byTestId<HTMLButtonElement>(testIds.dataCleanupAuto)!
  }

  function intervalTrigger(): HTMLButtonElement {
    return byTestId<HTMLButtonElement>(testIds.dataCleanupInterval)!
  }

  function statusLine(): HTMLElement | null {
    return byTestId(testIds.dataCleanupAutoStatus)
  }

  function statusTexts(): string[] {
    return [...(statusLine()?.querySelectorAll('p') ?? [])].map(line => line.textContent?.replace(/\s+/g, ' ').trim() ?? '')
  }

  async function settle(rounds = 3): Promise<void> {
    for (let round = 0; round < rounds; round++) {
      await flushPromises()
      await nextTick()
    }
  }

  async function withSettings(overrides: Partial<Settings>): Promise<void> {
    api.settings.get.mockResolvedValueOnce(settings(overrides))
    await useSettingsStore().fetch()
  }

  /** `PUT /settings` answers with the saved values. */
  function acceptUpdates(): void {
    api.settings.update.mockImplementation(async ({ body }: { body: Partial<Settings> }) => settings(body))
  }

  async function chooseInterval(value: 'daily' | 'weekly'): Promise<void> {
    // reka-ui's Select opens with the keyboard in happy-dom.
    intervalTrigger().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await settle()
    const item = [...document.body.querySelectorAll<HTMLElement>('[data-slot="select-item"]')].find(option => option.dataset.value === value)!
    item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await settle()
  }

  it('starts off: the switch, its description, the disabled "Every day" select and an empty status line', async () => {
    await withSettings({})
    const wrapper = await mountSection()
    expect(api.data.summary).toHaveBeenCalledTimes(1)
    expect(autoSwitch().getAttribute('role')).toBe('switch')
    expect(autoSwitch().dataset.state).toBe('unchecked')
    const label = document.body.querySelector<HTMLLabelElement>(`label[for="${autoSwitch().id}"]`)
    expect(label?.textContent?.trim()).toBe('Automatic cleanup')
    expect(document.getElementById(autoSwitch().getAttribute('aria-describedby')!)?.textContent?.trim())
      .toBe('Remove unused files on a schedule. They\'re deleted without asking and can\'t be restored. Files from the last 24 hours are always kept.')
    expect(intervalTrigger().disabled).toBe(true)
    expect(intervalTrigger().dataset.value).toBe('daily')
    expect(intervalTrigger().textContent?.trim()).toBe('Every day')
    expect(statusLine()?.dataset.state).toBe('off')
    expect(statusTexts()).toEqual([])
    // Below the buttons.
    expect(checkButton().compareDocumentPosition(autoSwitch()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(wrapper.text()).not.toContain('Next automatic cleanup')
  })

  it('turns on with the interval shown, then shows when the next cleanup runs', async () => {
    await withSettings({})
    acceptUpdates()
    await mountSection()
    api.data.summary.mockResolvedValue(dataSummary({ fileSweep: fileSweepStatus({ mode: 'daily', nextRunAt: Date.now() + 21 * HOUR }) }))
    autoSwitch().click()
    await settle()
    expect(api.settings.update).toHaveBeenCalledWith({ body: { fileSweep: 'daily' } })
    expect(autoSwitch().dataset.state).toBe('checked')
    expect(intervalTrigger().disabled).toBe(false)
    expect(api.data.summary).toHaveBeenCalledTimes(2)
    expect(statusLine()?.dataset.state).toBe('never')
    expect(statusTexts()).toEqual(['Next automatic cleanup in 21h.'])
  })

  it('changes the interval while on, and keeps the one shown when turned off', async () => {
    await withSettings({ fileSweep: 'daily' })
    acceptUpdates()
    await mountSection()
    expect(autoSwitch().dataset.state).toBe('checked')
    await chooseInterval('weekly')
    expect(api.settings.update).toHaveBeenCalledWith({ body: { fileSweep: 'weekly' } })
    expect(intervalTrigger().dataset.value).toBe('weekly')
    expect(intervalTrigger().textContent?.trim()).toBe('Every week')

    autoSwitch().click()
    await settle()
    expect(api.settings.update).toHaveBeenLastCalledWith({ body: { fileSweep: 'off' } })
    expect(autoSwitch().dataset.state).toBe('unchecked')
    expect(intervalTrigger().disabled).toBe(true)
    expect(intervalTrigger().dataset.value).toBe('weekly')

    autoSwitch().click()
    await settle()
    expect(api.settings.update).toHaveBeenLastCalledWith({ body: { fileSweep: 'weekly' } })
  })

  it('applies at once and rolls back with an error toast when the save fails', async () => {
    await withSettings({})
    let fail!: (error: unknown) => void
    api.settings.update.mockReturnValueOnce(new Promise((_resolve, reject) => {
      fail = reject
    }))
    await mountSection()
    autoSwitch().click()
    await settle()
    expect(autoSwitch().dataset.state).toBe('checked')
    fail(new HarnessError({ code: 'internal_error', message: 'Disk full.' }))
    await settle()
    expect(autoSwitch().dataset.state).toBe('unchecked')
    expect(intervalTrigger().disabled).toBe(true)
    expect(toasts.error).toHaveBeenCalledWith('Something went wrong', { description: 'Disk full.' })
    expect(api.data.summary).toHaveBeenCalledTimes(1)
  })

  it('reports the last automatic cleanup and the next one', async () => {
    await withSettings({ fileSweep: 'weekly' })
    api.data.summary.mockResolvedValue(dataSummary({ fileSweep: fileSweepStatus({
      mode: 'weekly',
      lastAttempt: { at: Date.now() - 3 * DAY, status: 'done', reason: null, files: 4, diskBytes: 2 * MB },
      nextRunAt: Date.now() + 4 * DAY,
    }) }))
    await mountSection()
    expect(statusLine()?.dataset.state).toBe('done')
    expect(statusTexts()).toEqual(['Last automatic cleanup 3d ago: removed 4 files (2 MB).', 'Next automatic cleanup in 4d.'])
  })

  it('reports a skipped and a failed run, and only the last run while off', async () => {
    await withSettings({ fileSweep: 'daily' })
    api.data.summary.mockResolvedValueOnce(dataSummary({ fileSweep: fileSweepStatus({
      mode: 'daily',
      lastAttempt: { at: Date.now() - HOUR, status: 'skipped', reason: 'plugin-data-limit', files: 0, diskBytes: 0 },
      nextRunAt: Date.now() + 23 * HOUR,
    }) }))
    await mountSection()
    expect(statusLine()?.dataset.state).toBe('skipped')
    expect(statusTexts()).toEqual([
      'The last automatic cleanup was skipped: plugin data is too large to scan. Run a cleanup by hand.',
      'Next automatic cleanup in 23h.',
    ])

    wrappers.pop()!.unmount()
    await withSettings({ fileSweep: 'off' })
    api.data.summary.mockResolvedValueOnce(dataSummary({ fileSweep: fileSweepStatus({
      mode: 'off',
      lastAttempt: { at: Date.now() - DAY, status: 'failed', reason: 'error', files: 0, diskBytes: 0 },
      nextRunAt: null,
    }) }))
    await mountSection()
    expect(statusLine()?.dataset.state).toBe('failed')
    expect(statusTexts()).toEqual(['The last automatic cleanup failed. It tries again after the next interval.'])
  })

  it('says "soon" when the next run is already due', async () => {
    await withSettings({ fileSweep: 'daily' })
    api.data.summary.mockResolvedValue(dataSummary({ fileSweep: fileSweepStatus({ mode: 'daily', nextRunAt: Date.now() - 5 * 60_000 }) }))
    await mountSection()
    expect(statusTexts()).toEqual(['Next automatic cleanup soon.'])
  })

  it('uses the mode of the status until the settings are loaded', async () => {
    api.data.summary.mockResolvedValue(dataSummary({ fileSweep: fileSweepStatus({ mode: 'weekly', nextRunAt: Date.now() + 2 * DAY }) }))
    await mountSection()
    expect(useSettingsStore().settings).toBeNull()
    expect(autoSwitch().dataset.state).toBe('checked')
    expect(intervalTrigger().dataset.value).toBe('weekly')
    expect(statusTexts()).toEqual(['Next automatic cleanup in 2d.'])
  })

  it('takes the state from a check and loads it again after a cleanup (which resets the schedule)', async () => {
    await withSettings({ fileSweep: 'daily' })
    await mountSection()
    expect(statusTexts()).toEqual([])
    const status: FileSweepStatus = fileSweepStatus({ mode: 'daily', nextRunAt: Date.now() + 10 * HOUR })
    await checkWith(dataCleanupPreview({ files: 2, fileBytes: 4096, fileSweep: status }))
    expect(statusTexts()).toEqual(['Next automatic cleanup in 10h.'])

    api.data.cleanup.mockResolvedValue(cleanupResult({ files: 2, fileBytes: 4096 }))
    api.data.cleanupPreview.mockResolvedValueOnce(dataCleanupPreview({ fileSweep: fileSweepStatus({ mode: 'daily', nextRunAt: Date.now() + 20 * HOUR }) }))
    api.data.summary.mockResolvedValue(dataSummary({ fileSweep: fileSweepStatus({ mode: 'daily', nextRunAt: Date.now() + 20 * HOUR }) }))
    await click(removeButton())
    await click(byTestId(testIds.dataCleanupConfirm))
    expect(api.data.summary).toHaveBeenCalledTimes(2)
    expect(statusTexts()).toEqual(['Next automatic cleanup in 20h.'])
  })

  it('keeps the status line out while GET /data fails', async () => {
    api.data.summary.mockRejectedValue(new HarnessError({ code: 'internal_error', message: 'Down.' }))
    await mountSection()
    expect(statusLine()).toBeNull()
    expect(autoSwitch().dataset.state).toBe('unchecked')
  })
})
