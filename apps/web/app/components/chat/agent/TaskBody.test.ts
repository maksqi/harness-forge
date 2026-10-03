import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { taskInput, taskOutput } from '~/utils/testing/fixtures'
import TaskBody from './TaskBody.vue'

describe('taskBody (P9-0b stub)', () => {
  it('accepts the input, the output and the running flag', () => {
    const wrapper = mount(TaskBody, { props: { input: taskInput(), output: taskOutput(), running: false } })
    expect(wrapper.find('[data-slot="task-body"]').exists()).toBe(true)
    expect(mount(TaskBody, { props: { input: null, output: 'nope', running: true } }).find('[data-slot="task-body"]').exists()).toBe(true)
  })
})
