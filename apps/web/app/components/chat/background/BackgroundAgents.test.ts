import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import { backgroundTask, backgroundTaskId, taskOutput } from '~/utils/testing/fixtures'
import BackgroundAgents from './BackgroundAgents.vue'

describe('backgroundAgents (P10-0b stub)', () => {
  it('renders nothing without tasks', () => {
    const wrapper = mount(BackgroundAgents, { props: { tasks: [] } })
    expect(wrapper.find(`[data-testid="${testIds.backgroundAgents}"]`).exists()).toBe(false)
  })

  it('renders the collapsed list with the running and visible counts, the toggle and the announcer', () => {
    const live = backgroundTask({ id: backgroundTaskId(2), status: 'running', finishedAt: null, output: taskOutput({ status: 'running', description: 'Find flaky tests', finishedAt: undefined }) })
    const wrapper = mount(BackgroundAgents, { props: { tasks: [live, backgroundTask()], stopping: [], reveal: null } })
    const root = wrapper.get(`[data-testid="${testIds.backgroundAgents}"]`)
    expect(root.attributes()).toMatchObject({ 'data-state': 'closed', 'data-count': '1', 'data-total': '2' })
    expect(wrapper.get(`[data-testid="${testIds.backgroundAgentsToggle}"]`).attributes('aria-label')).toBe('Show background agents, 1 running')
    expect(wrapper.find('[data-slot="background-agents-announcer"]').exists()).toBe(true)
  })
})
