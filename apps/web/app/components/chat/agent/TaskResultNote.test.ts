import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { testIds } from '~/utils/testids'
import { taskOutput, taskResultData, taskStep } from '~/utils/testing/fixtures'
import TaskResultNote from './TaskResultNote.vue'

// The report renders through Markdown, which reads the color mode.
vi.mock('~/components/chat/nuxt-imports', () => ({ useColorMode: () => ({ value: 'dark' }) }))

afterEach(() => {
  document.body.replaceChildren()
})

function note(result = taskResultData(), variant: 'inline' | 'turn' = 'inline') {
  return mount({ render: () => h(TooltipProvider, null, { default: () => h(TaskResultNote, { result, variant }) }) }, { attachTo: document.body })
}

describe('taskResultNote', () => {
  it('is a dashed note named after the description, with its status, label, meta and first sentence', () => {
    const result = taskResultData({
      output: taskOutput({
        type: 'general',
        description: 'Find flaky tests',
        report: 'Two tests depend on wall-clock time. See below.',
        steps: [taskStep(), taskStep({ toolCallId: 'c2' })],
        stepsOmitted: 10,
        startedAt: 1_759_000_000_000,
        finishedAt: 1_759_000_182_000,
      }),
    })
    const wrapper = note(result, 'turn')
    const root = wrapper.get(`[data-testid="${testIds.taskResult}"]`)
    expect(root.attributes()).toMatchObject({ 'data-task-id': result.taskId, 'data-status': 'completed', 'data-variant': 'turn', 'role': 'note' })
    expect(root.attributes('aria-label')).toBe('Background agent result: Find flaky tests')
    expect(root.classes()).toEqual(expect.arrayContaining(['w-full', 'border-dashed', 'rounded-lg']))
    expect(root.text()).toContain('Background agent finished · Agent · Find flaky tests')
    const meta = root.get('[data-slot="task-result-meta"]')
    expect(meta.text()).toBe('12 tool calls · 3m 2s')
    expect(meta.classes()).toContain('max-sm:hidden')
    expect(root.get('[data-slot="task-result-summary"]').text()).toBe('Two tests depend on wall-clock time.')
  })

  it('words every final status and labels custom and explore agents', () => {
    const cases = [
      [taskOutput({ status: 'failed', report: '', error: 'The model is not available. Pick another.' }), 'Background agent failed', 'The model is not available.'],
      [taskOutput({ status: 'aborted', report: '', error: 'The server restarted before the task finished.' }), 'Background agent stopped', 'The server restarted before the task finished.'],
      [taskOutput({ status: 'limit', report: 'What I found so far.' }), 'Background agent reached its step limit', 'What I found so far.'],
      [taskOutput({ report: '' }), 'Background agent finished', 'No report.'],
    ] as const
    for (const [output, heading, summary] of cases) {
      const wrapper = note(taskResultData({ output }))
      expect(wrapper.text()).toContain(heading)
      expect(wrapper.get('[data-slot="task-result-summary"]').text()).toBe(summary)
      expect(wrapper.get(`[data-testid="${testIds.taskResult}"]`).attributes('data-status')).toBe(output.status)
      wrapper.unmount()
    }
    expect(note(taskResultData({ output: taskOutput({ type: 'reviewer' }) })).text()).toContain('· reviewer ·')
    expect(note(taskResultData({ output: taskOutput({ type: 'explore' }) })).text()).toContain('· Explore ·')
  })

  it('opens and hides the report with its copy button and meta line; collapsed by default', async () => {
    const result = taskResultData({
      output: taskOutput({ modelRef: 'anthropic:claude-haiku-5', usage: { totalTokens: 18_200 }, costUsd: 0.004, report: '## Findings\n\nTwo tests depend on time.' }),
    })
    const wrapper = note(result)
    const toggle = wrapper.get(`[data-testid="${testIds.taskResultToggle}"]`)
    expect(toggle.text()).toBe('Show report')
    expect(toggle.attributes()).toMatchObject({ 'aria-expanded': 'false', 'data-state': 'closed' })
    expect(toggle.attributes('aria-controls')).toBeUndefined()
    expect(wrapper.find(`[data-testid="${testIds.taskResultReport}"]`).exists()).toBe(false)

    await toggle.trigger('click')
    await flushPromises()
    expect(toggle.text()).toBe('Hide report')
    expect(toggle.attributes()).toMatchObject({ 'aria-expanded': 'true', 'data-state': 'open' })
    const report = wrapper.get(`[data-testid="${testIds.taskResultReport}"]`)
    expect(toggle.attributes('aria-controls')).toBe(report.attributes('id'))
    expect(report.text()).toContain('Two tests depend on time.')
    expect(report.get('[data-slot="task-result-markdown"]').classes()).toEqual(expect.arrayContaining(['max-h-[50dvh]', 'overflow-y-auto']))
    expect(report.find('button[aria-label="Copy report"]').exists()).toBe(true)
    expect(report.get('[data-slot="task-meta"]').text()).toBe('claude-haiku-5 · 18K tokens · $0.004 · 41s')

    await toggle.trigger('click')
    expect(wrapper.find(`[data-testid="${testIds.taskResultReport}"]`).exists()).toBe(false)
  })

  it('shows the failure alert above a partial report, and the error of a stopped agent without one', async () => {
    const failed = note(taskResultData({ output: taskOutput({ status: 'failed', report: 'Partial.', error: 'The model refused.' }) }))
    await failed.get(`[data-testid="${testIds.taskResultToggle}"]`).trigger('click')
    const report = failed.get(`[data-testid="${testIds.taskResultReport}"]`)
    expect(report.get('[role="alert"]').text()).toBe('The sub-agent failed: The model refused.')
    expect(report.text()).toContain('Partial.')
    failed.unmount()

    const stopped = note(taskResultData({ output: taskOutput({ status: 'aborted', report: '', error: 'The server restarted before the task finished.' }) }))
    await stopped.get(`[data-testid="${testIds.taskResultToggle}"]`).trigger('click')
    const empty = stopped.get('[data-slot="task-result-empty"]')
    expect(empty.text()).toBe('The server restarted before the task finished.')
    expect(stopped.find('[role="alert"]').exists()).toBe(false)
  })
})
