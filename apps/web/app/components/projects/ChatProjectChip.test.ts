// ChatProjectChip skeleton (docs/UI.md 7.20, 10.4; C15, P7-0b): nothing for a null or unknown project, else the root
// chip with data-value and data-state ok | missing. W7.9 adds the menu.
import { mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjectsStore } from '~/stores/projects'
import { testIds } from '~/utils/testids'
import { chatId, projectId, projectSummary } from '~/utils/testing/fixtures'
import ChatProjectChip from './ChatProjectChip.vue'

vi.mock('~/composables/useApi', () => ({ useApi: () => ({}) }))

let pinia: ReturnType<typeof createPinia>

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  useProjectsStore().items = [
    projectSummary({ id: projectId(1), name: 'Website' }),
    projectSummary({ id: projectId(2), name: 'Old', available: false, issue: 'The folder does not exist.' }),
  ]
})

afterEach(() => {
  disposePinia(pinia)
})

const root = `[data-testid="${testIds.chatProjectChip}"]`

function mountChip(projectId: string | null) {
  return mount(ChatProjectChip, { props: { chatId: chatId(1), projectId }, global: { plugins: [pinia] } })
}

describe('chatProjectChip', () => {
  it('renders nothing for a chat without a project or with an unknown one', () => {
    const none = mountChip(null)
    expect(none.find(root).exists()).toBe(false)
    none.unmount()
    const unknown = mountChip(projectId(9))
    expect(unknown.find(root).exists()).toBe(false)
    unknown.unmount()
  })

  it('renders its root with the project id and data-state ok, or missing when the folder is gone', () => {
    const ok = mountChip(projectId(1))
    const chip = ok.get(root)
    expect(chip.element).toBe(ok.element)
    expect(chip.attributes('data-value')).toBe(projectId(1))
    expect(chip.attributes('data-state')).toBe('ok')
    expect(chip.attributes('aria-label')).toBe('Project: Website')
    expect(ok.props()).toEqual({ chatId: chatId(1), projectId: projectId(1) })
    ok.unmount()

    const missing = mountChip(projectId(2))
    expect(missing.get(root).attributes('data-state')).toBe('missing')
    missing.unmount()
  })
})
