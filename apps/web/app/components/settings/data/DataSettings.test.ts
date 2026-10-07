import type { DataDeleteResult, DataImportResult, DataSummary, KeyRotationResult } from '@harness-forge/shared'
import type { VueWrapper } from '@vue/test-utils'
import type { ComputedRef } from 'vue'
import type { MockApi } from '~/utils/testing/mock-api'
import { DEFAULT_SETTINGS, HarnessError, LIMITS } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import SharesSettingsSection from '~/components/share/SharesSettingsSection.vue'
import DataPage from '~/pages/settings/data.vue'
import { useAuthStore } from '~/stores/auth'
import { useChatsStore } from '~/stores/chats'
import { useSettingsStore } from '~/stores/settings'
import { downloadResponse } from '~/utils/download'
import { testIds } from '~/utils/testids'
import { authStatus, chatId, dataCleanupPreview, keyStatus } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { BUSY_MESSAGE } from './data'
import DataSettings from './DataSettings.vue'

const mocks = vi.hoisted(() => ({ api: null as unknown, useHead: vi.fn(), navigateTo: vi.fn(), sharesMounts: 0 }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api }))
// SettingsPage sets the tab title and the danger zone navigates through the settings nuxt-imports module ('#imports'
// does not resolve in Vitest).
vi.mock('~/components/settings/nuxt-imports', () => ({ useHead: mocks.useHead, navigateTo: mocks.navigateTo }))
vi.mock('~/utils/download', () => ({ downloadResponse: vi.fn(async () => {}) }))

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('vue-sonner', () => ({ toast: Object.assign(vi.fn(), toasts) }))

// The Shared links section is W5.6's (tested in SharesSettingsSection.test.ts); a stand-in with its root test id keeps
// these tests independent of the share requests. It counts its mounts (a key rotation remounts it).
vi.mock('~/components/share/SharesSettingsSection.vue', async () => {
  const vue = await import('vue')
  const ids = await import('~/utils/testids')
  return {
    default: vue.defineComponent({
      name: 'SharesSettingsSection',
      setup: () => {
        mocks.sharesMounts += 1
        return () => vue.h('div', { 'data-testid': ids.testIds.sharesSection })
      },
    }),
  }
})

const NuxtLink = defineComponent({
  props: { to: { type: String, required: true } },
  setup: (props, { slots }) => () => h('a', { href: props.to }, slots.default?.()),
})

const passwordSet = authStatus({ enabled: true, authenticated: true, source: 'settings', freshUntil: null })
const freshNeeded = () => new HarnessError({ code: 'forbidden', message: 'Log in again to continue.', action: 'login' })
const busy = () => new HarnessError({ code: 'conflict', message: 'Another data task is running. Try again when it finishes.', details: { reason: 'busy' } })

function summary(overrides: Partial<DataSummary> = {}): DataSummary {
  return { chats: 12, archivedChats: 2, messages: 348, files: 18, fileBytes: 25_480_000, fileSweep: { mode: 'off', lastAttempt: null, nextRunAt: null }, ...overrides }
}

function deleted(overrides: Partial<DataDeleteResult> = {}): DataDeleteResult {
  return { chats: 12, messages: 348, files: 0, fileBytes: 0, usageRows: 0, ...overrides }
}

function importResult(overrides: Partial<DataImportResult> = {}): DataImportResult {
  return {
    kind: 'backup',
    counts: { imported: 0, copied: 0, skipped: 0, failed: 0, filesImported: 0, filesReused: 0, filesMissing: 0 },
    settingsRestored: false,
    items: [],
    warnings: [],
    ...overrides,
  }
}

let pinia: ReturnType<typeof createPinia>
let api: MockApi
let wrappers: VueWrapper[] = []
let fetchChats: ReturnType<typeof vi.spyOn>
let fetchSettings: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  api = createMockApi()
  mocks.api = api
  mocks.useHead.mockReset()
  mocks.navigateTo.mockReset()
  mocks.sharesMounts = 0
  toasts.success.mockReset()
  toasts.error.mockReset()
  vi.mocked(downloadResponse).mockClear()
  sessionStorage.clear()
  localStorage.clear()
  pinia = createPinia()
  setActivePinia(pinia)
  api.data.summary.mockResolvedValue(summary())
  api.keys.get.mockResolvedValue(keyStatus({ secrets: 2, shares: 1 }))
  api.chats.list.mockResolvedValue({ items: [], nextCursor: null })
  api.settings.get.mockResolvedValue({ ...DEFAULT_SETTINGS })
  // The components use these stores through the same pinia; the spies call through to the mocked API.
  fetchChats = vi.spyOn(useChatsStore(), 'fetchPage')
  fetchSettings = vi.spyOn(useSettingsStore(), 'fetch')
  api.auth.login.mockImplementation(async ({ body }: { body: { password: string } }) => {
    if (body.password !== 'correct-horse')
      throw new HarnessError({ code: 'unauthorized', message: 'Invalid password' })
    return { ...passwordSet, freshUntil: Date.now() + 600_000 }
  })
})

afterEach(() => {
  for (const wrapper of wrappers)
    wrapper.unmount()
  wrappers = []
  disposePinia(pinia)
  document.body.replaceChildren()
})

async function mountData(): Promise<VueWrapper> {
  const wrapper = mount(DataSettings, { attachTo: document.body, global: { plugins: [pinia], stubs: { NuxtLink } } })
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}

function byTestId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.body.querySelector<T>(`[data-testid="${id}"]`)
}

function allByTestId(id: string): HTMLElement[] {
  return [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)]
}

async function click(element: HTMLElement | null | undefined): Promise<void> {
  expect(element).toBeTruthy()
  element!.click()
  await flushPromises()
}

async function type(id: string, value: string): Promise<void> {
  const input = byTestId<HTMLInputElement>(id)
  expect(input).not.toBeNull()
  input!.value = value
  input!.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
}

async function chooseFile(name: string, options: { type?: string, size?: number } = {}): Promise<File> {
  const input = byTestId<HTMLInputElement>(testIds.dataImportFile)!
  const file = new File(['{}'], name, { type: options.type ?? '' })
  if (options.size !== undefined)
    Object.defineProperty(file, 'size', { value: options.size })
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  input.dispatchEvent(new Event('change', { bubbles: true }))
  await nextTick()
  return file
}

function importForm(call = 0): FormData {
  return (api.data.import.mock.calls[call]![0] as { form: FormData }).form
}

function importButton(): HTMLButtonElement {
  return byTestId<HTMLButtonElement>(testIds.dataImport)!
}

function deleteSubmit(): HTMLButtonElement {
  return byTestId<HTMLButtonElement>(testIds.dataDeleteSubmit)!
}

/** Opens the delete-all dialog, types the confirmation and submits. */
async function confirmDeleteAll(): Promise<void> {
  await click(byTestId(testIds.dataDelete))
  await type(testIds.dataDeleteConfirmInput, 'DELETE')
  await click(deleteSubmit())
}

async function submitPassword(password: string): Promise<void> {
  await type(testIds.confirmPasswordInput, password)
  await click(byTestId(testIds.confirmPasswordSubmit))
}

describe('dataSettings', () => {
  it('renders its root test id with the Shared links section inside', async () => {
    const wrapper = await mountData()
    const root = wrapper.get(`[data-testid="${testIds.dataSettings}"]`)
    expect(root.element).toBe(wrapper.element)
    expect(root.find(`[data-testid="${testIds.sharesSection}"]`).exists()).toBe(true)
    expect(wrapper.findComponent(SharesSettingsSection).exists()).toBe(true)
    const headings = wrapper.findAll('h2').map(heading => heading.text())
    expect(headings).toEqual(['Export', 'Import', 'Storage cleanup', 'Encryption key', 'Danger zone'])
  })

  it('orders the sections: summary, Export, Import, Storage cleanup, Shared links, Encryption key, Danger zone', async () => {
    const wrapper = await mountData()
    const sections = [...wrapper.element.children].map(child => (
      child.getAttribute('data-testid') ?? child.querySelector('h2')?.textContent?.trim() ?? child.tagName
    ))
    expect(sections).toEqual([
      'DIV',
      'Export',
      'Import',
      testIds.dataCleanupSection,
      testIds.sharesSection,
      testIds.dataKeySection,
      'Danger zone',
    ])
    expect(wrapper.element.children[0]?.querySelector(`[data-testid="${testIds.dataSummary}"]`)).not.toBeNull()
    expect(api.keys.get).toHaveBeenCalledTimes(1)
    expect(api.data.cleanupPreview).not.toHaveBeenCalled()
  })

  it('shows the summary line', async () => {
    await mountData()
    // The page and Storage cleanup (the automatic cleanup status, docs/UI.md 9.8) each load GET /api/data once.
    expect(api.data.summary).toHaveBeenCalledTimes(2)
    expect(byTestId(testIds.dataSummary)?.textContent?.trim()).toBe('12 chats (2 archived) · 348 messages · 18 files, 24 MB')
  })

  it('says so when the summary cannot be loaded, and retries', async () => {
    // Storage cleanup loads the same summary for its status line (it mounts first).
    api.data.summary
      .mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'The database is locked.' }))
      .mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'The database is locked.' }))
    await mountData()
    const alert = document.body.querySelector<HTMLElement>('[data-slot="settings-load-error"]')
    expect(alert?.textContent).toContain('Could not load the data summary')
    expect(alert?.textContent).toContain('The database is locked.')
    expect(byTestId(testIds.dataSummary)).toBeNull()

    await click(alert!.querySelector('button'))
    expect(document.body.querySelector('[data-slot="settings-load-error"]')).toBeNull()
    expect(byTestId(testIds.dataSummary)?.textContent).toContain('12 chats')
  })
})

describe('export', () => {
  it('sends the switches as the query and saves the zip', async () => {
    const response = new Response('zip')
    api.data.export.mockResolvedValue(response)
    await mountData()
    expect(byTestId(testIds.dataExportFiles)?.getAttribute('aria-checked')).toBe('true')
    expect(byTestId(testIds.dataExportSettings)?.getAttribute('aria-checked')).toBe('true')
    expect(document.body.textContent).toContain('18 files, 24 MB')

    await click(byTestId(testIds.dataExport))
    expect(api.data.export).toHaveBeenCalledWith({ query: { files: true, settings: true } })
    expect(downloadResponse).toHaveBeenCalledWith(response, 'harness-forge-backup.zip')

    await click(byTestId(testIds.dataExportFiles))
    await click(byTestId(testIds.dataExport))
    expect(api.data.export).toHaveBeenLastCalledWith({ query: { files: false, settings: true } })

    await click(byTestId(testIds.dataExportSettings))
    await click(byTestId(testIds.dataExport))
    expect(api.data.export).toHaveBeenLastCalledWith({ query: { files: false, settings: false } })
    expect(downloadResponse).toHaveBeenCalledTimes(3)
  })

  it('shows the server message in a toast when the backup is too large', async () => {
    const message = 'The backup would exceed 3.5 GB. Export it without attachments.'
    api.data.export.mockRejectedValue(new HarnessError({ code: 'payload_too_large', message }))
    await mountData()
    await click(byTestId(testIds.dataExport))
    expect(toasts.error).toHaveBeenCalledWith('Too large', { description: message })
    expect(downloadResponse).not.toHaveBeenCalled()
    expect(byTestId<HTMLButtonElement>(testIds.dataExport)!.disabled).toBe(false)
  })

  it('warns while the attachments exceed the import limit', async () => {
    api.data.summary.mockResolvedValue(summary({ fileBytes: LIMITS.backupImportBytes + 1 }))
    await mountData()
    expect(byTestId(testIds.dataExportWarning)?.textContent).toContain('This backup may be too large to import through the browser (limit 256 MB).')

    await click(byTestId(testIds.dataExportFiles))
    expect(byTestId(testIds.dataExportWarning)).toBeNull()
    await click(byTestId(testIds.dataExportFiles))
    expect(byTestId(testIds.dataExportWarning)).not.toBeNull()
  })

  it('does not warn at or below the import limit', async () => {
    api.data.summary.mockResolvedValue(summary({ fileBytes: LIMITS.backupImportBytes }))
    await mountData()
    expect(byTestId(testIds.dataExportWarning)).toBeNull()
  })
})

describe('import', () => {
  const everyStatus = importResult({
    counts: { imported: 1, copied: 1, skipped: 1, failed: 1, filesImported: 15, filesReused: 3, filesMissing: 1 },
    settingsRestored: true,
    items: [
      { sourceId: chatId(1), chatId: chatId(1), title: 'Refactor auth flow', status: 'imported' },
      { sourceId: chatId(2), chatId: chatId(9), title: 'Kimi vs Qwen (imported)', status: 'copied' },
      { sourceId: chatId(3), chatId: chatId(3), title: null, status: 'skipped' },
      { sourceId: chatId(4), chatId: null, title: 'Broken chat', status: 'failed', error: 'invalid tree' },
    ],
    warnings: ['Unknown entry notes.txt was ignored.'],
  })

  it('uploads a backup with the chosen options and renders every status of the result', async () => {
    api.data.import.mockResolvedValue(everyStatus)
    await mountData()
    expect(importButton().disabled).toBe(true)
    expect(byTestId(testIds.dataImportPolicy)?.dataset.value).toBe('skip')
    expect(byTestId(testIds.dataImportRestoreSettings)?.getAttribute('aria-checked')).toBe('false')

    await chooseFile('backup.zip', { type: 'application/zip' })
    expect(importButton().disabled).toBe(false)
    expect(document.body.textContent).toContain('backup.zip')
    await click(byTestId(testIds.dataImportPolicy)?.querySelector<HTMLElement>('[data-value="copy"]'))
    expect(byTestId(testIds.dataImportPolicy)?.dataset.value).toBe('copy')
    await click(byTestId(testIds.dataImportRestoreSettings))
    await click(importButton())

    expect(api.data.import).toHaveBeenCalledTimes(1)
    const form = importForm()
    expect(form.get('onConflict')).toBe('copy')
    expect(form.get('restoreSettings')).toBe('true')
    expect((form.get('file') as File).name).toBe('backup.zip')

    const panel = byTestId(testIds.dataImportResult)!
    expect(panel.dataset.kind).toBe('backup')
    expect(panel.textContent).toContain('Imported 1 chat · copied 1 · skipped 1 · failed 1')
    expect(panel.textContent).toContain('18 files (3 reused, 1 missing)')
    expect(panel.textContent).toContain('Settings restored')

    const rows = allByTestId(testIds.dataImportItem)
    expect(rows.map(row => row.dataset.status)).toEqual(['imported', 'copied', 'skipped', 'failed'])
    expect(rows.map(row => row.dataset.chatId)).toEqual([chatId(1), chatId(9), chatId(3), undefined])
    expect(rows[0]!.querySelector('a')?.getAttribute('href')).toBe(`/chat/${chatId(1)}`)
    expect(rows[0]!.textContent).toContain('Imported')
    expect(rows[1]!.querySelector('a')?.getAttribute('href')).toBe(`/chat/${chatId(9)}`)
    expect(rows[1]!.textContent).toContain('Copied')
    expect(rows[2]!.querySelector('a')).toBeNull()
    expect(rows[2]!.textContent).toContain('Untitled chat')
    expect(rows[2]!.textContent).toContain('Skipped')
    expect(rows[3]!.querySelector('a')).toBeNull()
    expect(rows[3]!.textContent).toContain('Broken chat')
    expect(rows[3]!.textContent).toContain('Failed')
    expect(rows[3]!.textContent).toContain('invalid tree')
    expect(allByTestId(testIds.dataImportWarning).map(warning => warning.textContent?.trim()))
      .toEqual(['Unknown entry notes.txt was ignored.'])

    // Afterwards the chat list, the restored settings and the summary are loaded again.
    expect(fetchChats).toHaveBeenCalledWith({ reset: true })
    expect(fetchSettings).toHaveBeenCalledTimes(1)
    // Twice on mount (the page and Storage cleanup), then the page again.
    expect(api.data.summary).toHaveBeenCalledTimes(3)
    expect(document.body.querySelector('[aria-live="polite"]')?.textContent?.trim())
      .toBe('Import finished: 1 imported, 1 copied, 1 skipped, 1 failed')
  })

  it('imports a chat JSON without settings', async () => {
    api.data.import.mockResolvedValue(importResult({
      kind: 'chat',
      counts: { imported: 1, copied: 0, skipped: 0, failed: 0, filesImported: 0, filesReused: 0, filesMissing: 0 },
      items: [{ sourceId: chatId(5), chatId: chatId(5), title: 'Plugin idea', status: 'imported' }],
    }))
    await mountData()
    await click(byTestId(testIds.dataImportRestoreSettings))
    expect(byTestId(testIds.dataImportRestoreSettings)?.getAttribute('aria-checked')).toBe('true')

    await chooseFile('chat-plugin-idea.json', { type: 'application/json' })
    const restore = byTestId<HTMLButtonElement>(testIds.dataImportRestoreSettings)!
    expect(restore.disabled).toBe(true)
    expect(restore.getAttribute('aria-checked')).toBe('false')
    await click(importButton())

    const form = importForm()
    expect(form.get('onConflict')).toBe('skip')
    expect(form.get('restoreSettings')).toBe('false')
    const panel = byTestId(testIds.dataImportResult)!
    expect(panel.dataset.kind).toBe('chat')
    expect(panel.textContent).toContain('Imported 1 chat')
    expect(panel.textContent).not.toContain('Settings restored')
    expect(allByTestId(testIds.dataImportItem)).toHaveLength(1)
    expect(fetchSettings).not.toHaveBeenCalled()
    expect(fetchChats).toHaveBeenCalledWith({ reset: true })
  })

  it('refuses a file above 256 MB before the upload', async () => {
    await mountData()
    await chooseFile('huge-backup.zip', { size: LIMITS.backupImportBytes + 1 })
    const error = byTestId(testIds.dataImportError)!
    expect(error.textContent).toContain('This file is larger than 256 MB.')
    expect(error.dataset.code).toBe('payload_too_large')
    expect(importButton().disabled).toBe(true)
    expect(api.data.import).not.toHaveBeenCalled()

    await chooseFile('backup.zip', { size: LIMITS.backupImportBytes })
    expect(byTestId(testIds.dataImportError)).toBeNull()
    expect(importButton().disabled).toBe(false)
  })

  it('shows a validation failure inline', async () => {
    api.data.import.mockRejectedValue(new HarnessError({ code: 'validation_error', message: 'The backup has no manifest.json.' }))
    await mountData()
    await chooseFile('backup.zip')
    await click(importButton())
    const error = byTestId(testIds.dataImportError)!
    expect(error.dataset.code).toBe('validation_error')
    expect(error.textContent).toContain('The backup has no manifest.json.')
    expect(byTestId(testIds.dataImportResult)).toBeNull()
    expect(toasts.error).not.toHaveBeenCalled()
    expect(importButton().disabled).toBe(false)
  })

  it('shows a toast when another import or delete runs, or the upload is too large', async () => {
    api.data.import
      .mockRejectedValueOnce(busy())
      .mockRejectedValueOnce(new HarnessError({ code: 'payload_too_large', message: 'The upload is larger than 256 MB.' }))
    await mountData()
    await chooseFile('backup.zip')

    await click(importButton())
    expect(toasts.error).toHaveBeenLastCalledWith(BUSY_MESSAGE)
    await click(importButton())
    expect(toasts.error).toHaveBeenLastCalledWith('Too large', { description: 'The upload is larger than 256 MB.' })

    expect(byTestId(testIds.dataImportError)).toBeNull()
    expect(fetchChats).not.toHaveBeenCalled()
  })
})

describe('delete all', () => {
  it('stays disabled until DELETE is typed exactly, with both checkboxes unchecked', async () => {
    await mountData()
    await click(byTestId(testIds.dataDelete))
    const dialog = byTestId(testIds.dataDeleteDialog)!
    expect(dialog.textContent).toContain('Delete all data?')
    expect(dialog.textContent).toContain('This deletes 12 chats and 348 messages.')
    expect(document.activeElement).toBe(byTestId(testIds.dataDeleteConfirmInput))
    expect(byTestId(testIds.dataDeleteFiles)?.getAttribute('aria-checked')).toBe('false')
    expect(byTestId(testIds.dataDeleteUsage)?.getAttribute('aria-checked')).toBe('false')
    expect(deleteSubmit().disabled).toBe(true)

    for (const value of ['delete', 'Delete', 'DELET', 'DELETE ', ' DELETE']) {
      await type(testIds.dataDeleteConfirmInput, value)
      expect(deleteSubmit().disabled).toBe(true)
    }
    // Enter in the input submits the form, which does nothing before the confirmation matches.
    dialog.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flushPromises()
    expect(api.data.deleteAll).not.toHaveBeenCalled()

    await type(testIds.dataDeleteConfirmInput, 'DELETE')
    expect(deleteSubmit().disabled).toBe(false)
  })

  it('starts over every time it opens', async () => {
    await mountData()
    await click(byTestId(testIds.dataDelete))
    await click(byTestId(testIds.dataDeleteUsage))
    await type(testIds.dataDeleteConfirmInput, 'DELETE')
    const cancel = [...byTestId(testIds.dataDeleteDialog)!.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Cancel')
    await click(cancel)
    expect(byTestId(testIds.dataDeleteDialog)).toBeNull()

    await click(byTestId(testIds.dataDelete))
    expect(byTestId<HTMLInputElement>(testIds.dataDeleteConfirmInput)?.value).toBe('')
    expect(byTestId(testIds.dataDeleteUsage)?.getAttribute('aria-checked')).toBe('false')
    expect(deleteSubmit().disabled).toBe(true)
  })

  it('deletes everything, forgets drafts and unread marks, reloads the chats and goes home', async () => {
    sessionStorage.setItem(`hf-composer-draft:${chatId(1)}`, 'unsent text')
    sessionStorage.setItem('hf-other', 'kept')
    // An unread mark, persisted by the chats store to localStorage['hf-unread'].
    useChatsStore().unread = { [chatId(1)]: true }
    await nextTick()
    expect(localStorage.getItem('hf-unread')).toBe(JSON.stringify([chatId(1)]))
    api.data.deleteAll.mockResolvedValue(deleted({ files: 18, fileBytes: 25_480_000 }))
    await mountData()

    await click(byTestId(testIds.dataDelete))
    await click(byTestId(testIds.dataDeleteFiles))
    await type(testIds.dataDeleteConfirmInput, 'DELETE')
    await click(deleteSubmit())

    expect(api.data.deleteAll).toHaveBeenCalledWith({ body: { confirm: 'DELETE', files: true, usage: false } })
    expect(api.auth.login).not.toHaveBeenCalled()
    expect(toasts.success).toHaveBeenCalledWith('Deleted 12 chats')
    expect(sessionStorage.getItem(`hf-composer-draft:${chatId(1)}`)).toBeNull()
    expect(sessionStorage.getItem('hf-other')).toBe('kept')
    expect(localStorage.getItem('hf-unread')).toBeNull()
    expect(useChatsStore().unread).toEqual({})
    expect(fetchChats).toHaveBeenCalledWith({ reset: true })
    expect(mocks.navigateTo).toHaveBeenCalledWith('/')
    expect(byTestId(testIds.dataDeleteDialog)).toBeNull()
  })

  it('asks for the password first when the session is not fresh', async () => {
    useAuthStore().status = passwordSet
    api.data.deleteAll.mockResolvedValue(deleted({ chats: 1 }))
    await mountData()
    await confirmDeleteAll()

    expect(byTestId(testIds.confirmPasswordDialog)).not.toBeNull()
    expect(api.data.deleteAll).not.toHaveBeenCalled()

    await submitPassword('wrong')
    expect(byTestId(testIds.confirmPasswordDialog)?.textContent).toContain('Wrong password')
    expect(api.data.deleteAll).not.toHaveBeenCalled()

    await submitPassword('correct-horse')
    expect(api.auth.login).toHaveBeenLastCalledWith({ body: { password: 'correct-horse' } })
    expect(api.data.deleteAll).toHaveBeenCalledTimes(1)
    expect(api.data.deleteAll).toHaveBeenCalledWith({ body: { confirm: 'DELETE', files: false, usage: false } })
    expect(toasts.success).toHaveBeenCalledWith('Deleted 1 chat')
    expect(mocks.navigateTo).toHaveBeenCalledWith('/')
  })

  it('asks for the password after a fresh-auth refusal and retries once', async () => {
    useAuthStore().status = { ...passwordSet, freshUntil: Date.now() + 60_000 }
    api.data.deleteAll.mockRejectedValueOnce(freshNeeded()).mockResolvedValueOnce(deleted())
    await mountData()
    await confirmDeleteAll()

    expect(api.data.deleteAll).toHaveBeenCalledTimes(1)
    expect(byTestId(testIds.confirmPasswordDialog)).not.toBeNull()
    await submitPassword('correct-horse')

    expect(api.auth.login).toHaveBeenCalledTimes(1)
    expect(api.data.deleteAll).toHaveBeenCalledTimes(2)
    expect(toasts.success).toHaveBeenCalledWith('Deleted 12 chats')
    expect(mocks.navigateTo).toHaveBeenCalledWith('/')
  })

  it('retries only once: a second refusal is reported', async () => {
    useAuthStore().status = { ...passwordSet, freshUntil: Date.now() + 60_000 }
    api.data.deleteAll.mockRejectedValue(freshNeeded())
    await mountData()
    await confirmDeleteAll()
    await submitPassword('correct-horse')

    expect(api.data.deleteAll).toHaveBeenCalledTimes(2)
    expect(toasts.error).toHaveBeenCalledWith('Not allowed', { description: 'Log in again to continue.' })
    expect(byTestId(testIds.confirmPasswordDialog)).toBeNull()
    expect(byTestId(testIds.dataDeleteDialog)).not.toBeNull()
    expect(mocks.navigateTo).not.toHaveBeenCalled()
  })

  it('does nothing when the password prompt is cancelled', async () => {
    useAuthStore().status = passwordSet
    await mountData()
    await confirmDeleteAll()
    const cancel = [...byTestId(testIds.confirmPasswordDialog)!.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Cancel')
    await click(cancel)

    expect(byTestId(testIds.confirmPasswordDialog)).toBeNull()
    expect(api.auth.login).not.toHaveBeenCalled()
    expect(api.data.deleteAll).not.toHaveBeenCalled()
    expect(byTestId(testIds.dataDeleteDialog)).not.toBeNull()
    expect(deleteSubmit().disabled).toBe(false)
    expect(document.activeElement).toBe(deleteSubmit())
  })

  it('keeps the dialog open with a toast when another import or delete runs', async () => {
    api.data.deleteAll.mockRejectedValue(busy())
    await mountData()
    await confirmDeleteAll()

    expect(toasts.error).toHaveBeenCalledWith(BUSY_MESSAGE)
    expect(byTestId(testIds.dataDeleteDialog)).not.toBeNull()
    expect(deleteSubmit().disabled).toBe(false)
    expect(mocks.navigateTo).not.toHaveBeenCalled()
  })

  it('leaves the counts out when the summary is unknown', async () => {
    api.data.summary.mockRejectedValue(new HarnessError({ code: 'internal_error', message: 'The database is locked.' }))
    await mountData()
    await click(byTestId(testIds.dataDelete))
    expect(byTestId(testIds.dataDeleteDialog)?.textContent).toContain('This deletes every chat and message.')
  })

  it('says that projects are kept (Phase 7)', async () => {
    await mountData()
    expect(byTestId(testIds.dataDelete)?.closest('section')?.textContent)
      .toContain('API keys, plugins, projects and settings are kept.')
  })
})

describe('storage cleanup and encryption key on the page', () => {
  it('reloads the summary line after a cleanup', async () => {
    await mountData()
    // The page and Storage cleanup (its automatic cleanup status) load GET /api/data on mount.
    expect(api.data.summary).toHaveBeenCalledTimes(2)
    api.data.cleanupPreview
      .mockResolvedValueOnce(dataCleanupPreview({ files: 6, fileBytes: 6_291_456 }))
      .mockResolvedValueOnce(dataCleanupPreview())
    api.data.cleanup.mockResolvedValue({ files: 6, fileBytes: 6_291_456, blobs: 6, diskBytes: 6_291_456, tempFiles: 0, ranAt: Date.now() })
    api.data.summary.mockResolvedValue(summary({ files: 12, fileBytes: 19_188_544 }))

    await click(byTestId(testIds.dataCleanupCheck))
    expect(byTestId(testIds.dataCleanupSummary)?.textContent).toContain('6 files · 6 MB can be removed')
    await click(byTestId(testIds.dataCleanupRun))
    await click(byTestId(testIds.dataCleanupConfirm))

    expect(toasts.success).toHaveBeenCalledWith('Removed 6 files (6 MB)')
    // Both again: a cleanup also resets the schedule of the automatic one.
    expect(api.data.summary).toHaveBeenCalledTimes(4)
    expect(byTestId(testIds.dataSummary)?.textContent).toContain('12 files, 18 MB')
    expect(byTestId(testIds.dataCleanupSummary)?.textContent).toContain('No unused files.')
  })

  it('reloads the summary line and Shared links after a key rotation', async () => {
    const result: KeyRotationResult = {
      keyVersion: 2,
      rotatedAt: Date.now(),
      secrets: 2,
      skippedSecrets: 0,
      shares: 1,
      approvalsExpired: 0,
      chats: 0,
      runsStopped: 0,
    }
    api.keys.rotate.mockResolvedValue(result)
    await mountData()
    expect(mocks.sharesMounts).toBe(1)

    await click(byTestId(testIds.dataKeyRotate))
    expect(byTestId(testIds.keyRotateDialog)?.textContent).toContain('Every share link changes (1 link)')
    await type(testIds.keyRotateConfirm, 'ROTATE')
    await click(byTestId(testIds.keyRotateSubmit))

    expect(api.keys.rotate).toHaveBeenCalledWith({ body: { confirm: 'ROTATE' } })
    expect(toasts.success).toHaveBeenCalledWith('Master key rotated', { description: '2 secrets encrypted again · 0 approvals expired' })
    expect(api.keys.get).toHaveBeenCalledTimes(2)
    // Twice on mount (the page and Storage cleanup), then the page again.
    expect(api.data.summary).toHaveBeenCalledTimes(3)
    expect(mocks.sharesMounts).toBe(2)
    expect(allByTestId(testIds.sharesSection)).toHaveLength(1)
  })

  it('asks for the password before a rotation when the session is not fresh', async () => {
    useAuthStore().status = passwordSet
    api.keys.rotate.mockResolvedValue({
      keyVersion: 2,
      rotatedAt: Date.now(),
      secrets: 2,
      skippedSecrets: 0,
      shares: 1,
      approvalsExpired: 0,
      chats: 0,
      runsStopped: 0,
    })
    await mountData()
    await click(byTestId(testIds.dataKeyRotate))
    await type(testIds.keyRotateConfirm, 'ROTATE')
    await click(byTestId(testIds.keyRotateSubmit))

    // One prompt, the rotate dialog's (the danger zone's prompt stays closed).
    expect(allByTestId(testIds.confirmPasswordDialog)).toHaveLength(1)
    expect(byTestId(testIds.confirmPasswordDialog)?.textContent).toContain('Rotating the master key needs your password.')
    expect(api.keys.rotate).not.toHaveBeenCalled()
    await submitPassword('correct-horse')
    expect(api.keys.rotate).toHaveBeenCalledTimes(1)
    expect(byTestId(testIds.keyRotateDialog)).toBeNull()
  })

  it('shows the busy toast when a cleanup meets another data task', async () => {
    api.data.cleanupPreview.mockRejectedValue(busy())
    await mountData()
    await click(byTestId(testIds.dataCleanupCheck))
    expect(toasts.error).toHaveBeenCalledWith('Another data task is running. Try again when it finishes.')
  })
})

describe('settings data page', () => {
  it('renders DataSettings in the settings page frame titled "Data"', async () => {
    const wrapper = mount(DataPage, { attachTo: document.body, global: { plugins: [pinia], stubs: { NuxtLink } } })
    wrappers.push(wrapper)
    await flushPromises()
    const header = wrapper.get(`[data-testid="${testIds.pageHeader}"]`)
    expect(header.get('h1').text()).toBe('Data')
    expect(header.text()).toContain('Back up and restore your chats, or delete them all.')
    expect(wrapper.find(`[data-testid="${testIds.dataSettings}"]`).exists()).toBe(true)
    const head = mocks.useHead.mock.calls[0]?.[0] as { title: ComputedRef<string> } | undefined
    expect(head?.title.value).toBe('Data · harness-forge')
  })
})

describe('dataSettings: Import from Claude Code (Phase 12, W12.10-T3)', () => {
  it('links to the import dialog of Customize from the Import section', async () => {
    await mountData()
    const link = byTestId(testIds.dataImportClaude)!
    expect(link.getAttribute('href')).toBe('/settings/customize?import=claude')
    expect(link.textContent?.trim()).toBe('Import from Claude Code…')
    expect(link.closest('section')?.querySelector('h2')?.textContent?.trim()).toBe('Import')
    expect(link.closest('section')?.textContent).toContain('Agents, commands, skills, hooks and MCP servers from a Claude Code folder.')
  })
})
