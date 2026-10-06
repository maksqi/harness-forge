import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjectsStore } from '~/stores/projects'
import { testIds } from '~/utils/testids'
import { projectId, projectSummary } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import ProjectMcpDialog from './ProjectMcpDialog.vue'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))

let pinia: ReturnType<typeof createPinia>

beforeEach(() => {
  mock.api = createMockApi()
  pinia = createPinia()
  setActivePinia(pinia)
})

afterEach(() => {
  document.body.replaceChildren()
  disposePinia(pinia)
})

describe('projectMcpDialog (P11-0b stub)', () => {
  it('renders its root with the project\'s name while open and closes', async () => {
    useProjectsStore().items = [projectSummary()]
    const wrapper = mount(ProjectMcpDialog, {
      props: { open: true, projectId: projectId(1), focusServerId: 'memory' },
      attachTo: document.body,
      global: { plugins: [pinia] },
    })
    await flushPromises()
    const dialog = document.body.querySelector<HTMLElement>(`[data-testid="${testIds.projectMcpDialog}"]`)!
    expect(dialog.textContent).toContain(`MCP servers in ${projectSummary().name}`)
    const close = [...dialog.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Close')!
    close.click()
    expect(wrapper.emitted('update:open')).toEqual([[false]])
    wrapper.unmount()
  })
})
