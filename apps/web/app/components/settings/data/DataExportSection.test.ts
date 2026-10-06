// DataExportSection (docs/UI.md 9.8): the Phase 11 copy of the export (W11.8): personal output styles are in every
// backup; hooks and project approvals never are. The export itself is covered by DataSettings.test.ts.
import { mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { testIds } from '~/utils/testids'
import { createMockApi } from '~/utils/testing/mock-api'
import DataExportSection from './DataExportSection.vue'

vi.mock('~/composables/useApi', () => ({ useApi: () => createMockApi() }))

let pinia: ReturnType<typeof createPinia>

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
})

afterEach(() => {
  disposePinia(pinia)
})

describe('dataExportSection', () => {
  it('says what a backup holds and what it never holds (Phase 11)', () => {
    const wrapper = mount(DataExportSection, { props: { summary: null }, global: { plugins: [pinia] } })
    expect(wrapper.text()).toContain('Download a zip with every chat, including archived chats and every message version, and your personal agents, commands, skills and output styles. API keys, passwords, plugins, MCP servers, hooks, project approvals and share links are never included.')
    expect(wrapper.find(`[data-testid="${testIds.dataExport}"]`).exists()).toBe(true)
    wrapper.unmount()
  })
})
