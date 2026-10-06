import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjectsStore } from '~/stores/projects'
import { testIds } from '~/utils/testids'
import { projectId, projectSummary, trustSha } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import ProjectTrustDialog from './ProjectTrustDialog.vue'

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

describe('projectTrustDialog (P11-0b stub)', () => {
  it('renders its root with the project\'s name while open and closes', async () => {
    useProjectsStore().items = [projectSummary()]
    const wrapper = mount(ProjectTrustDialog, {
      props: { open: true, projectId: projectId(1), focusKey: trustSha(1) },
      attachTo: document.body,
      global: { plugins: [pinia] },
    })
    await flushPromises()
    const dialog = document.body.querySelector<HTMLElement>(`[data-testid="${testIds.projectTrustDialog}"]`)!
    expect(dialog.textContent).toContain(`Review ${projectSummary().name}`)
    const close = [...dialog.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Close')!
    close.click()
    expect(wrapper.emitted('update:open')).toEqual([[false]])
    wrapper.unmount()
  })

  it('renders nothing while closed', async () => {
    const wrapper = mount(ProjectTrustDialog, { props: { open: false, projectId: null }, attachTo: document.body, global: { plugins: [pinia] } })
    await flushPromises()
    expect(document.body.querySelector(`[data-testid="${testIds.projectTrustDialog}"]`)).toBeNull()
    wrapper.unmount()
  })
})
