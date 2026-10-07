<script setup lang="ts">
// Slash menu (docs/UI.md 7.8): a list above the composer while the text starts with `/` and the caret is in the
// first token. Items are filtered by name prefix, at most 8 rows visible (40dvh at most on small screens). Focus stays
// in the textarea: the composer forwards its keydown events to `handleKeydown` (↑/↓ move, Enter or Tab picks, Esc
// closes) and points `aria-activedescendant` at `activeId`.
// Phase 10 (ADR-045; W10.9): four groups in this order, each a `role="group"` labelled by its heading (`data-group`;
// a heading shows only when its group has a match, and is never focusable): App (the client commands, `/remember`
// included, and the harness `/compact`), Project, Personal, Plugins. A row (`slash-menu-item`, `data-value`,
// `data-kind`, `data-group`) shows the mono `/name`, the argument hint (muted mono, hidden below `sm`), the description
// and, muted on the right, the namespace or the plugin name; its accessible name is "/{name}, {description}" plus
// ", arguments {hint}".
// Phase 11 (ADR-049, ADR-052; W11.10): a fifth group Skills (`data-group="skill"`, last) whose rows show the source and
// `BookOpen` on the right; a project command whose `!` lines wait for approval shows a muted `ShieldQuestionMark` "Needs
// approval" on the right (`data-trust="pending"`, named ", needs approval"); picking it still inserts it.
// Phase 12 (ADR-053; docs/UI.md 7.34; W12.13): qualified names of Claude Code plugin commands and skills
// (`data-value="review-kit:db:migrate"`): typing filters on every segment, the row shows the plugin namespace muted
// (`data-slot="slash-menu-namespace"`) and cuts a name over 40 characters in the middle, the full name in its title.
import type { SlashGroup, SlashItem } from './slash-commands'
import { BookOpenIcon, ShieldQuestionMarkIcon } from '@lucide/vue'
import { computed, nextTick, ref, useId, watch } from 'vue'
import { cn } from '@/lib/utils'
import { testIds } from '~/utils/testids'
import { filterSlashItems, SLASH_GROUPS, slashItemDetail, slashItemLabel, slashNameDisplay } from './slash-commands'

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
  /** + Phase 12: the name as the row shows it (the muted namespace, the rest, the title of a qualified or cut name). */
  shown: ReturnType<typeof slashNameDisplay>
}

interface Group {
  value: SlashGroup
  label: string
  rows: Row[]
}

// `matches` is already in group order, so the option indexes run top to bottom.
const groups = computed<Group[]>(() => {
  const rows: Row[] = matches.value.map((item, index) => ({ item, index, shown: slashNameDisplay(item.name) }))
  return SLASH_GROUPS
    .map(group => ({ ...group, rows: rows.filter(row => row.item.group === group.value) }))
    .filter(group => group.rows.length > 0)
})

function optionId(index: number): string {
  return `${listId}-option-${index}`
}

function headingId(group: SlashGroup): string {
  return `${listId}-group-${group}`
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
    <div class="max-h-[min(calc(var(--row-height)*8+3.5rem),40dvh)] overflow-y-auto overscroll-contain p-1">
      <div v-for="group in groups" :key="group.value" role="group" :aria-labelledby="headingId(group.value)">
        <div
          :id="headingId(group.value)"
          aria-hidden="true"
          :data-group="group.value"
          class="px-2 pt-1.5 pb-1 text-xs font-medium text-muted-foreground"
        >
          {{ group.label }}
        </div>
        <div
          v-for="row in group.rows"
          :id="optionId(row.index)"
          :key="`${row.item.kind}:${row.item.name}`"
          role="option"
          :aria-selected="row.index === active"
          :aria-label="slashItemLabel(row.item)"
          :data-testid="testIds.slashMenuItem"
          :data-value="row.item.name"
          :data-kind="row.item.kind"
          :data-group="row.item.group"
          :data-trust="row.item.pending ? 'pending' : undefined"
          :data-highlighted="row.index === active ? '' : undefined"
          :class="cn(
            'flex h-(--row-height) cursor-default items-center gap-3 rounded-md px-2 text-sm select-none',
            'data-highlighted:bg-accent data-highlighted:text-accent-foreground',
          )"
          @mousedown.prevent
          @pointermove="active = row.index"
          @click="pick(row.index)"
        >
          <span
            data-slot="slash-menu-name"
            :title="row.shown.title ?? undefined"
            class="max-w-[60%] shrink-0 truncate font-mono text-[13px] font-medium"
          >/<span v-if="row.shown.namespace" data-slot="slash-menu-namespace" class="font-normal text-muted-foreground">{{ row.shown.namespace }}</span>{{ row.shown.rest }}</span>
          <span
            v-if="row.item.argumentHint"
            data-slot="slash-menu-hint"
            class="hidden max-w-[30%] shrink-0 truncate font-mono text-xs text-muted-foreground sm:inline"
          >{{ row.item.argumentHint }}</span>
          <span class="min-w-0 flex-1 truncate text-muted-foreground">{{ row.item.description }}</span>
          <span
            v-if="slashItemDetail(row.item)"
            data-slot="slash-menu-detail"
            class="max-w-[40%] shrink-0 truncate text-xs text-muted-foreground"
          >{{ slashItemDetail(row.item) }}</span>
          <BookOpenIcon v-if="row.item.group === 'skill'" aria-hidden="true" class="size-3.5 shrink-0 text-muted-foreground" />
          <span
            v-if="row.item.pending"
            data-slot="slash-menu-trust"
            class="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
          >
            <ShieldQuestionMarkIcon aria-hidden="true" class="size-3.5" />
            Needs approval
          </span>
        </div>
      </div>
    </div>
  </div>
</template>
