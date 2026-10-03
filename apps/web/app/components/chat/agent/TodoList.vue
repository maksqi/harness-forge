<script setup lang="ts">
// The agent's todo list (docs/UI.md 7.25, 10.6; ADR-041): the body of a `todo_write` row, the expanded TodoStrip and
// the share page. Store-free. Props and root test id frozen from Gate P9-0b (C25); W9.10 builds the list (status icons,
// sr-only prefixes "Done:" / "In progress:" / "To do:", the in-progress `activeForm`) behind them.
// Root `todo-list` (`<ul role="list">`); `todo-item` per item (`data-status`, `data-index`).
import type { TodoItem } from '@harness-forge/shared'
import { testIds } from '~/utils/testids'

withDefaults(defineProps<{
  todos: readonly TodoItem[]
  /** `row` = the body of a todo_write row (default); `strip` = inside the dock's TodoStrip. */
  variant?: 'row' | 'strip'
}>(), {
  variant: 'row',
})
</script>

<template>
  <ul role="list" :data-testid="testIds.todoList" :data-variant="variant" class="flex flex-col gap-1 text-sm">
    <li
      v-for="(todo, index) in todos"
      :key="todo.id"
      :data-testid="testIds.todoItem"
      :data-status="todo.status"
      :data-index="index"
    >
      {{ todo.content }}
    </li>
  </ul>
</template>
