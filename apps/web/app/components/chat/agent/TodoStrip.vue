<script setup lang="ts">
// The todo strip in the composer dock (docs/UI.md 2.16, 7.25, 10.6, 14; ADR-041): ChatView mounts it above
// QueuedMessages with the session's `todos`. Renders nothing unless `todoStripVisible(state, running)`. Props and root
// test id frozen from Gate P9-0b (C25).
// Collapsed: one line (h-9, 40px on coarse pointers) that is the toggle: `ListTodo`, "3/7 · Running the parser tests"
// ("All tasks done"), a progress bar (w-16, hidden below `sm`) and a chevron. Expanded: the TodoList above that line,
// inline, at most 40dvh, scrolling; the line then reads "Tasks 3/7". The toggle is named "Show tasks, 3 of 7 done" /
// "Hide tasks" (`aria-expanded`, `aria-controls`); the open state persists in `localStorage['hf-todo-expanded']`
// (`1` / `0`, default closed; blocked storage keeps it in memory). Not a live region; opening keeps focus on the toggle.
// Root `todo-strip` (`data-state` open | closed, `data-count` = total, `data-value` = done).
import type { TodoState } from './todos'
import { ChevronUpIcon, ListTodoIcon } from '@lucide/vue'
import { computed, ref, useId } from 'vue'
import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'
import { testIds } from '~/utils/testids'
import TodoList from './TodoList.vue'
import { todoStripVisible, todoSummary } from './todos'

const props = defineProps<{
  /** The todo state of the shown path (`session.todos`); null = no list. */
  state: TodoState | null
  /** A run of the chat is active. */
  running: boolean
}>()

/** The localStorage key of the open state (docs/UI.md 13.10). */
const STORAGE_KEY = 'hf-todo-expanded'

function readOpen(): boolean {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) === '1'
  }
  catch {
    return false
  }
}

const open = ref(readOpen())
const listId = useId()

function toggle() {
  open.value = !open.value
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, open.value ? '1' : '0')
  }
  catch {
    // Blocked storage: the state stays in memory.
  }
}

const visible = computed(() => todoStripVisible(props.state, props.running))
const label = computed(() => (props.state ? todoSummary(props.state) : ''))
const percent = computed(() => {
  const state = props.state
  return state && state.total > 0 ? Math.round((state.done / state.total) * 100) : 0
})
const toggleLabel = computed(() => {
  if (open.value || !props.state)
    return 'Hide tasks'
  return `Show tasks, ${props.state.done} of ${props.state.total} done`
})
</script>

<template>
  <div
    v-if="visible && state"
    :data-testid="testIds.todoStrip"
    :data-state="open ? 'open' : 'closed'"
    :data-count="state.total"
    :data-value="state.done"
    class="flex min-w-0 flex-col overflow-hidden rounded-lg border bg-card text-card-foreground"
  >
    <div v-if="open" :id="listId" class="max-h-[40dvh] overflow-y-auto overscroll-contain border-b px-3 py-2.5">
      <TodoList :todos="state.todos" variant="strip" />
    </div>
    <button
      type="button"
      :data-testid="testIds.todoStripToggle"
      :aria-expanded="open"
      :aria-controls="open ? listId : undefined"
      :aria-label="toggleLabel"
      class="flex h-9 w-full min-w-0 items-center gap-2 px-3 text-left text-sm outline-none transition-colors duration-(--duration-fast) hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset pointer-coarse:h-10"
      @click="toggle"
    >
      <ListTodoIcon aria-hidden="true" class="size-4 shrink-0 text-muted-foreground" />
      <span class="min-w-0 flex-1 truncate">
        <template v-if="open">Tasks {{ state.done }}/{{ state.total }}</template>
        <template v-else>{{ label }}</template>
      </span>
      <Progress
        data-slot="todo-progress"
        aria-hidden="true"
        :model-value="percent"
        class="hidden w-16 shrink-0 sm:flex"
      />
      <ChevronUpIcon
        aria-hidden="true"
        :class="cn('size-4 shrink-0 text-muted-foreground transition-transform duration-(--duration-base)', open && 'rotate-180')"
      />
    </button>
  </div>
</template>
