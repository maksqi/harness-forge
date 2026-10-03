<script setup lang="ts">
// The agent's todo list (docs/UI.md 7.25, 10.6; ADR-041): the body of a `todo_write` row, the expanded TodoStrip and
// the share page. Store-free. Props and root test id frozen from Gate P9-0b (C25).
// Pending: `Circle`, muted; in progress: `CircleDot` in primary, `font-medium`, the `activeForm` (else the content);
// completed: `CircleCheck` in success, muted with a line-through. Screen readers hear the prefixes "To do:", "In
// progress:" and "Done:" (the icons are hidden).
// Root `todo-list` (`<ul role="list">`); `todo-item` per item (`data-status`, `data-index`).
import type { TodoItem, TodoStatus } from '@harness-forge/shared'
import type { Component } from 'vue'
import { CircleCheckIcon, CircleDotIcon, CircleIcon } from '@lucide/vue'
import { cn } from '@/lib/utils'
import { testIds } from '~/utils/testids'
import { todoLabel } from './agent-tools'

withDefaults(defineProps<{
  todos: readonly TodoItem[]
  /** `row` = the body of a todo_write row (default); `strip` = inside the dock's TodoStrip. */
  variant?: 'row' | 'strip'
}>(), {
  variant: 'row',
})

const STATUS: Record<TodoStatus, { icon: Component, iconClass: string, textClass: string, prefix: string }> = {
  pending: { icon: CircleIcon, iconClass: 'text-muted-foreground', textClass: 'text-foreground', prefix: 'To do:' },
  in_progress: { icon: CircleDotIcon, iconClass: 'text-primary', textClass: 'font-medium text-foreground', prefix: 'In progress:' },
  completed: { icon: CircleCheckIcon, iconClass: 'text-success', textClass: 'text-muted-foreground line-through', prefix: 'Done:' },
}
</script>

<template>
  <ul
    role="list"
    :data-testid="testIds.todoList"
    :data-variant="variant"
    :class="cn('flex min-w-0 flex-col', variant === 'strip' ? 'gap-1.5 text-sm' : 'gap-1 text-[13px]')"
  >
    <li
      v-for="(todo, index) in todos"
      :key="todo.id"
      :data-testid="testIds.todoItem"
      :data-status="todo.status"
      :data-index="index"
      class="flex min-w-0 items-start gap-2"
    >
      <component
        :is="STATUS[todo.status].icon"
        aria-hidden="true"
        :class="cn('mt-[0.2em] size-3.5 shrink-0', STATUS[todo.status].iconClass)"
      />
      <span :class="cn('min-w-0 break-words', STATUS[todo.status].textClass)">
        <span class="sr-only">{{ `${STATUS[todo.status].prefix} ` }}</span>{{ todoLabel(todo) }}
      </span>
    </li>
  </ul>
</template>
