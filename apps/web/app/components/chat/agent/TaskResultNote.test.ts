import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import { taskOutput, taskResultData } from '~/utils/testing/fixtures'
import TaskResultNote from './TaskResultNote.vue'

describe('taskResultNote (P10-0b stub)', () => {
  it('renders its root as a named note with the task id, the status and the variant', () => {
    const result = taskResultData()
    const wrapper = mount(TaskResultNote, { props: { result, variant: 'turn' } })
    const root = wrapper.get(`[data-testid="${testIds.taskResult}"]`)
    expect(root.attributes()).toMatchObject({ 'data-task-id': result.taskId, 'data-status': 'completed', 'data-variant': 'turn', 'role': 'note' })
    expect(root.attributes('aria-label')).toBe(`Background agent result: ${result.output.description}`)
    expect(root.text()).toContain('Background agent finished')
  })

  it('reads a failed result with its error when there is no report', () => {
    const result = taskResultData({ output: taskOutput({ status: 'failed', report: '', error: 'The model is not available.' }) })
    const wrapper = mount(TaskResultNote, { props: { result, variant: 'inline' } })
    expect(wrapper.text()).toContain('Background agent failed')
    expect(wrapper.text()).toContain('The model is not available.')
  })
})
