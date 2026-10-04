import type { BackgroundTask, TaskResultData } from '@harness-forge/shared'
import type { AgentTaskContext } from '../chat-context'
import type { ToolPartLike } from '../chat-format'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, provide, ref } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { usePluginsStore } from '~/stores/plugins'
import { testIds } from '~/utils/testids'
import {
  backgroundLaunchOutput,
  backgroundTask,
  backgroundTaskId,
  pluginSummary,
  taskInput,
  taskOutput,
  taskPart,
  taskResultData,
  taskStep,
} from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { AGENT_TASK_CONTEXT } from '../chat-context'
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

describe('taskBlock: custom agent types (Phase 10)', () => {
  const reviewer = () => taskPart({
    input: taskInput({ type: 'reviewer', description: 'Review the auth diff' }),
    output: taskOutput({ type: 'reviewer', description: 'Review the auth diff', agent: { source: 'project', description: 'Reviews diffs for bugs.', path: '.harness/agents/reviewer.md' } }),
  }) as ToolPartLike

  it('shows a custom type with its icon and name, data-kind custom and data-agent-type', () => {
    const wrapper = block(reviewer(), false)
    expect(root(wrapper).attributes()).toMatchObject({ 'data-kind': 'custom', 'data-agent-type': 'reviewer', 'data-state': 'completed' })
    expect(root(wrapper).attributes('data-background')).toBeUndefined()
    expect(trigger(wrapper).get('[data-slot="task-agent-label"]').text()).toBe('reviewer')
    expect(trigger(wrapper).find('.lucide-bot-message-square-icon, .lucide-bot-message-square').exists()).toBe(true)
    expect(trigger(wrapper).attributes('aria-label')).toBe('Sub-agent reviewer: Review the auth diff, completed, 1 tool call')
    expect(wrapper.find('[data-slot="tool-part"]').exists()).toBe(false)
  })

  it('describes the agent snapshot to screen readers and opens the agent card on hover', async () => {
    vi.useFakeTimers()
    const wrapper = block(reviewer(), false)
    const describedBy = trigger(wrapper).attributes('aria-describedby')!
    expect(document.getElementById(describedBy)!.textContent).toBe('Reviews diffs for bugs.. Project: .harness/agents/reviewer.md')
    await trigger(wrapper).get('[data-slot="task-agent-label"]').trigger('pointerenter', { pointerType: 'mouse' })
    await vi.advanceTimersByTimeAsync(500)
    await flushPromises()
    const card = document.querySelector('[data-slot="task-agent-card"]')!
    expect(card.textContent).toContain('Reviews diffs for bugs.')
    expect(card.querySelector('[data-slot="task-agent-source"]')!.textContent!.replace(/\s+/g, ' ').trim()).toBe('Project: .harness/agents/reviewer.md')
    wrapper.unmount()
  })

  it('names the plugin of a plugin agent: its pluginId by name, else the id, else the contributing plugin', () => {
    const plugins = usePluginsStore()
    plugins.items = [
      pluginSummary({ id: 'db-tools', name: 'DB tools' }),
      pluginSummary({ id: 'legacy-pack', name: 'Legacy pack', contributions: { ...pluginSummary().contributions, agents: ['old-agent'] } }),
    ]
    const description = (type: string, agent: { source: 'plugin', description: string, pluginId?: string }) => {
      const wrapper = block(taskPart({ input: taskInput({ type }), output: taskOutput({ type, agent }) }) as ToolPartLike, false)
      const text = document.getElementById(trigger(wrapper).attributes('aria-describedby')!)!.textContent
      wrapper.unmount()
      return text
    }
    expect(description('sql-expert', { source: 'plugin', description: 'Plans SQL migrations.', pluginId: 'db-tools' }))
      .toBe('Plans SQL migrations.. From DB tools')
    expect(description('sql-expert', { source: 'plugin', description: 'Plans SQL migrations.', pluginId: 'gone-plugin' }))
      .toBe('Plans SQL migrations.. From gone-plugin')
    expect(description('old-agent', { source: 'plugin', description: 'Old.' })).toBe('Old.. From Legacy pack')
    expect(description('unknown-agent', { source: 'plugin', description: 'Odd.' })).toBe('Odd.. From a plugin')
  })

  it('cuts a long name at 24 characters, with the full name in a tooltip (no agent snapshot)', () => {
    const name = 'a-very-long-custom-agent-name-indeed'
    const wrapper = block(taskPart({ input: taskInput({ type: name }), output: taskOutput({ type: name }) }) as ToolPartLike, false)
    expect(trigger(wrapper).get('[data-slot="task-agent-label"]').text()).toBe(`${name.slice(0, 23)}…`)
    expect(trigger(wrapper).attributes('aria-describedby')).toBeUndefined()
    expect(trigger(wrapper).attributes('aria-label')).toContain(`Sub-agent ${name}: `)
  })

  it('reads the general-purpose alias as general', () => {
    const wrapper = block(taskPart({ input: taskInput({ type: 'general-purpose' }), output: taskOutput({ type: 'general' }) }) as ToolPartLike, false)
    expect(root(wrapper).attributes()).toMatchObject({ 'data-kind': 'general', 'data-agent-type': 'general' })
    expect(trigger(wrapper).get('[data-slot="task-agent-label"]').text()).toBe('Agent')
    const streaming = block({ type: 'tool-task', toolCallId: 'call_s', state: 'input-streaming', input: { description: 'Draft', type: 'general-purpose' } } as ToolPartLike)
    expect(root(streaming).attributes('data-agent-type')).toBe('general')
  })
})

describe('taskBlock: background calls (Phase 10)', () => {
  const taskId = backgroundTaskId(1)
  const launch = (overrides: Parameters<typeof backgroundLaunchOutput>[0] = {}) => taskPart({
    input: taskInput({ type: 'general', description: 'Find flaky tests', background: true }),
    output: backgroundLaunchOutput({ type: 'general', description: 'Find flaky tests', startedAt: 1_759_000_000_000, ...overrides }),
  }) as ToolPartLike

  interface Live { task: BackgroundTask | null, result: TaskResultData | null }

  function withContext(part: ToolPartLike, initial: Live) {
    const live = ref<Live>(initial)
    const calls = { reveal: [] as string[], showResult: [] as string[] }
    const context: AgentTaskContext = {
      projectId: () => null,
      task: id => (live.value.task?.id === id ? live.value.task : null),
      tasksLoaded: () => true,
      result: id => (live.value.result?.taskId === id ? live.value.result : null),
      reveal: (id) => {
        calls.reveal.push(id)
      },
      showResult: (id) => {
        calls.showResult.push(id)
        return true
      },
    }
    const Host = defineComponent({
      setup() {
        provide(AGENT_TASK_CONTEXT, context)
        return () => h(TaskBlock, { part, streaming: false })
      },
    })
    const wrapper = mount({ render: () => h(TooltipProvider, null, { default: () => h(Host) }) }, { attachTo: document.body })
    return { wrapper, live, calls }
  }

  it('shows the live state of a running background agent: "In background", its meta and its latest step', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_759_000_062_000)
    const task = backgroundTask({
      status: 'running',
      finishedAt: null,
      output: taskOutput({ status: 'running', type: 'general', description: 'Find flaky tests', taskId, finishedAt: undefined, report: '', startedAt: 1_759_000_000_000, steps: [taskStep({ toolName: 'shell', summary: 'pnpm vitest --run', state: 'running' })], stepsOmitted: 7 }),
    })
    const { wrapper, calls } = withContext(launch(), { task, result: null })
    expect(root(wrapper).attributes()).toMatchObject({ 'data-state': 'running', 'data-background': 'true', 'data-kind': 'general' })
    expect(trigger(wrapper).text()).toContain('In background')
    expect(trigger(wrapper).find('[role="status"]').exists()).toBe(true)
    expect(trigger(wrapper).get('[data-slot="task-meta-short"]').text()).toBe('Background · 8 tool calls · 1m 2s')
    expect(trigger(wrapper).attributes('aria-label')).toBe('Sub-agent: Find flaky tests, running, 8 tool calls, running in the background')
    expect(live(wrapper).text()).toBe('└ shell "pnpm vitest --run"')
    await vi.advanceTimersByTimeAsync(2000)
    expect(trigger(wrapper).get('[data-slot="task-meta-short"]').text()).toBe('Background · 8 tool calls · 1m 4s')

    // Expanded: TaskBody with the live snapshot, then "Show in background agents".
    await trigger(wrapper).trigger('click')
    expect(wrapper.findAll(`[data-testid="${testIds.taskStep}"]`)).toHaveLength(1)
    const reveal = wrapper.get(`[data-testid="${testIds.taskBlockReveal}"]`)
    expect(reveal.attributes('data-target')).toBe('dock')
    expect(reveal.text()).toBe('Show in background agents')
    await reveal.trigger('click')
    expect(calls.reveal).toEqual([taskId])
    wrapper.unmount()
  })

  it('follows the task to its final status, then offers "Go to the result" once delivered', async () => {
    const running = backgroundTask({ status: 'running', finishedAt: null, output: taskOutput({ status: 'running', taskId, finishedAt: undefined, report: '' }) })
    const { wrapper, live: state, calls } = withContext(launch(), { task: running, result: null })
    expect(root(wrapper).attributes('data-state')).toBe('running')
    const done = backgroundTask({ output: taskOutput({ taskId, report: 'Two tests depend on wall-clock time. Details below.' }) })
    state.value = { task: done, result: null }
    await flushPromises()
    expect(root(wrapper).attributes('data-state')).toBe('completed')
    expect(trigger(wrapper).find('.text-success').exists()).toBe(true)
    expect(trigger(wrapper).text()).not.toContain('In background')
    expect(trigger(wrapper).get('[data-slot="task-meta-short"]').text()).toBe('Background · 1 tool call · 41s')
    expect(live(wrapper).text()).toBe('Two tests depend on wall-clock time.')
    await trigger(wrapper).trigger('click')
    // Finished but not delivered yet: no link.
    expect(wrapper.find(`[data-testid="${testIds.taskBlockReveal}"]`).exists()).toBe(false)
    state.value = { task: done, result: taskResultData({ output: done.output }) }
    await flushPromises()
    const reveal = wrapper.get(`[data-testid="${testIds.taskBlockReveal}"]`)
    expect(reveal.attributes('data-target')).toBe('result')
    expect(reveal.text()).toBe('Go to the result')
    await reveal.trigger('click')
    expect(calls.showResult).toEqual([taskId])
  })

  it('reads a delivered result when the task list no longer has the task, and a restart as stopped', () => {
    const result = taskResultData({ output: taskOutput({ taskId, status: 'failed', report: '', error: 'The model is not available.' }) })
    const delivered = withContext(launch(), { task: null, result })
    expect(root(delivered.wrapper).attributes('data-state')).toBe('failed')
    expect(live(delivered.wrapper).text()).toBe('The model is not available.')

    const restarted = backgroundTask({ status: 'aborted', output: taskOutput({ taskId, status: 'aborted', report: '', error: 'The server restarted before the task finished.' }) })
    const stopped = withContext(launch(), { task: restarted, result: null })
    expect(root(stopped.wrapper).attributes('data-state')).toBe('aborted')
    expect(trigger(stopped.wrapper).text()).toContain('Stopped')
    expect(live(stopped.wrapper).text()).toBe('The server restarted before the task finished.')
  })

  it('shows "Started in the background" when nothing is known, and stays static without a chat context', async () => {
    const unknown = withContext(launch(), { task: null, result: null })
    expect(root(unknown.wrapper).attributes()).toMatchObject({ 'data-state': 'background', 'data-background': 'true' })
    expect(trigger(unknown.wrapper).text()).toContain('Started in the background')
    expect(trigger(unknown.wrapper).find('[data-slot="task-meta-short"]').exists()).toBe(false)
    expect(live(unknown.wrapper).text()).toBe('')
    expect(trigger(unknown.wrapper).attributes('aria-label')).toBe('Sub-agent: Find flaky tests, started in the background, 0 tool calls')
    await trigger(unknown.wrapper).trigger('click')
    expect(unknown.wrapper.find(`[data-testid="${testIds.taskBlockReveal}"]`).exists()).toBe(false)

    const bare = block(launch(), false)
    expect(root(bare).attributes()).toMatchObject({ 'data-state': 'background', 'data-background': 'true' })
  })

  it('marks a background call that is still starting, and one the server refused', () => {
    const starting = block({ type: 'tool-task', toolCallId: 'call_b', state: 'input-available', input: taskInput({ background: true }) } as ToolPartLike)
    expect(root(starting).attributes()).toMatchObject({ 'data-state': 'running', 'data-background': 'true' })
    const refused = block(taskPart({ input: taskInput({ background: true }), output: taskOutput({ status: 'failed', report: '', error: 'At most 3 background agents can run in a chat at a time.' }) }) as ToolPartLike, false)
    expect(root(refused).attributes()).toMatchObject({ 'data-state': 'failed', 'data-background': 'true' })
    expect(live(refused).text()).toBe('At most 3 background agents can run in a chat at a time.')
  })
})
