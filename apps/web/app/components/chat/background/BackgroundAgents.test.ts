import type { BackgroundTask } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { testIds } from '~/utils/testids'
import { backgroundTask, backgroundTaskId, taskInput, taskOutput } from '~/utils/testing/fixtures'
import { stubLocalStorage } from '~/utils/testing/storage'
import { BACKGROUND_TASK_INPUT } from '../chat-context'
import { announcedTasks } from './background-agents'
import BackgroundAgents from './BackgroundAgents.vue'

vi.mock('~/components/chat/nuxt-imports', () => ({ useColorMode: () => ({ value: 'dark' }) }))

const T0 = 1_759_000_000_000

function running(n: number, description: string, createdAt = T0): BackgroundTask {
  return backgroundTask({ id: backgroundTaskId(n), status: 'running', finishedAt: null, createdAt, output: taskOutput({ status: 'running', description, startedAt: createdAt, finishedAt: undefined }) })
}

function ended(task: BackgroundTask, status: 'completed' | 'failed' | 'aborted' | 'limit' = 'completed'): BackgroundTask {
  return { ...task, status, finishedAt: T0 + 60_000, output: { ...task.output, status, finishedAt: T0 + 60_000 } }
}

/** A narrow or wide screen for the default open state (`min-width: 768px`). */
function screen(wide: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: wide && query.includes('min-width'), media: query, addEventListener() {}, removeEventListener() {} }))
}

function mountList(initial: { tasks: readonly BackgroundTask[], stopping?: readonly string[], reveal?: { taskId: string, n: number } | null }) {
  const props = ref({ stopping: [] as readonly string[], reveal: null as { taskId: string, n: number } | null, ...initial })
  const onStop = vi.fn()
  const onStopAll = vi.fn()
  const wrapper = mount(defineComponent({
    setup: () => () => h(TooltipProvider, null, {
      default: () => h(BackgroundAgents, { ...props.value, onStop, onStopAll }),
    }),
  }), { attachTo: document.body, global: { provide: { [BACKGROUND_TASK_INPUT as symbol]: () => taskInput() } } })
  const set = async (next: Partial<typeof props.value>) => {
    props.value = { ...props.value, ...next }
    await flushPromises()
    await nextTick()
  }
  return { wrapper, set, onStop, onStopAll }
}

function find(wrapper: ReturnType<typeof mount>, id: string) {
  return wrapper.find(`[data-testid="${id}"]`)
}

function focusOn(node: { element: Element }) {
  (node.element as HTMLElement).focus()
}

let storage: Storage

beforeEach(() => {
  storage = stubLocalStorage()
  announcedTasks.clear()
  screen(true)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

describe('backgroundAgents', () => {
  it('renders nothing without tasks but keeps its announcer', () => {
    const { wrapper } = mountList({ tasks: [] })
    expect(find(wrapper, testIds.backgroundAgents).exists()).toBe(false)
    expect(wrapper.find('[data-slot="background-agents-announcer"]').attributes()).toMatchObject({ 'aria-live': 'polite' })
    expect(wrapper.find('[data-slot="background-agents-announcer"]').attributes('role')).toBeUndefined()
  })

  it('is collapsed by default below md: the summary line is the toggle, its duration ticks', async () => {
    screen(false)
    vi.useFakeTimers({ now: T0 + 72_000 })
    const tasks = [running(2, 'Review the diff', T0 + 30_000), running(1, 'Find flaky tests'), backgroundTask({ id: backgroundTaskId(3) })]
    const { wrapper } = mountList({ tasks })
    const root = find(wrapper, testIds.backgroundAgents)
    expect(root.attributes()).toMatchObject({ 'data-state': 'closed', 'data-count': '2', 'data-total': '3', 'aria-label': 'Background agents' })
    expect(root.element.tagName).toBe('SECTION')
    const toggle = find(wrapper, testIds.backgroundAgentsToggle)
    expect(toggle.attributes()).toMatchObject({ 'aria-expanded': 'false', 'aria-label': 'Show background agents, 2 running' })
    expect(toggle.attributes('aria-controls')).toBeUndefined()
    expect(toggle.text()).toBe('2 background agents · Review the diff · 1m 12s')
    expect(find(wrapper, testIds.backgroundAgent).exists()).toBe(false)
    vi.advanceTimersByTime(3000)
    await nextTick()
    expect(toggle.text()).toBe('2 background agents · Review the diff · 1m 15s')
  })

  it('names the toggle by the finished agents when none runs', () => {
    screen(false)
    const { wrapper } = mountList({ tasks: [backgroundTask()] })
    const toggle = find(wrapper, testIds.backgroundAgentsToggle)
    expect(toggle.attributes('aria-label')).toBe('Show background agents, 1 finished')
    expect(toggle.text()).toBe('1 background agent finished · report pending')
  })

  it('is open by default from md: the header, Stop all, the rows and the footnote; the toggle persists the state', async () => {
    const tasks = [running(2, 'Review the diff'), backgroundTask()]
    const { wrapper, onStopAll } = mountList({ tasks })
    const root = find(wrapper, testIds.backgroundAgents)
    expect(root.attributes('data-state')).toBe('open')
    expect(root.text()).toContain('Background agents · 1 running')
    expect(wrapper.get('ul[aria-label="Background agents"]').findAll(`[data-testid="${testIds.backgroundAgent}"]`)).toHaveLength(2)
    expect(wrapper.get('[data-slot="background-agents-footnote"]').text()).toBe('They keep running after the reply. Stop in the composer doesn\'t stop them.')
    const toggle = find(wrapper, testIds.backgroundAgentsToggle)
    expect(toggle.attributes()).toMatchObject({ 'aria-expanded': 'true', 'aria-label': 'Hide background agents' })
    expect(wrapper.get(`#${toggle.attributes('aria-controls')}`).text()).toContain('Review the diff')
    await find(wrapper, testIds.backgroundAgentsStopAll).trigger('click')
    expect(onStopAll).toHaveBeenCalledOnce()
    await toggle.trigger('click')
    expect(root.attributes('data-state')).toBe('closed')
    expect(storage.getItem('hf-background-expanded')).toBe('0')
    await toggle.trigger('click')
    expect(storage.getItem('hf-background-expanded')).toBe('1')
  })

  it('reads the stored open state, and keeps it in memory when storage is blocked', async () => {
    storage.setItem('hf-background-expanded', '0')
    expect(find(mountList({ tasks: [running(1, 'Find flaky tests')] }).wrapper, testIds.backgroundAgents).attributes('data-state')).toBe('closed')
    const blocked = () => {
      throw new Error('blocked')
    }
    vi.stubGlobal('localStorage', { getItem: blocked, setItem: blocked })
    const { wrapper } = mountList({ tasks: [running(1, 'Find flaky tests')] })
    expect(find(wrapper, testIds.backgroundAgents).attributes('data-state')).toBe('open')
    await find(wrapper, testIds.backgroundAgentsToggle).trigger('click')
    expect(find(wrapper, testIds.backgroundAgents).attributes('data-state')).toBe('closed')
  })

  it('hides Stop all once none runs', () => {
    const { wrapper } = mountList({ tasks: [backgroundTask()] })
    expect(find(wrapper, testIds.backgroundAgentsStopAll).exists()).toBe(false)
    expect(find(wrapper, testIds.backgroundAgents).text()).toContain('Background agents')
  })

  it('announces each transition it observed, never a state it only loaded', async () => {
    const live = running(1, 'Find flaky tests')
    const other = running(2, 'Review the diff')
    const { wrapper, set } = mountList({ tasks: [live, ended(running(3, 'Loaded already'))] })
    const announcer = wrapper.get('[data-slot="background-agents-announcer"]')
    expect(announcer.text()).toBe('')
    await set({ tasks: [other, live] })
    expect(announcer.text()).toBe('')
    await set({ tasks: [ended(other, 'failed'), ended(live)] })
    expect(announcer.text()).toBe('Background agent failed: Review the diff. Background agent finished: Find flaky tests')
    await set({ tasks: [ended(other, 'failed'), ended(live)] })
    expect(announcer.text()).toBe('Background agent failed: Review the diff. Background agent finished: Find flaky tests')
    const third = running(4, 'Lint the repo')
    await set({ tasks: [third] })
    await set({ tasks: [ended(third, 'limit')] })
    expect(announcer.text()).toBe('Background agent reached its step limit: Lint the repo')
  })

  it('emits stop for a row, then moves focus to the next row\'s Stop, else the previous one, else the toggle', async () => {
    const a = running(3, 'Agent A')
    const b = running(2, 'Agent B')
    const c = running(1, 'Agent C')
    const { wrapper, set, onStop } = mountList({ tasks: [a, b, c] })
    const stopOf = (task: BackgroundTask) => wrapper.get(`[data-task-id="${task.id}"] [data-testid="${testIds.backgroundAgentStop}"]`)

    focusOn(stopOf(b))
    await stopOf(b).trigger('click')
    expect(onStop).toHaveBeenCalledWith(b.id)
    await set({ stopping: [b.id] })
    await set({ tasks: [a, ended(b, 'aborted'), c], stopping: [] })
    expect(document.activeElement).toBe(stopOf(c).element)

    await stopOf(c).trigger('click')
    await set({ stopping: [c.id] })
    await set({ tasks: [a, ended(b, 'aborted'), ended(c, 'aborted')], stopping: [] })
    expect(document.activeElement).toBe(stopOf(a).element)

    await stopOf(a).trigger('click')
    await set({ stopping: [a.id] })
    await set({ tasks: [ended(a, 'aborted'), ended(b, 'aborted'), ended(c, 'aborted')], stopping: [] })
    expect(document.activeElement).toBe(find(wrapper, testIds.backgroundAgentsToggle).element)
  })

  it('puts focus back on the row\'s Stop when the stop failed', async () => {
    const a = running(1, 'Agent A')
    const { wrapper, set } = mountList({ tasks: [a] })
    const stop = () => wrapper.get(`[data-testid="${testIds.backgroundAgentStop}"]`)
    focusOn(stop())
    await stop().trigger('click')
    await set({ stopping: [a.id] })
    expect(document.activeElement).toBe(document.body)
    await set({ stopping: [] })
    expect(document.activeElement).toBe(stop().element)
  })

  it('stop all keeps focus until it disappears, then the toggle', async () => {
    const a = running(2, 'Agent A')
    const b = running(1, 'Agent B')
    const { wrapper, set, onStopAll } = mountList({ tasks: [a, b] })
    const stopAll = find(wrapper, testIds.backgroundAgentsStopAll)
    focusOn(stopAll)
    await stopAll.trigger('click')
    expect(onStopAll).toHaveBeenCalledOnce()
    await set({ stopping: [a.id] })
    expect(find(wrapper, testIds.backgroundAgentsStopAll).attributes('aria-disabled')).toBe('true')
    await find(wrapper, testIds.backgroundAgentsStopAll).trigger('click')
    expect(onStopAll).toHaveBeenCalledOnce()
    await set({ tasks: [ended(a, 'aborted'), b], stopping: [b.id] })
    expect(document.activeElement).toBe(find(wrapper, testIds.backgroundAgentsStopAll).element)
    await set({ tasks: [ended(a, 'aborted'), ended(b, 'aborted')], stopping: [] })
    expect(find(wrapper, testIds.backgroundAgentsStopAll).exists()).toBe(false)
    expect(document.activeElement).toBe(find(wrapper, testIds.backgroundAgentsToggle).element)
  })

  it('a reveal request opens the list, expands the row and focuses its details toggle', async () => {
    screen(false)
    const a = running(2, 'Agent A')
    const b = running(1, 'Agent B')
    const { wrapper, set } = mountList({ tasks: [a, b] })
    expect(find(wrapper, testIds.backgroundAgents).attributes('data-state')).toBe('closed')
    await set({ reveal: { taskId: b.id, n: 1 } })
    expect(find(wrapper, testIds.backgroundAgents).attributes('data-state')).toBe('open')
    const toggle = wrapper.get(`[data-task-id="${b.id}"] [data-testid="${testIds.backgroundAgentToggle}"]`)
    expect(toggle.attributes('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(toggle.element)
    expect(wrapper.get(`[data-task-id="${a.id}"] [data-testid="${testIds.backgroundAgentToggle}"]`).attributes('aria-expanded')).toBe('false')
    // Not persisted, and an unknown task does nothing.
    expect(storage.getItem('hf-background-expanded')).toBeNull()
    await find(wrapper, testIds.backgroundAgentsToggle).trigger('click')
    await set({ reveal: { taskId: backgroundTaskId(9), n: 2 } })
    expect(find(wrapper, testIds.backgroundAgents).attributes('data-state')).toBe('closed')
  })

  it('records what it announced and stays silent for an agent ChatView already announced in this tab', async () => {
    const a = running(1, 'Agent A')
    const b = running(2, 'Agent B')
    const { wrapper, set } = mountList({ tasks: [b, a] })
    // ChatView announced B's result first (a carrier turn).
    announcedTasks.add(b.id)
    await set({ tasks: [ended(b), ended(a)] })
    expect(wrapper.get('[data-slot="background-agents-announcer"]').text()).toBe('Background agent finished: Agent A')
    expect(announcedTasks.has(a.id)).toBe(true)
  })
})
