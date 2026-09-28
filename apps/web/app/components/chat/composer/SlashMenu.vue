<script setup lang="ts">
// Slash menu (docs/UI.md 7.8): a list above the composer while the text starts with `/` and the caret is in the
// first token. Items are filtered by prefix (App commands first, then server Commands with their plugin, muted, on
// the right), at most 8 rows visible. Focus stays in the textarea: the composer forwards its keydown events to
// `handleKeydown` (↑/↓ move, Enter or Tab picks, Esc closes) and points `aria-activedescendant` at `activeId`.
import type { SlashItem } from './slash-commands'
import { computed, nextTick, ref, useId, watch } from 'vue'
import { cn } from '@/lib/utils'
import { testIds } from '~/utils/testids'
import { filterSlashItems } from './slash-commands'

const props = defineProps<{
  open: boolean
  query: string
  items: SlashItem[]
}>()

const emit = defineEmits<{
  select: [item: SlashItem]
  close: []
}>()

const listId = `slash-menu-${useId()}`
const matches = computed(() => filterSlashItems(props.items, props.query))
const visible = computed(() => props.open && matches.value.length > 0)
const active = ref(0)

// A fully typed name wins (`/mode` must not pick `/model`); otherwise the first match.
watch([() => props.query, visible], () => {
  const exact = matches.value.findIndex(item => item.name === props.query.toLowerCase())
  active.value = Math.max(exact, 0)
}, { immediate: true })

interface Row {
  item: SlashItem
  index: number
}

const groups = computed(() => {
  const rows: Row[] = matches.value.map((item, index) => ({ item, index }))
  return [
    { label: 'App', rows: rows.filter(row => row.item.kind === 'client') },
    { label: 'Commands', rows: rows.filter(row => row.item.kind === 'server') },
  ].filter(group => group.rows.length > 0)
})

function optionId(index: number): string {
  return `${listId}-option-${index}`
}

/** Id of the highlighted option (for `aria-activedescendant`), or undefined when the menu is closed. */
const activeId = computed(() => (visible.value && matches.value[active.value] ? optionId(active.value) : undefined))

function move(delta: number) {
  const count = matches.value.length
  active.value = (active.value + delta + count) % count
  void nextTick(() => {
    const element = typeof document === 'undefined' ? null : document.getElementById(optionId(active.value))
    element?.scrollIntoView?.({ block: 'nearest' })
  })
}

function pick(index: number) {
  const item = matches.value[index]
  if (item)
    emit('select', item)
}

/** Handles a keydown of the textarea; true when the menu consumed it. */
function handleKeydown(event: KeyboardEvent): boolean {
  if (!visible.value || event.isComposing)
    return false
  const modified = event.altKey || event.ctrlKey || event.metaKey
  switch (event.key) {
    case 'ArrowDown':
    case 'ArrowUp':
      if (modified || event.shiftKey)
        return false
      event.preventDefault()
      move(event.key === 'ArrowDown' ? 1 : -1)
      return true
    case 'Enter':
    case 'Tab':
      if (modified || event.shiftKey)
        return false
      event.preventDefault()
      pick(active.value)
      return true
    case 'Escape':
      event.preventDefault()
      emit('close')
      return true
    default:
      return false
  }
}

defineExpose({ handleKeydown, activeId, listId })
</script>

<template>
  <div
    v-if="visible"
    :id="listId"
    role="listbox"
    aria-label="Commands"
    :data-testid="testIds.slashMenu"
    class="absolute inset-x-0 bottom-full z-30 mb-2 overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-md animate-in fade-in-0 slide-in-from-bottom-1 duration-(--duration-fast)"
  >
    <div class="max-h-[calc(var(--row-height)*8+3.5rem)] overflow-y-auto overscroll-contain p-1">
      <div v-for="group in groups" :key="group.label" role="group" :aria-label="group.label">
        <div aria-hidden="true" class="px-2 pt-1.5 pb-1 text-xs font-medium text-muted-foreground">
          {{ group.label }}
        </div>
        <div
          v-for="row in group.rows"
          :id="optionId(row.index)"
          :key="`${row.item.kind}:${row.item.name}`"
          role="option"
          :aria-selected="row.index === active"
          :data-testid="testIds.slashMenuItem"
          :data-value="row.item.name"
          :data-kind="row.item.kind"
          :data-highlighted="row.index === active ? '' : undefined"
          :class="cn(
            'flex h-(--row-height) cursor-default items-center gap-3 rounded-md px-2 text-sm select-none',
            'data-highlighted:bg-accent data-highlighted:text-accent-foreground',
          )"
          @mousedown.prevent
          @pointermove="active = row.index"
          @click="pick(row.index)"
        >
          <span class="shrink-0 font-mono text-[13px] font-medium">/{{ row.item.name }}</span>
          <span class="min-w-0 flex-1 truncate text-muted-foreground">{{ row.item.description }}</span>
          <span v-if="row.item.source" class="max-w-[40%] shrink-0 truncate text-xs text-muted-foreground">{{ row.item.source }}</span>
        </div>
      </div>
    </div>
  </div>
</template>
