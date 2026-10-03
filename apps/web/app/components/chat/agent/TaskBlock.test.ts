import type { ToolPartLike } from '../chat-format'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { testIds } from '~/utils/testids'
import { taskInput, taskOutput, taskPart, taskStep } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import TaskBlock from './TaskBlock.vue'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api, useApiFetch: () => vi.fn() }))
vi.mock('~/components/chat/nuxt-imports', () => ({ useColorMode: () => ({ value: 'dark' }) }))

beforeEach(() => {
  mock.api = createMockApi()
  setActivePinia(createPinia())
})

afterEach(() => {
  vi.useRealTimers()
  document.body.replaceChildren()
})

function block(part: ToolPartLike, streaming = true, superseded = false) {
  return mount({
    render: () => h(TooltipProvider, null, { default: () => h(TaskBlock, { part, streaming, superseded }) }),
  }, { attachTo: document.body })
}

function root(wrapper: ReturnType<typeof block>) {
  return wrapper.get(`[data-testid="${testIds.taskBlock}"]`)
}

function trigger(wrapper: ReturnType<typeof block>) {
  return wrapper.get(`[data-testid="${testIds.taskBlockTrigger}"]`)
}

function live(wrapper: ReturnType<typeof block>) {
  return wrapper.get('[data-slot="task-live"]')
}

const runningOutput = taskOutput({
  status: 'running',
  finishedAt: undefined,
  report: '',
  steps: [taskStep(), taskStep({ toolCallId: 'child_call_2', toolName: 'search_files', summary: 'cookie', state: 'running' })],
  stepsOmitted: 2,
})

describe('taskBlock', () => {
  it('shows a running explore sub-agent on two lines: the trigger and the latest step', () => {
    const wrapper = block(taskPart({ preliminary: true, output: runningOutput }) as ToolPartLike)
    expect(root(wrapper).attributes()).toMatchObject({ 'data-state': 'running', 'data-kind': 'explore' })
    expect(trigger(wrapper).text()).toContain('Explore')
    expect(trigger(wrapper).text()).toContain('Find the session code')
    expect(trigger(wrapper).find('[role="status"]').exists()).toBe(true)
    expect(trigger(wrapper).attributes('aria-label')).toBe('Explore sub-agent: Find the session code, running, 4 tool calls')
    const meta = trigger(wrapper).get('[data-slot="task-meta-short"]')
    expect(meta.text()).toMatch(/^4 tool calls · /)
    expect(meta.classes()).toContain('max-sm:hidden')
    expect(live(wrapper).text()).toBe('└ search_files "cookie"')
    expect(live(wrapper).attributes('aria-hidden')).toBe('true')
    expect(live(wrapper).classes()).toContain('h-5')
  })

  it('shows a finished general sub-agent: its counts, the check and the first sentence of the report', async () => {
    const output = taskOutput({ type: 'general', report: 'Sessions live in `src/auth/session.ts`. More below.' })
    const wrapper = block(taskPart({ input: taskInput({ type: 'general', description: 'Draft the migration' }), output }) as ToolPartLike, false)
    expect(root(wrapper).attributes()).toMatchObject({ 'data-state': 'completed', 'data-kind': 'general' })
    expect(trigger(wrapper).text()).toContain('Agent')
    expect(trigger(wrapper).get('[data-slot="task-meta-short"]').text()).toBe('1 tool call · 41s')
    expect(trigger(wrapper).find('.text-success').exists()).toBe(true)
    expect(trigger(wrapper).attributes('aria-label')).toBe('Sub-agent: Draft the migration, completed, 1 tool call')
    expect(live(wrapper).text()).toBe('Sessions live in src/auth/session.ts.')
    // Collapsed until the trigger is clicked; then the body with the report.
    expect(wrapper.find(`[data-testid="${testIds.taskReport}"]`).exists()).toBe(false)
    await trigger(wrapper).trigger('click')
    expect(trigger(wrapper).attributes('aria-expanded')).toBe('true')
    expect(wrapper.get(`[data-testid="${testIds.taskReport}"]`).text()).toContain('More below.')
  })

  it('shows a failed sub-agent with its error, and the alert when expanded', async () => {
    const output = taskOutput({ status: 'failed', error: 'The model refused. Try again.', report: '' })
    const wrapper = block(taskPart({ output }) as ToolPartLike, false)
    expect(root(wrapper).attributes('data-state')).toBe('failed')
    expect(trigger(wrapper).find('.text-destructive').exists()).toBe(true)
    expect(trigger(wrapper).attributes('aria-label')).toContain(', failed, ')
    expect(live(wrapper).text()).toBe('The model refused.')
    await trigger(wrapper).trigger('click')
    expect(wrapper.get('[role="alert"]').text()).toBe('The sub-agent failed: The model refused. Try again.')
  })

  it('shows "Stopped" for a snapshot after the stream ended, an aborted output and a stopped run after a reload', () => {
    const snapshot = block(taskPart({ preliminary: true, output: runningOutput }) as ToolPartLike, false)
    expect(root(snapshot).attributes('data-state')).toBe('aborted')
    expect(trigger(snapshot).text()).toContain('Stopped')
    expect(trigger(snapshot).attributes('aria-label')).toContain(', stopped, ')
    // The last step no longer spins.
    expect(live(snapshot).text()).toBe('')

    const aborted = block(taskPart({ output: taskOutput({ status: 'aborted', error: 'Stopped by the user.', report: '' }) }) as ToolPartLike, false)
    expect(root(aborted).attributes('data-state')).toBe('aborted')
    expect(trigger(aborted).text()).toContain('Stopped')

    const reloaded = { type: 'tool-task', toolCallId: 'call_task_1', state: 'output-error', input: taskInput(), errorText: 'The run was stopped before the tool finished.' } as ToolPartLike
    const stored = block(reloaded, false)
    expect(root(stored).attributes('data-state')).toBe('aborted')
    expect(trigger(stored).text()).toContain('Stopped')
    expect(stored.find(`[data-testid="${testIds.toolRow}"]`).exists()).toBe(false)
  })

  it('shows "Step limit reached" for a sub-agent that hit its limit', () => {
    const wrapper = block(taskPart({ output: taskOutput({ status: 'limit', report: 'What I found so far.' }) }) as ToolPartLike, false)
    expect(root(wrapper).attributes('data-state')).toBe('limit')
    expect(trigger(wrapper).text()).toContain('Step limit reached')
    expect(trigger(wrapper).attributes('aria-label')).toContain(', step limit reached, ')
  })

  it('shows "Waiting" while the sub-agent waits for a free slot', () => {
    const wrapper = block(taskPart({ preliminary: true, output: taskOutput({ status: 'queued', steps: [], finishedAt: undefined, report: '' }) }) as ToolPartLike)
    expect(root(wrapper).attributes('data-state')).toBe('queued')
    expect(trigger(wrapper).text()).toContain('Waiting')
  })

  it('lists a denied step as "Skipped" in the expanded steps', async () => {
    const output = taskOutput({ steps: [taskStep(), taskStep({ toolCallId: 'child_call_2', toolName: 'shell', summary: 'pnpm test', state: 'denied' })] })
    const wrapper = block(taskPart({ output }) as ToolPartLike, false)
    await trigger(wrapper).trigger('click')
    const denied = wrapper.findAll(`[data-testid="${testIds.taskStep}"]`)[1]!
    expect(denied.attributes()).toMatchObject({ 'data-tool-name': 'shell', 'data-state': 'denied' })
    expect(denied.text()).toContain('Skipped')
    expect(denied.text()).toContain('Sub-agents can\'t ask for approval, so this was skipped.')
  })

  it('stacks parallel blocks, each with its own state and live line', () => {
    const wrapper = mount({
      render: () => h(TooltipProvider, null, {
        default: () => h('div', [
          h(TaskBlock, { part: taskPart({ toolCallId: 'call_a', preliminary: true, output: runningOutput }) as ToolPartLike, streaming: true }),
          h(TaskBlock, { part: taskPart({ toolCallId: 'call_b', input: taskInput({ description: 'Find the cookie settings' }) }) as ToolPartLike, streaming: true }),
        ]),
      }),
    }, { attachTo: document.body })
    const blocks = wrapper.findAll(`[data-testid="${testIds.taskBlock}"]`)
    expect(blocks.map(item => item.attributes('data-state'))).toEqual(['running', 'completed'])
    expect(blocks.map(item => item.findAll(`[data-testid="${testIds.taskBlockTrigger}"]`).length)).toEqual([1, 1])
    expect(blocks[1]!.text()).toContain('Find the cookie settings')
  })

  it('ticks the duration of a running sub-agent', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_759_000_010_000)
    const output = taskOutput({ status: 'running', finishedAt: undefined, report: '', startedAt: 1_759_000_000_000 })
    const wrapper = block(taskPart({ preliminary: true, output }) as ToolPartLike)
    expect(trigger(wrapper).get('[data-slot="task-meta-short"]').text()).toBe('1 tool call · 10s')
    await vi.advanceTimersByTimeAsync(5000)
    expect(trigger(wrapper).get('[data-slot="task-meta-short"]').text()).toBe('1 tool call · 15s')
    wrapper.unmount()
  })

  it('passes the approval of a task call that asks on, and shows a superseded one as denied', async () => {
    const asking = { type: 'tool-task', toolCallId: 'call_task_1', state: 'approval-requested', input: taskInput(), approval: { id: 'appr_task' } } as ToolPartLike
    const wrapper = block(asking, false)
    expect(root(wrapper).attributes('data-state')).toBe('approval')
    expect(trigger(wrapper).text()).toContain('Needs approval')
    await wrapper.get(`[data-testid="${testIds.toolApprovalAllow}"]`).trigger('click')
    await flushPromises()
    expect(wrapper.getComponent(TaskBlock).emitted('approval')).toEqual([[{ id: 'appr_task', approved: true, toolName: 'task', alwaysAllow: false }]])
    const superseded = block(asking, false, true)
    expect(root(superseded).attributes('data-state')).toBe('denied')
    expect(superseded.find(`[data-testid="${testIds.toolApproval}"]`).exists()).toBe(false)
  })

  it('falls back to the generic tool row when the input or the output does not parse', () => {
    const badOutput = block({ ...taskPart(), output: { status: 'weird' } } as ToolPartLike, false)
    expect(badOutput.find(`[data-testid="${testIds.taskBlockTrigger}"]`).exists()).toBe(false)
    expect(badOutput.get(`[data-testid="${testIds.toolRow}"]`).attributes('data-tool-name')).toBe('task')

    const unparsable = { type: 'tool-task', toolCallId: 'call_x', state: 'output-error', input: { nope: true }, errorText: 'boom' } as ToolPartLike
    const failed = block(unparsable, false)
    expect(root(failed).attributes('data-state')).toBe('failed')
    expect(root(failed).attributes('data-kind')).toBeUndefined()
    expect(failed.get(`[data-testid="${testIds.toolRow}"]`).attributes('data-status')).toBe('error')

    // A streaming input is still partial: the block shows what it has.
    const streaming = block({ type: 'tool-task', toolCallId: 'call_s', state: 'input-streaming', input: { description: 'Fi', type: 'explore' } } as ToolPartLike)
    expect(streaming.find(`[data-testid="${testIds.toolRow}"]`).exists()).toBe(false)
    expect(root(streaming).attributes()).toMatchObject({ 'data-state': 'running', 'data-kind': 'explore' })
    expect(trigger(streaming).text()).toContain('Fi')
  })
})
