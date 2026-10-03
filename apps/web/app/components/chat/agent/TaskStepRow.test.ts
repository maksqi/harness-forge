import type { TaskStep } from '@harness-forge/shared'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { h } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { testIds } from '~/utils/testids'
import { taskStep } from '~/utils/testing/fixtures'
import TaskStepRow from './TaskStepRow.vue'

function mountRow(step: TaskStep, running = false) {
  return mount({ render: () => h(TooltipProvider, null, { default: () => h(TaskStepRow, { step, running }) }) }, { attachTo: document.body })
}

function root(wrapper: ReturnType<typeof mountRow>) {
  return wrapper.get(`[data-testid="${testIds.taskStep}"]`)
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('taskStepRow', () => {
  it('shows the tool, the summary, the result preview and a check when done', () => {
    const wrapper = mountRow(taskStep({ toolName: 'find_files', summary: '**/session*.ts', resultPreview: '3 files' }))
    expect(root(wrapper).attributes()).toMatchObject({ 'data-tool-name': 'find_files', 'data-state': 'done' })
    expect(root(wrapper).text()).toContain('find_files')
    expect(root(wrapper).text()).toContain('"**/session*.ts"')
    expect(root(wrapper).get('[data-slot="task-step-preview"]').text()).toBe('3 files')
    expect(root(wrapper).find('.text-success').exists()).toBe(true)
    expect(root(wrapper).get('.sr-only').text()).toBe('Done')
  })

  it('spins only while the sub-agent runs; a running step of a stopped sub-agent reads "Stopped"', () => {
    const running = mountRow(taskStep({ state: 'running' }), true)
    expect(root(running).find('[role="status"]').exists()).toBe(true)
    expect(root(running).text()).not.toContain('Stopped')
    const stopped = mountRow(taskStep({ state: 'running' }), false)
    expect(root(stopped).find('[role="status"]').exists()).toBe(false)
    expect(root(stopped).text()).toContain('Stopped')
  })

  it('marks a failed step', () => {
    const wrapper = mountRow(taskStep({ state: 'error', resultPreview: 'ENOENT' }))
    expect(root(wrapper).attributes('data-state')).toBe('error')
    expect(root(wrapper).find('.text-destructive').exists()).toBe(true)
    expect(root(wrapper).text()).toContain('Failed')
  })

  it('reads "Skipped" for a denied step, with the reason in the tooltip and for screen readers', () => {
    const wrapper = mountRow(taskStep({ toolName: 'shell', summary: 'pnpm test', state: 'denied', resultPreview: 'denied' }))
    expect(root(wrapper).attributes()).toMatchObject({ 'data-tool-name': 'shell', 'data-state': 'denied' })
    expect(root(wrapper).text()).toContain('pnpm test')
    expect(root(wrapper).text()).toContain('Skipped')
    expect(root(wrapper).find('[data-slot="task-step-preview"]').exists()).toBe(false)
    const trigger = root(wrapper).get('[tabindex="0"]')
    expect(trigger.text()).toContain('Sub-agents can\'t ask for approval, so this was skipped.')
    expect(trigger.get('.sr-only').text()).toContain('Sub-agents can\'t ask for approval, so this was skipped.')
  })

  it('names MCP tools by their tool name', () => {
    const wrapper = mountRow(taskStep({ toolName: 'mcp__docs__search', summary: 'cookies' }))
    expect(root(wrapper).text()).toContain('search')
    expect(root(wrapper).text()).not.toContain('mcp__')
  })
})
