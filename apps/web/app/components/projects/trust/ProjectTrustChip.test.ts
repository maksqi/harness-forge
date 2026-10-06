// The trust chip of the chat header (docs/UI.md 5.6, 7.33, 14.2; W11.9-T3): hidden without pending items, the lazy fetch
// of the project's list when a chat of the project opens, the count and its accessible name, and the trust dialog through
// the chat view's actions.
import type { MockApi } from '~/utils/testing/mock-api'
import { createServerEvent, HarnessError } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { CHAT_VIEW_ACTIONS } from '~/components/chat/chat-context'
import { useProjectTrustStore } from '~/stores/project-trust'
import { useProjectsStore } from '~/stores/projects'
import { testIds } from '~/utils/testids'
import { projectId, projectSummary, projectTrustList, trustCommandItem, trustHookItem } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import ProjectTrustChip from './ProjectTrustChip.vue'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))

let pinia: ReturnType<typeof createPinia>
let api: MockApi

beforeEach(() => {
  api = createMockApi()
  mock.api = api
  pinia = createPinia()
  setActivePinia(pinia)
})

afterEach(() => {
  disposePinia(pinia)
})

function actions() {
  return { openModelPicker: vi.fn(), openProjectTrust: vi.fn(), openProjectMcp: vi.fn() }
}

describe('projectTrustChip', () => {
  it('renders nothing without a project or without pending items, quietly when the fetch fails', async () => {
    api.projectTrust.list.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'Boom.' }))
    const wrapper = mount(ProjectTrustChip, { props: { projectId: projectId(1) }, global: { plugins: [pinia] } })
    await flushPromises()
    expect(wrapper.find(`[data-testid="${testIds.projectTrustChip}"]`).exists()).toBe(false)
    const none = mount(ProjectTrustChip, { props: { projectId: null }, global: { plugins: [pinia] } })
    expect(none.find(`[data-testid="${testIds.projectTrustChip}"]`).exists()).toBe(false)
    expect(api.projectTrust.list).toHaveBeenCalledTimes(1)
  })

  it('fetches the project\'s list when it mounts, reuses a fresh one and follows the project', async () => {
    useProjectsStore().items = [projectSummary(), projectSummary({ id: projectId(2), name: 'Notes' })]
    api.projectTrust.list.mockResolvedValueOnce(projectTrustList())
    const wrapper = mount(ProjectTrustChip, { props: { projectId: projectId(1) }, global: { plugins: [pinia] } })
    await flushPromises()
    expect(api.projectTrust.list).toHaveBeenCalledWith({ params: { id: projectId(1) } })
    const chip = wrapper.get(`[data-testid="${testIds.projectTrustChip}"]`)
    expect(chip.attributes('data-count')).toBe('2')
    expect(chip.text()).toBe('2 to review')

    // A second chat of the same project reuses the list fetched a moment ago.
    mount(ProjectTrustChip, { props: { projectId: projectId(1) }, global: { plugins: [pinia] } })
    await flushPromises()
    expect(api.projectTrust.list).toHaveBeenCalledTimes(1)

    api.projectTrust.list.mockResolvedValueOnce(projectTrustList({ items: [trustHookItem(), trustCommandItem()] }))
    await wrapper.setProps({ projectId: projectId(2) })
    await flushPromises()
    expect(api.projectTrust.list).toHaveBeenLastCalledWith({ params: { id: projectId(2) } })
    expect(wrapper.get(`[data-testid="${testIds.projectTrustChip}"]`).attributes('aria-label')).toBe('Review 1 item in Notes that can run commands')
  })

  it('shows the count of project-trust.changed and opens the trust dialog through the chat view', async () => {
    useProjectsStore().items = [projectSummary()]
    const view = actions()
    const wrapper = mount(ProjectTrustChip, { props: { projectId: projectId(1) }, global: { plugins: [pinia], provide: { [CHAT_VIEW_ACTIONS as symbol]: view } } })
    await flushPromises()
    useProjectTrustStore().applyEvent(createServerEvent('project-trust.changed', { projectId: projectId(1), pending: 3 }, 1))
    await nextTick()
    const chip = wrapper.get(`[data-testid="${testIds.projectTrustChip}"]`)
    expect(chip.attributes('data-count')).toBe('3')
    expect(chip.attributes('aria-label')).toBe(`Review 3 items in ${projectSummary().name} that can run commands`)
    expect(chip.attributes('type')).toBe('button')
    await chip.trigger('click')
    expect(view.openProjectTrust).toHaveBeenCalledTimes(1)
    expect(view.openProjectTrust).toHaveBeenCalledWith()

    useProjectTrustStore().applyEvent(createServerEvent('project-trust.changed', { projectId: projectId(1), pending: 0 }, 2))
    await nextTick()
    expect(wrapper.find(`[data-testid="${testIds.projectTrustChip}"]`).exists()).toBe(false)
  })
})
