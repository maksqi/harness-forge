import type { BackgroundTask } from '@harness-forge/shared'
import type { BackgroundTaskInput } from '../chat-context'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { testIds } from '~/utils/testids'
import { backgroundTask, taskInput, taskOutput, taskStep } from '~/utils/testing/fixtures'
import { BACKGROUND_TASK_INPUT } from '../chat-context'
import BackgroundAgentRow from './BackgroundAgentRow.vue'

vi.mock('~/components/chat/nuxt-imports', () => ({ useColorMode: () => ({ value: 'dark' }) }))

const T0 = 1_759_000_000_000
const running = backgroundTask({
  status: 'running',
  finishedAt: null,
  output: taskOutput({ status: 'running', type: 'reviewer', description: 'Review the diff', finishedAt: undefined, startedAt: T0, steps: [taskStep({ toolName: 'shell', summary: 'pnpm vitest --run', state: 'running' })] }),
})

function mountRow(props: { task: BackgroundTask, stopping: boolean, open?: boolean }, input: BackgroundTaskInput | null = () => taskInput()) {
  return mount({
    render: () => h(TooltipProvider, null, { default: () => h(BackgroundAgentRow, props) }),
  }, { attachTo: document.body, global: { provide: input ? { [BACKGROUND_TASK_INPUT as symbol]: input } : {} } })
}

afterEach(() => {
  vi.useRealTimers()
  document.body.replaceChildren()
})

describe('backgroundAgentRow', () => {
  it('renders its root with the task\'s data attributes, the label, the live step and the ticking meta, and emits stop', async () => {
    vi.useFakeTimers({ now: T0 + 72_000 })
    const wrapper = mountRow({ task: running, stopping: false, open: false })
    const root = wrapper.get(`[data-testid="${testIds.backgroundAgent}"]`)
    expect(root.element.tagName).toBe('LI')
    expect(root.attributes()).toMatchObject({ 'data-task-id': running.id, 'data-state': 'running', 'data-kind': 'custom', 'data-agent-type': 'reviewer' })
    expect(root.attributes('aria-busy')).toBeUndefined()
    expect(root.text()).toContain('reviewer')
    expect(root.text()).toContain('Review the diff')
    expect(root.get('[data-slot="background-agent-live"]').text()).toBe('└ shell "pnpm vitest --run"')
    expect(root.get('[data-slot="background-agent-meta"]').text()).toBe('1 tool call · 1m 12s')
    vi.advanceTimersByTime(2000)
    await wrapper.vm.$nextTick()
    expect(root.get('[data-slot="background-agent-meta"]').text()).toBe('1 tool call · 1m 14s')
    const stop = wrapper.get(`[data-testid="${testIds.backgroundAgentStop}"]`)
    expect(stop.attributes('aria-label')).toBe('Stop Review the diff')
    await stop.trigger('click')
    expect(wrapper.findComponent(BackgroundAgentRow).emitted('stop')).toEqual([[]])
  })

  it('shows a spinner in place of Stop and aria-busy while the stop is in flight', () => {
    const wrapper = mountRow({ task: running, stopping: true })
    expect(wrapper.find(`[data-testid="${testIds.backgroundAgentStop}"]`).exists()).toBe(false)
    expect(wrapper.find('[data-slot="background-agent-stopping"]').exists()).toBe(true)
    expect(wrapper.get(`[data-testid="${testIds.backgroundAgent}"]`).attributes('aria-busy')).toBe('true')
  })

  it('an ended, undelivered row shows its status word and "Report pending" instead of Stop', () => {
    const ended = mountRow({ task: backgroundTask(), stopping: false })
    const root = ended.get(`[data-testid="${testIds.backgroundAgent}"]`)
    expect(root.attributes()).toMatchObject({ 'data-kind': 'explore', 'data-state': 'completed' })
    expect(ended.find(`[data-testid="${testIds.backgroundAgentStop}"]`).exists()).toBe(false)
    expect(root.get('[data-slot="background-agent-status"]').text()).toBe('Finished')
    expect(root.get('[data-slot="background-agent-pending"]').text()).toBe('Report pending')
    expect(root.text()).toContain('Explore')
    expect(root.get('[data-slot="background-agent-live"]').text()).toBe('Sessions are created in src/auth/session.ts.')
    expect(root.get('[data-slot="background-agent-meta"]').text()).toBe('1 tool call · 41s')
    const stopped = mountRow({ task: backgroundTask({ status: 'aborted', output: taskOutput({ status: 'aborted', type: 'general-purpose', report: '', error: 'The background task was stopped.' }) }), stopping: false })
    expect(stopped.get(`[data-testid="${testIds.backgroundAgent}"]`).attributes('data-kind')).toBe('general')
    expect(stopped.get('[data-slot="background-agent-status"]').text()).toBe('Stopped')
    expect(stopped.get('[data-slot="background-agent-live"]').text()).toBe('The background task was stopped.')
  })

  it('the details toggle opens TaskBody with the launching call\'s input and the live output', async () => {
    const wrapper = mountRow({ task: running, stopping: false })
    const toggle = wrapper.get(`[data-testid="${testIds.backgroundAgentToggle}"]`)
    expect(toggle.attributes()).toMatchObject({ 'aria-expanded': 'false', 'data-state': 'closed', 'aria-label': 'Show details of Review the diff' })
    expect(wrapper.find('[data-slot="task-body"]').exists()).toBe(false)
    await toggle.trigger('click')
    const row = wrapper.findComponent(BackgroundAgentRow)
    expect(row.emitted('update:open')).toEqual([[true]])
    expect(toggle.attributes()).toMatchObject({ 'aria-expanded': 'true', 'data-state': 'open', 'aria-label': 'Hide details of Review the diff' })
    const body = wrapper.get('[data-slot="task-body"]')
    expect(toggle.attributes('aria-controls')).toBe(body.element.parentElement!.id)
    expect(body.text()).toContain('List the files that create sessions.')
    expect(wrapper.findAll(`[data-testid="${testIds.taskStep}"]`)).toHaveLength(1)
  })

  it('follows a controlled open prop, and has no details toggle without the launching call', () => {
    const open = mountRow({ task: running, stopping: false, open: true })
    expect(open.find('[data-slot="task-body"]').exists()).toBe(true)
    const unknown = mountRow({ task: running, stopping: false }, () => null)
    expect(unknown.find(`[data-testid="${testIds.backgroundAgentToggle}"]`).exists()).toBe(false)
    expect(unknown.get(`[data-testid="${testIds.backgroundAgent}"]`).text()).toContain('Review the diff')
    const orphan = mountRow({ task: running, stopping: false }, null)
    expect(orphan.find(`[data-testid="${testIds.backgroundAgentToggle}"]`).exists()).toBe(false)
  })
})
