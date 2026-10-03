import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import { taskStep } from '~/utils/testing/fixtures'
import TaskStepRow from './TaskStepRow.vue'

describe('taskStepRow (P9-0b stub)', () => {
  it('renders its root with the tool name and the state', () => {
    const wrapper = mount(TaskStepRow, { props: { step: taskStep({ toolName: 'shell', summary: 'pnpm test', state: 'denied' }), running: false } })
    const root = wrapper.get(`[data-testid="${testIds.taskStep}"]`)
    expect(root.attributes()).toMatchObject({ 'data-tool-name': 'shell', 'data-state': 'denied' })
    expect(root.text()).toContain('pnpm test')
  })
})
