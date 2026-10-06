import type { DataImportResult } from '@harness-forge/shared'
// DataImportSection, Phase 10 (docs/UI.md 9.8; W10.8-T7): "Restore settings from the backup" also restores the
// personal agents, commands and skills (`restoreCustomizations` goes with `restoreSettings`), its help says so, and a
// restore that brought definitions back refreshes the loaded customization lists. The rest of the section is covered
// by DataSettings.test.ts.
import type { VueWrapper } from '@vue/test-utils'
import type { MockApi } from '~/utils/testing/mock-api'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { useCustomizationsStore } from '~/stores/customizations'
import { testIds } from '~/utils/testids'
import { createMockApi } from '~/utils/testing/mock-api'
import DataImportSection from './DataImportSection.vue'

const mocks = vi.hoisted(() => ({ api: null as unknown }))

vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api }))
vi.mock('vue-sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }))

let api: MockApi
let pinia: ReturnType<typeof createPinia>
let wrapper: VueWrapper | null = null

function result(overrides: Partial<DataImportResult> = {}): DataImportResult {
  return {
    kind: 'backup',
    counts: { imported: 0, copied: 0, skipped: 0, failed: 0, filesImported: 0, filesReused: 0, filesMissing: 0 },
    settingsRestored: true,
    items: [],
    warnings: [],
    ...overrides,
  }
}

beforeEach(() => {
  api = createMockApi()
  mocks.api = api
  pinia = createPinia()
  setActivePinia(pinia)
  api.chats.list.mockResolvedValue({ items: [], nextCursor: null })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.replaceChildren()
  disposePinia(pinia)
})

function byTestId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.body.querySelector<T>(`[data-testid="${id}"]`)
}

async function chooseBackup(name = 'backup.zip'): Promise<void> {
  const input = byTestId<HTMLInputElement>(testIds.dataImportFile)!
  Object.defineProperty(input, 'files', { value: [new File(['zip'], name, { type: 'application/zip' })], configurable: true })
  input.dispatchEvent(new Event('change', { bubbles: true }))
  await nextTick()
}

describe('dataImportSection (Phase 10)', () => {
  it('restores the personal definitions together with the settings and says so', async () => {
    const refreshLoaded = vi.spyOn(useCustomizationsStore(), 'refreshLoaded').mockResolvedValue()
    api.data.import.mockResolvedValue(result({ customizations: { imported: 3, skipped: 1, failed: 0 } }))
    wrapper = mount(DataImportSection, { attachTo: document.body, global: { plugins: [pinia] } })
    await chooseBackup()
    const restore = byTestId(testIds.dataImportRestoreSettings)!
    expect(restore.closest('[data-slot="field"]')?.textContent)
      .toContain('General and appearance settings, and your personal agents, commands, skills and output styles. A personal definition you already have with the same name is kept; commands with shell lines come back turned off.')
    restore.click()
    await flushPromises()
    byTestId(testIds.dataImport)!.click()
    await flushPromises()
    const form = (api.data.import.mock.calls[0]![0] as { form: FormData }).form
    expect([...form.keys()]).toEqual(['onConflict', 'restoreSettings', 'restoreCustomizations', 'file'])
    expect(form.get('restoreSettings')).toBe('true')
    expect(form.get('restoreCustomizations')).toBe('true')
    expect(refreshLoaded).toHaveBeenCalledTimes(1)
  })

  it('sends false for both flags when the switch is off and leaves the customizations alone', async () => {
    const refreshLoaded = vi.spyOn(useCustomizationsStore(), 'refreshLoaded').mockResolvedValue()
    api.data.import.mockResolvedValue(result({ settingsRestored: false }))
    wrapper = mount(DataImportSection, { attachTo: document.body, global: { plugins: [pinia] } })
    await chooseBackup()
    byTestId(testIds.dataImport)!.click()
    await flushPromises()
    const form = (api.data.import.mock.calls[0]![0] as { form: FormData }).form
    expect(form.get('restoreSettings')).toBe('false')
    expect(form.get('restoreCustomizations')).toBe('false')
    expect(refreshLoaded).not.toHaveBeenCalled()
  })
})

describe('dataImportSection: Import from Claude Code (Phase 12, C46-T7)', () => {
  it('links to the import dialog of Customize', () => {
    const NuxtLink = { props: ['to'], template: '<a :data-to="JSON.stringify(to)"><slot /></a>' }
    wrapper = mount(DataImportSection, { attachTo: document.body, global: { plugins: [pinia], stubs: { NuxtLink } } })
    const link = byTestId(testIds.dataImportClaude)!
    expect(link.textContent?.trim()).toBe('Import from Claude Code…')
    expect(JSON.parse(link.dataset.to!)).toEqual({ path: '/settings/customize', query: { import: 'claude' } })
  })
})
