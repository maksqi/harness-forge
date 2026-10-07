import type { BackgroundTask } from '@harness-forge/shared'
import { createServerEvent } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useBackgroundTasksStore } from '~/stores/background-tasks'
import { testIds } from '~/utils/testids'
import { backgroundTask, backgroundTaskId, chatId, taskInput, taskOutput } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { stubLocalStorage } from '~/utils/testing/storage'
import { BACKGROUND_TASK_INPUT } from '../chat-context'
import { announcedTasks, BACKGROUND_STOPPED_LINGER_MS, visibleTasks } from './background-agents'
import BackgroundAgents from './BackgroundAgents.vue'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))
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

/** Every list mounted by a test (unmounted before the body is cleared). */
const mounted: ReturnType<typeof mount>[] = []

function mountList(initial: { tasks: readonly BackgroundTask[], stopping?: readonly string[], reveal?: { taskId: string, n: number } | null }) {
  const props = ref({ stopping: [] as readonly string[], reveal: null as { taskId: string, n: number } | null, ...initial })
  const onStop = vi.fn()
  const onStopAll = vi.fn()
  const wrapper = mount(defineComponent({
    setup: () => () => h(TooltipProvider, null, {
      default: () => h(BackgroundAgents, { ...props.value, onStop, onStopAll }),
    }),
  }), { attachTo: document.body, global: { provide: { [BACKGROUND_TASK_INPUT as symbol]: () => taskInput() } } })
  mounted.push(wrapper)
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
let pinia: ReturnType<typeof createPinia>

beforeEach(() => {
  storage = stubLocalStorage()
  announcedTasks.clear()
  screen(true)
  mock.api = createMockApi()
  pinia = createPinia()
  setActivePinia(pinia)
})

afterEach(() => {
  for (const wrapper of mounted.splice(0))
    wrapper.unmount()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
  disposePinia(pinia)
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

describe('backgroundAgents: a row stopped from the list (Phase 12, W12.13: the mobile dock flake of P12-0a)', () => {
  function delivered(task: BackgroundTask): BackgroundTask {
    return { ...task, deliveredAt: T0 + 61_000, deliveredMessageId: 'msg_reply' }
  }

  /** Puts a snapshot into the store (`task.changed`) and returns what ChatView would pass: the visible tasks. */
  function changed(task: BackgroundTask): readonly BackgroundTask[] {
    const store = useBackgroundTasksStore()
    store.applyEvent(createServerEvent('task.changed', { chatId: task.chatId, task }, 1))
    return visibleTasks(store.tasks(task.chatId))
  }

  function rowOf(wrapper: ReturnType<typeof mount>, task: BackgroundTask) {
    return wrapper.find(`[data-testid="${testIds.backgroundAgent}"][data-task-id="${task.id}"]`)
  }

  it('keeps showing "Stopped" when a running reply takes the report right after the stop answer', async () => {
    vi.useFakeTimers({ now: T0 + 60_000, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    const a = running(1, 'Agent A')
    const { wrapper, set, onStop } = mountList({ tasks: changed(a) })
    const stop = wrapper.get(`[data-testid="${testIds.backgroundAgentStop}"]`)
    focusOn(stop)
    await stop.trigger('click')
    expect(onStop).toHaveBeenCalledWith(a.id)
    // Progress events arrive while the stop is in flight.
    await set({ tasks: changed({ ...a, output: { ...a.output, steps: [] } }), stopping: [a.id] })
    expect(rowOf(wrapper, a).attributes()).toMatchObject({ 'data-state': 'running', 'aria-busy': 'true' })
    // The stop answer (aborted), then at once the delivery at the reply's next step: the row leaves `tasks`.
    await set({ tasks: changed(ended(a, 'aborted')), stopping: [] })
    await set({ tasks: changed(delivered(ended(a, 'aborted'))) })
    expect(rowOf(wrapper, a).exists()).toBe(true)
    expect(rowOf(wrapper, a).attributes('data-state')).toBe('aborted')
    expect(rowOf(wrapper, a).text()).toContain('Stopped')
    expect(rowOf(wrapper, a).find('[data-slot="background-agent-pending"]').exists()).toBe(false)
    expect(find(wrapper, testIds.backgroundAgents).attributes()).toMatchObject({ 'data-count': '0', 'data-total': '1' })
    expect(document.activeElement).toBe(find(wrapper, testIds.backgroundAgentsToggle).element)
    expect(wrapper.get('[data-slot="background-agents-announcer"]').text()).toBe('Background agent stopped: Agent A')

    // It leaves once it ended BACKGROUND_STOPPED_LINGER_MS ago.
    await vi.advanceTimersByTimeAsync(BACKGROUND_STOPPED_LINGER_MS - 1)
    expect(rowOf(wrapper, a).exists()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(find(wrapper, testIds.backgroundAgents).exists()).toBe(false)
  })

  it('lingers from the store snapshot when the end and the delivery arrive together', async () => {
    vi.useFakeTimers({ now: T0 + 60_000, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    const a = running(2, 'Agent A', T0 + 1000)
    const b = running(1, 'Agent B')
    const { wrapper, set } = mountList({ tasks: [...changed(b), ...changed(a)].filter((task, index, all) => all.findIndex(item => item.id === task.id) === index) })
    await wrapper.get(`[data-task-id="${a.id}"] [data-testid="${testIds.backgroundAgentStop}"]`).trigger('click')
    await set({ stopping: [a.id] })
    changed(ended(a, 'aborted'))
    await set({ tasks: changed(delivered(ended(a, 'aborted'))), stopping: [] })
    // Newest first: the lingering row keeps its place above B.
    const ids = wrapper.findAll(`[data-testid="${testIds.backgroundAgent}"]`).map(row => row.attributes('data-task-id'))
    expect(ids).toEqual([a.id, b.id])
    expect(rowOf(wrapper, a).attributes('data-state')).toBe('aborted')
    expect(find(wrapper, testIds.backgroundAgents).attributes()).toMatchObject({ 'data-count': '1', 'data-total': '2' })
    // A collapsed list shows no lingering row.
    await find(wrapper, testIds.backgroundAgentsToggle).trigger('click')
    expect(find(wrapper, testIds.backgroundAgents).attributes('data-total')).toBe('1')
    await vi.advanceTimersByTimeAsync(BACKGROUND_STOPPED_LINGER_MS)
    await find(wrapper, testIds.backgroundAgentsToggle).trigger('click')
    expect(rowOf(wrapper, a).exists()).toBe(false)
    expect(rowOf(wrapper, b).exists()).toBe(true)
  })

  it('a row that ended by itself, or whose stop failed, leaves as soon as its report was delivered', async () => {
    const a = running(2, 'Agent A')
    const b = running(1, 'Agent B')
    changed(b)
    const { wrapper, set } = mountList({ tasks: changed(a).slice() })
    // A finished by itself and was delivered: gone at once.
    await set({ tasks: changed(ended(a)) })
    await set({ tasks: changed(delivered(ended(a))) })
    expect(rowOf(wrapper, a).exists()).toBe(false)
    expect(rowOf(wrapper, b).exists()).toBe(true)

    // B's stop failed (it settled while B still runs); B later finishes and is delivered: gone at once too.
    await wrapper.get(`[data-task-id="${b.id}"] [data-testid="${testIds.backgroundAgentStop}"]`).trigger('click')
    await set({ stopping: [b.id] })
    await set({ stopping: [] })
    expect(rowOf(wrapper, b).attributes('data-state')).toBe('running')
    await set({ tasks: changed(ended(b)) })
    await set({ tasks: changed(delivered(ended(b))) })
    expect(find(wrapper, testIds.backgroundAgents).exists()).toBe(false)
  })

  it('forgets a lingering row once the list shows another chat\'s agents', async () => {
    const a = running(1, 'Agent A')
    const { wrapper, set } = mountList({ tasks: changed(a) })
    await wrapper.get(`[data-testid="${testIds.backgroundAgentStop}"]`).trigger('click')
    await set({ stopping: [a.id] })
    await set({ tasks: changed(ended(a, 'aborted')), stopping: [] })
    await set({ tasks: changed(delivered(ended(a, 'aborted'))) })
    expect(rowOf(wrapper, a).exists()).toBe(true)
    const other = { ...running(2, 'Agent B'), chatId: chatId(2) }
    await set({ tasks: changed(other) })
    expect(rowOf(wrapper, a).exists()).toBe(false)
    expect(rowOf(wrapper, other).exists()).toBe(true)
  })

  it('a stopped row that stays undelivered longer than the linger leaves at its delivery', async () => {
    vi.useFakeTimers({ now: T0 + 60_000, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    const a = running(1, 'Agent A')
    const { wrapper, set } = mountList({ tasks: changed(a) })
    await wrapper.get(`[data-testid="${testIds.backgroundAgentStop}"]`).trigger('click')
    await set({ stopping: [a.id] })
    await set({ tasks: changed(ended(a, 'aborted')), stopping: [] })
    expect(rowOf(wrapper, a).find('[data-slot="background-agent-pending"]').text()).toBe('Report pending')
    await vi.advanceTimersByTimeAsync(BACKGROUND_STOPPED_LINGER_MS + 1000)
    await set({ tasks: changed(delivered(ended(a, 'aborted'))) })
    expect(find(wrapper, testIds.backgroundAgents).exists()).toBe(false)
  })
})
