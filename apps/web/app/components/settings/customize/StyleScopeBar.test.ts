import { mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { styleOptions } from '~/components/chat/composer/output-style'
import { useProjectsStore } from '~/stores/projects'
import { testIds } from '~/utils/testids'
import { projectId, projectSummary, styleEntry } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import StyleScopeBar from './StyleScopeBar.vue'

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

describe('styleScopeBar (P11-0b stub)', () => {
  const options = styleOptions([styleEntry()])

  it('shows the global default without a project', () => {
    const wrapper = mount(StyleScopeBar, { props: { projectId: null, projectName: null, options }, global: { plugins: [pinia] } })
    const root = wrapper.get(`[data-testid="${testIds.customizeStyleDefault}"]`)
    expect(root.attributes('data-value')).toBe('default')
    expect(wrapper.text()).toContain('Your default')
  })

  it('shows the project\'s style, or Same as your default', () => {
    useProjectsStore().items = [projectSummary({ outputStyle: 'terse' }), projectSummary({ id: projectId(2), name: 'notes', outputStyle: null })]
    const styled = mount(StyleScopeBar, { props: { projectId: projectId(1), projectName: 'website', options }, global: { plugins: [pinia] } })
    expect(styled.get(`[data-testid="${testIds.customizeStyleDefault}"]`).attributes('data-value')).toBe('terse')
    expect(styled.text()).toContain('Style in website')
    const same = mount(StyleScopeBar, { props: { projectId: projectId(2), projectName: 'notes', options }, global: { plugins: [pinia] } })
    expect(same.get(`[data-testid="${testIds.customizeStyleDefault}"]`).attributes('data-value')).toBe('')
    expect(same.text()).toContain('Same as your default')
  })
})
