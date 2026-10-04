<script setup lang="ts">
// The background agents of a chat in the dock, between TodoStrip and QueuedMessages (docs/UI.md 5.8, 7.29, 10.7, 14;
// ADR-046). ChatView mounts it with the session's visible tasks (`visibleTasks`, newest first). Props, emits and the
// root test id are frozen from Gate P10-0b (C33 stub); W10.10 implements the list.
// Renders nothing without visible tasks. A `region` named "Background agents" (`background-agents`, `data-state` open |
// closed, `data-count` = running, `data-total` = visible). Collapsed: one h-9 line (h-10 on coarse pointers) that is the
// toggle (`background-agents-toggle`): a spinner (`CircleCheck` when none runs) and "2 background agents · {latest
// description} · 1m 12s" (ticking) or "1 background agent finished · report pending"; it is named "Show background
// agents, 2 running" / "…, 1 finished" / "Hide background agents" (`aria-expanded`, `aria-controls`). The open state
// persists in `localStorage['hf-background-expanded']` (`1` / `0`; default open from `md`, closed below; blocked
// storage keeps it in memory). Expanded (the list above the toggle line, `max-h-[40dvh]`, scrolls): "Background agents
// · {n} running" with Stop all (`background-agents-stop-all`, while one runs), the rows (BackgroundAgentRow, a list
// named "Background agents") and the footnote. A polite region (`data-slot="background-agents-announcer"`, no
// `role="status"`, rendered even while the list is hidden) says "Background agent finished: {description}" (failed,
// stopped, reached its step limit) once per transition this tab observed, never for states it only loaded, and records
// the task in `announcedTasks` (one announcement per task and tab, ChatView's carrier turns included).
// Focus (docs/UI.md 14.1): opening keeps it on the toggle; after a Stop it moves to the next row's Stop, else the
// previous row's, else the toggle (back to the row's own Stop when the stop failed); Stop all keeps it until it
// disappears, then the toggle. A `reveal` request ("Show in background agents" of a task block) opens the list, expands
// that row, scrolls to it and focuses its details toggle.
import type { BackgroundTask } from '@harness-forge/shared'
import { ChevronUpIcon, CircleCheckIcon, Loader2Icon, SquareIcon } from '@lucide/vue'
import { computed, nextTick, onBeforeUnmount, ref, useId, useTemplateRef, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { testIds } from '~/utils/testids'
import {
  announcedTasks,
  announcementFor,
  BACKGROUND_EXPANDED_KEY,
  BACKGROUND_FOOTNOTE,
  focusAfterStop,
  headerLine,
  isRunningTask,
  summaryLine,
  toggleName,
} from './background-agents'
import BackgroundAgentRow from './BackgroundAgentRow.vue'

const props = withDefaults(defineProps<{
  /** The chat's visible tasks (`visibleTasks`), newest first. */
  tasks: readonly BackgroundTask[]
  /** Task ids with a stop in flight. */
  stopping?: readonly string[]
  /** A "Show in background agents" request (n bumps on each request). */
  reveal?: { taskId: string, n: number } | null
}>(), {
  stopping: () => [],
  reveal: null,
})

const emit = defineEmits<{ 'stop': [taskId: string], 'stop-all': [] }>()

const root = useTemplateRef<HTMLElement>('root')
const toggleButton = useTemplateRef<HTMLButtonElement>('toggleButton')
const listId = useId()

// ---------- open state ----------

/** The list is open by default from `md` (768px) and closed below. */
function wideScreen(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      && window.matchMedia('(min-width: 768px)').matches
  }
  catch {
    return false
  }
}

function readOpen(): boolean {
  try {
    const stored = globalThis.localStorage?.getItem(BACKGROUND_EXPANDED_KEY)
    if (stored === '1' || stored === '0')
      return stored === '1'
  }
  catch {
    // Blocked storage: the default.
  }
  return wideScreen()
}

const open = ref(readOpen())

function setOpen(value: boolean, persist: boolean) {
  open.value = value
  if (!persist)
    return
  try {
    globalThis.localStorage?.setItem(BACKGROUND_EXPANDED_KEY, value ? '1' : '0')
  }
  catch {
    // Blocked storage: the state stays in memory.
  }
}

function onToggle() {
  setOpen(!open.value, true)
}

/** The rows whose details are open. */
const openRows = ref<Record<string, true>>({})

function setRowOpen(taskId: string, value: boolean) {
  if (value) {
    openRows.value = { ...openRows.value, [taskId]: true }
  }
  else if (openRows.value[taskId]) {
    const { [taskId]: _open, ...rest } = openRows.value
    openRows.value = rest
  }
}

// ---------- summary ----------

const running = computed(() => props.tasks.filter(isRunningTask).length)
const stoppingSet = computed(() => new Set(props.stopping))

// The collapsed line's duration ticks once a second while one runs.
const now = ref(Date.now())
let ticker: ReturnType<typeof setInterval> | undefined
function stopTicker() {
  if (ticker !== undefined) {
    clearInterval(ticker)
    ticker = undefined
  }
}
watch(() => running.value > 0, (active) => {
  stopTicker()
  if (!active)
    return
  now.value = Date.now()
  ticker = setInterval(() => {
    now.value = Date.now()
  }, 1000)
}, { immediate: true })
onBeforeUnmount(stopTicker)

const line = computed(() => summaryLine(props.tasks, now.value))
const toggleLabel = computed(() => toggleName(props.tasks, open.value))
const header = computed(() => headerLine(props.tasks))

// ---------- announcements ----------

const announcement = ref('')
let pendingAnnouncements: string[] = []
async function announce(text: string) {
  pendingAnnouncements.push(text)
  if (pendingAnnouncements.length > 1)
    return
  announcement.value = ''
  await nextTick()
  announcement.value = pendingAnnouncements.join('. ')
  pendingAnnouncements = []
}

/** The last snapshot of each listed task this component saw (the states it loaded are only remembered). */
const seen = new Map<string, BackgroundTask>()
watch(() => props.tasks, (next) => {
  const ids = new Set<string>()
  for (const task of next) {
    ids.add(task.id)
    const text = announcementFor(seen.get(task.id) ?? null, task)
    seen.set(task.id, task)
    // Once per tab: never when ChatView already announced its result.
    if (text && announcedTasks.add(task.id))
      void announce(text)
  }
  for (const id of [...seen.keys()]) {
    if (!ids.has(id))
      seen.delete(id)
  }
}, { immediate: true })

// ---------- focus after a stop ----------

function focusIsHere(): boolean {
  if (typeof document === 'undefined')
    return false
  const active = document.activeElement
  return !active || active === document.body || !!root.value?.contains(active)
}

function rowElement(taskId: string): HTMLElement | null {
  return [...(root.value?.querySelectorAll<HTMLElement>(`[data-testid="${testIds.backgroundAgent}"]`) ?? [])]
    .find(element => element.dataset.taskId === taskId) ?? null
}

function stopButtonOf(taskId: string): HTMLElement | null {
  return rowElement(taskId)?.querySelector<HTMLElement>(`[data-testid="${testIds.backgroundAgentStop}"]`) ?? null
}

/** The row whose Stop was pressed, and the row order then: once its stop settled, focus moves on. */
let focusAfter: { taskId: string, order: string[] } | null = null
/** Stop all was pressed: once it disappears, focus goes to the toggle. */
let focusAfterStopAll = false

function onStop(taskId: string) {
  if (stoppingSet.value.has(taskId))
    return
  focusAfter = { taskId, order: props.tasks.map(task => task.id) }
  emit('stop', taskId)
}

function onStopAll() {
  if (props.stopping.length > 0)
    return
  focusAfterStopAll = true
  // eslint-disable-next-line vue/custom-event-name-casing -- contract name from docs/UI.md 10.7
  emit('stop-all')
}

watch([() => props.tasks, () => props.stopping], () => {
  const pending = focusAfter
  if (pending && !stoppingSet.value.has(pending.taskId)) {
    focusAfter = null
    const task = props.tasks.find(item => item.id === pending.taskId)
    if (focusIsHere()) {
      void nextTick(() => {
        // The stop failed: back on the row's own Stop.
        if (task && isRunningTask(task)) {
          stopButtonOf(task.id)?.focus()
          return
        }
        const runningIds = new Set(props.tasks.filter(item => isRunningTask(item) && !stoppingSet.value.has(item.id)).map(item => item.id))
        const target = focusAfterStop(pending.order, pending.taskId, runningIds)
        const button = target ? stopButtonOf(target) : null
        if (button)
          button.focus()
        else
          toggleButton.value?.focus()
      })
    }
  }
  if (focusAfterStopAll && running.value === 0) {
    focusAfterStopAll = false
    if (focusIsHere())
      void nextTick(() => toggleButton.value?.focus())
  }
}, { flush: 'post' })

// ---------- reveal ("Show in background agents") ----------

watch(() => props.reveal?.n, () => {
  const request = props.reveal
  if (!request || !props.tasks.some(task => task.id === request.taskId))
    return
  setOpen(true, false)
  setRowOpen(request.taskId, true)
  void nextTick(() => {
    const row = rowElement(request.taskId)
    row?.scrollIntoView?.({ block: 'nearest' })
    // Its details toggle (a row without the launching call has none: its Stop, else the list's toggle).
    const target = row?.querySelector<HTMLElement>(`[data-testid="${testIds.backgroundAgentToggle}"]`)
      ?? row?.querySelector<HTMLElement>(`[data-testid="${testIds.backgroundAgentStop}"]`)
      ?? toggleButton.value
    target?.focus()
  })
})
</script>

<template>
  <section
    v-if="tasks.length > 0"
    ref="root"
    :data-testid="testIds.backgroundAgents"
    :data-state="open ? 'open' : 'closed'"
    :data-count="running"
    :data-total="tasks.length"
    aria-label="Background agents"
    class="flex min-w-0 flex-col overflow-hidden rounded-lg border bg-card text-card-foreground"
  >
    <div v-if="open" :id="listId" class="max-h-[40dvh] overflow-y-auto overscroll-contain border-b px-3 py-2">
      <div class="flex min-h-8 min-w-0 items-center justify-between gap-2">
        <p class="min-w-0 truncate text-xs font-medium text-muted-foreground">
          {{ header }}
        </p>
        <Button
          v-if="running > 0"
          type="button"
          variant="outline"
          size="sm"
          :data-testid="testIds.backgroundAgentsStopAll"
          :aria-disabled="stopping.length > 0 || undefined"
          class="shrink-0 aria-disabled:opacity-50 pointer-coarse:h-10"
          @click="onStopAll"
        >
          <SquareIcon aria-hidden="true" class="size-3.5" />
          Stop all
        </Button>
      </div>
      <ul role="list" aria-label="Background agents" class="flex min-w-0 flex-col">
        <BackgroundAgentRow
          v-for="task in tasks"
          :key="task.id"
          :task="task"
          :stopping="stoppingSet.has(task.id)"
          :open="openRows[task.id] === true"
          @update:open="setRowOpen(task.id, $event)"
          @stop="onStop(task.id)"
        />
      </ul>
      <p data-slot="background-agents-footnote" class="pt-1 text-xs text-muted-foreground">
        {{ BACKGROUND_FOOTNOTE }}
      </p>
    </div>
    <button
      ref="toggleButton"
      type="button"
      :data-testid="testIds.backgroundAgentsToggle"
      :aria-expanded="open"
      :aria-controls="open ? listId : undefined"
      :aria-label="toggleLabel"
      class="flex h-9 w-full min-w-0 items-center gap-2 px-3 text-left text-sm outline-none transition-colors duration-(--duration-fast) hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset pointer-coarse:h-10"
      @click="onToggle"
    >
      <Loader2Icon v-if="running > 0" aria-hidden="true" class="size-4 shrink-0 animate-spin text-muted-foreground" />
      <CircleCheckIcon v-else aria-hidden="true" class="size-4 shrink-0 text-muted-foreground" />
      <span class="min-w-0 flex-1 truncate">{{ open ? 'Hide background agents' : line }}</span>
      <ChevronUpIcon
        aria-hidden="true"
        :class="cn('size-4 shrink-0 text-muted-foreground transition-transform duration-(--duration-base)', open && 'rotate-180')"
      />
    </button>
  </section>
  <div data-slot="background-agents-announcer" class="sr-only" aria-live="polite" aria-atomic="true">
    {{ announcement }}
  </div>
</template>
