import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import { backgroundTask, taskOutput } from '~/utils/testing/fixtures'
import BackgroundAgentRow from './BackgroundAgentRow.vue'

const running = backgroundTask({ status: 'running', finishedAt: null, output: taskOutput({ status: 'running', type: 'reviewer', description: 'Review the diff', finishedAt: undefined }) })

describe('backgroundAgentRow (P10-0b stub)', () => {
  it('renders its root with the task\'s data attributes and emits stop', async () => {
    const wrapper = mount(BackgroundAgentRow, { props: { task: running, stopping: false, open: false } })
    const root = wrapper.get(`[data-testid="${testIds.backgroundAgent}"]`)
    expect(root.attributes()).toMatchObject({ 'data-task-id': running.id, 'data-state': 'running', 'data-kind': 'custom', 'data-agent-type': 'reviewer' })
    const stop = wrapper.get(`[data-testid="${testIds.backgroundAgentStop}"]`)
    expect(stop.attributes('aria-label')).toBe('Stop Review the diff')
    await stop.trigger('click')
    expect(wrapper.emitted('stop')).toEqual([[]])
  })

  it('offers no Stop while stopping or once the task ended', () => {
    expect(mount(BackgroundAgentRow, { props: { task: running, stopping: true } }).find(`[data-testid="${testIds.backgroundAgentStop}"]`).exists()).toBe(false)
    const ended = mount(BackgroundAgentRow, { props: { task: backgroundTask(), stopping: false } })
    expect(ended.find(`[data-testid="${testIds.backgroundAgentStop}"]`).exists()).toBe(false)
    expect(ended.get(`[data-testid="${testIds.backgroundAgent}"]`).attributes('data-kind')).toBe('explore')
  })
})
