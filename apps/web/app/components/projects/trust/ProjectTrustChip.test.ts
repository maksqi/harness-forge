import { createServerEvent } from '@harness-forge/shared'
import { mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CHAT_VIEW_ACTIONS } from '~/components/chat/chat-context'
import { useProjectTrustStore } from '~/stores/project-trust'
import { useProjectsStore } from '~/stores/projects'
import { testIds } from '~/utils/testids'
import { projectId, projectSummary } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import ProjectTrustChip from './ProjectTrustChip.vue'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))

let pinia: ReturnType<typeof createPinia>

beforeEach(() => {
  mock.api = createMockApi()
  pinia = createPinia()
  setActivePinia(pinia)
})

afterEach(() => {
  disposePinia(pinia)
})

describe('projectTrustChip (P11-0b stub)', () => {
  it('renders nothing without a pending count', () => {
    const wrapper = mount(ProjectTrustChip, { props: { projectId: projectId(1) }, global: { plugins: [pinia] } })
    expect(wrapper.find(`[data-testid="${testIds.projectTrustChip}"]`).exists()).toBe(false)
    const none = mount(ProjectTrustChip, { props: { projectId: null }, global: { plugins: [pinia] } })
    expect(none.find(`[data-testid="${testIds.projectTrustChip}"]`).exists()).toBe(false)
  })

  it('shows the pending count and opens the trust dialog through the chat view', async () => {
    useProjectsStore().items = [projectSummary()]
    useProjectTrustStore().applyEvent(createServerEvent('project-trust.changed', { projectId: projectId(1), pending: 3 }, 1))
    const actions = { openModelPicker: vi.fn(), openProjectTrust: vi.fn(), openProjectMcp: vi.fn() }
    const wrapper = mount(ProjectTrustChip, { props: { projectId: projectId(1) }, global: { plugins: [pinia], provide: { [CHAT_VIEW_ACTIONS as symbol]: actions } } })
    const chip = wrapper.get(`[data-testid="${testIds.projectTrustChip}"]`)
    expect(chip.attributes('data-count')).toBe('3')
    expect(chip.attributes('aria-label')).toBe(`Review 3 items in ${projectSummary().name} that can run commands`)
    await chip.trigger('click')
    expect(actions.openProjectTrust).toHaveBeenCalledTimes(1)
  })
})
