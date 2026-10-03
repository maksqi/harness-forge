import type { TaskOutput } from '@harness-forge/shared'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { testIds } from '~/utils/testids'
import { taskInput, taskOutput, taskStep } from '~/utils/testing/fixtures'
import TaskBody from './TaskBody.vue'

vi.mock('~/components/chat/nuxt-imports', () => ({ useColorMode: () => ({ value: 'dark' }) }))

function mountBody(input: unknown, output: unknown, running = false) {
  return mount({ render: () => h(TooltipProvider, null, { default: () => h(TaskBody, { input, output, running }) }) }, { attachTo: document.body })
}

function steps(count: number): TaskOutput['steps'] {
  return Array.from({ length: count }, (_, index) => taskStep({ toolCallId: `child_${index + 1}`, summary: `file-${index + 1}.ts` }))
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('taskBody', () => {
  it('shows the prompt, the steps, the report and the meta line of a finished sub-agent', () => {
    const output = taskOutput({ modelRef: 'anthropic:claude-haiku-5', usage: { totalTokens: 18_200 }, costUsd: 0.004 })
    const wrapper = mountBody(taskInput(), output)
    const body = wrapper.get('[data-slot="task-body"]')
    expect(body.get('[data-label="prompt"]').text()).toContain('List the files that create sessions.')
    expect(wrapper.findAll(`[data-testid="${testIds.taskStep}"]`)).toHaveLength(1)
    const report = wrapper.get(`[data-testid="${testIds.taskReport}"]`)
    expect(report.text()).toContain('Report')
    expect(report.find('[data-slot="markdown"]').exists()).toBe(true)
    expect(report.text()).toContain('src/auth/session.ts')
    expect(report.find('button[aria-label="Copy report"]').exists()).toBe(true)
    expect(wrapper.get('[data-slot="task-meta"]').text()).toBe('claude-haiku-5 · 18K tokens · $0.004 · 41s')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })

  it('shows the latest 10 steps first, then all kept steps', async () => {
    const wrapper = mountBody(taskInput(), taskOutput({ steps: steps(14) }))
    const rows = () => wrapper.findAll(`[data-testid="${testIds.taskStep}"]`)
    expect(rows()).toHaveLength(10)
    expect(rows()[0]!.text()).toContain('file-5.ts')
    const more = wrapper.get(`[data-testid="${testIds.taskStepsMore}"]`)
    expect(more.text()).toBe('Show all 14 steps')
    await more.trigger('click')
    expect(rows()).toHaveLength(14)
    expect(wrapper.find(`[data-testid="${testIds.taskStepsMore}"]`).exists()).toBe(false)
  })

  it('says how many earlier steps were not kept', async () => {
    const wrapper = mountBody(taskInput(), taskOutput({ steps: steps(3), stepsOmitted: 7 }))
    expect(wrapper.get('[data-slot="task-steps-omitted"]').text()).toBe('7 earlier steps were not kept')
    const one = mountBody(taskInput(), taskOutput({ steps: steps(3), stepsOmitted: 1 }))
    expect(one.get('[data-slot="task-steps-omitted"]').text()).toBe('1 earlier step was not kept')
    const both = mountBody(taskInput(), taskOutput({ steps: steps(50), stepsOmitted: 4 }))
    expect(both.find('[data-slot="task-steps-omitted"]').exists()).toBe(false)
    await both.get(`[data-testid="${testIds.taskStepsMore}"]`).trigger('click')
    expect(both.get('[data-slot="task-steps-omitted"]').text()).toBe('4 earlier steps were not kept')
  })

  it('puts the failure alert above the partial report', () => {
    const wrapper = mountBody(taskInput(), taskOutput({ status: 'failed', error: 'The model refused.', report: 'Partial notes.' }))
    const alert = wrapper.get('[role="alert"]')
    expect(alert.text()).toBe('The sub-agent failed: The model refused.')
    const report = wrapper.get(`[data-testid="${testIds.taskReport}"]`)
    expect(alert.element.compareDocumentPosition(report.element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('leaves out the report and the meta line while the sub-agent runs without them', () => {
    const output = taskOutput({ status: 'running', report: '', finishedAt: undefined, steps: [taskStep({ state: 'running' })] })
    const wrapper = mountBody(taskInput(), output, true)
    expect(wrapper.find(`[data-testid="${testIds.taskReport}"]`).exists()).toBe(false)
    expect(wrapper.find('[data-slot="task-meta"]').exists()).toBe(false)
    expect(wrapper.get(`[data-testid="${testIds.taskStep}"]`).find('[role="status"]').exists()).toBe(true)
  })

  it('shows the prompt alone without an output, and nothing for an input that does not parse', () => {
    const prompt = mountBody(taskInput(), undefined)
    expect(prompt.get('[data-slot="task-body"]').text()).toContain('Prompt')
    expect(prompt.find(`[data-testid="${testIds.taskStep}"]`).exists()).toBe(false)
    expect(mountBody(null, 'nope', true).find('[data-slot="task-body"]').exists()).toBe(false)
  })
})
