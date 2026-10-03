<script setup lang="ts">
// The `@` file menu of a project chat (docs/UI.md 2.16, 7.26, 10.6, 14; ADR-042): mounted by ChatComposer after
// SlashMenu, with the state of `useFileMentions`. The SlashMenu contract: a listbox above the composer while `open`; the
// textarea keeps focus and forwards its keydown events to `handleKeydown` (true = consumed: ↑/↓ move, Enter or Tab
// pick, Esc closes) and points `aria-activedescendant` at `activeId`. Props, emits, exposes and root test id frozen
// from Gate P9-0b (C25); built by W9.8.
// Rows: `FileText` (file) or `Folder` (dir), the base name and its folder in muted text (under the name on phones), the
// characters `scorePath` matched as `<mark data-slot="mention-highlight">` runs (no raw HTML rendering). States: "Searching
// files…" (only after 150 ms of loading without rows; the previous rows stay meanwhile), "No matching files", the error
// line, and the footer "Showing the first 50 matches. Type more to narrow it down." when the index was cut. A polite
// region announces "{n} files" / "No matching files" 500 ms after the rows settle.
// Root `mention-menu` (`data-state` loading | ready | error, `data-count`; `role="listbox"`, `aria-busy` while loading);
// `mention-menu-item` per entry (`data-path`, `data-kind`).
import type { ProjectFileEntry } from '@harness-forge/shared'
import { FileTextIcon, FolderIcon, Loader2Icon } from '@lucide/vue'
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'
import { cn } from '@/lib/utils'
import { testIds } from '~/utils/testids'
import { mentionCountLabel, mentionRowLabel } from './mention-menu'

const props = withDefaults(defineProps<{
  open: boolean
  /** What was typed after the `@`. */
  query: string
  /** The ranked matches of the project's files (`GET /projects/:id/files`). */
  items: readonly ProjectFileEntry[]
  state: 'loading' | 'ready' | 'error'
  /** The error line of the `error` state ("Couldn't search files."). */
  errorMessage?: string | null
  /** The project's index was cut: "Showing the first 50 matches. Type more to narrow it down." */
  truncated: boolean
  /** The project's name ("Files in {project}"). */
  projectName: string | null
}>(), {
  errorMessage: null,
})

const emit = defineEmits<{
  select: [entry: ProjectFileEntry]
  close: []
}>()

/** "Searching files…" shows only when a search takes longer than this. */
const SEARCHING_DELAY_MS = 150
/** The polite count waits for the rows to settle. */
const ANNOUNCE_DELAY_MS = 500
const DEFAULT_ERROR = 'Couldn\'t search files.'

const listId = `mention-menu-${useId()}`
const label = computed(() => (props.projectName ? `Files in ${props.projectName}` : 'Files'))
const active = ref(0)

const rows = computed(() => props.items.map((entry, index) => ({ entry, index, label: mentionRowLabel(entry, props.query) })))

// New results (or a reopened menu) start at the best match.
watch([() => props.items, () => props.open], () => {
  active.value = 0
})

function optionId(index: number): string {
  return `${listId}-option-${index}`
}

/** Id of the highlighted row (for `aria-activedescendant`), or undefined when the menu is closed. */
const activeId = computed<string | undefined>(() => (props.open && props.items[active.value] ? optionId(active.value) : undefined))

function move(delta: number) {
  const count = props.items.length
  active.value = (active.value + delta + count) % count
  void nextTick(() => {
    const element = typeof document === 'undefined' ? null : document.getElementById(optionId(active.value))
    element?.scrollIntoView?.({ block: 'nearest' })
  })
}

function pick(index: number) {
  const entry = props.items[index]
  if (entry)
    emit('select', entry)
}

/** Handles a keydown of the textarea; true when the menu consumed it. */
function handleKeydown(event: KeyboardEvent): boolean {
  if (!props.open || event.isComposing)
    return false
  const modified = event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
  switch (event.key) {
    case 'ArrowDown':
    case 'ArrowUp':
      if (modified || props.items.length === 0)
        return false
      event.preventDefault()
      move(event.key === 'ArrowDown' ? 1 : -1)
      return true
    case 'Enter':
    case 'Tab':
      // Without rows, Enter sends and Tab moves the focus as usual.
      if (modified || props.items.length === 0)
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

// ---------- "Searching files…" and the polite count ----------

const searching = ref(false)
let searchingTimer: ReturnType<typeof setTimeout> | undefined
watch(() => props.open && props.state === 'loading', (loading) => {
  clearTimeout(searchingTimer)
  searching.value = false
  if (loading) {
    searchingTimer = setTimeout(() => {
      searching.value = true
    }, SEARCHING_DELAY_MS)
  }
}, { immediate: true })

const announcement = ref('')
let announceTimer: ReturnType<typeof setTimeout> | undefined
watch(
  () => [props.open, props.state, props.items.length, props.errorMessage] as const,
  ([open, state, count, errorMessage]) => {
    clearTimeout(announceTimer)
    if (!open) {
      announcement.value = ''
      return
    }
    if (state === 'loading')
      return
    announceTimer = setTimeout(() => {
      announcement.value = state === 'error' ? errorMessage ?? DEFAULT_ERROR : mentionCountLabel(count)
    }, ANNOUNCE_DELAY_MS)
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  clearTimeout(searchingTimer)
  clearTimeout(announceTimer)
})

defineExpose({ handleKeydown, activeId, listId })
</script>

<template>
  <div
    v-if="open"
    :id="listId"
    role="listbox"
    :aria-label="label"
    :aria-busy="state === 'loading' || undefined"
    :data-testid="testIds.mentionMenu"
    :data-state="state"
    :data-count="items.length"
    class="absolute inset-x-0 bottom-full z-30 mb-2 overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-md animate-in fade-in-0 slide-in-from-bottom-1 duration-(--duration-fast)"
  >
    <div aria-hidden="true" class="truncate px-3 pt-2 pb-1 text-xs font-medium text-muted-foreground">
      {{ label }}
    </div>
    <div class="max-h-[40dvh] overflow-y-auto overscroll-contain p-1">
      <div
        v-for="row in rows"
        :id="optionId(row.index)"
        :key="`${row.entry.kind}:${row.entry.path}`"
        role="option"
        :aria-selected="row.index === active"
        :data-testid="testIds.mentionMenuItem"
        :data-path="row.entry.path"
        :data-kind="row.entry.kind"
        :data-highlighted="row.index === active ? '' : undefined"
        :class="cn(
          'flex min-h-(--row-height) cursor-default items-center gap-2.5 rounded-md px-2 py-1 text-sm select-none pointer-coarse:min-h-10',
          'data-highlighted:bg-accent data-highlighted:text-accent-foreground',
        )"
        @mousedown.prevent
        @pointermove="active = row.index"
        @click="pick(row.index)"
      >
        <FolderIcon v-if="row.entry.kind === 'dir'" aria-hidden="true" class="size-4 shrink-0 text-muted-foreground" />
        <FileTextIcon v-else aria-hidden="true" class="size-4 shrink-0 text-muted-foreground" />
        <span class="flex min-w-0 flex-1 items-baseline gap-3 max-sm:flex-col max-sm:items-start max-sm:gap-0">
          <span class="max-w-full min-w-0 shrink-0 truncate">
            <template v-for="(run, runIndex) in row.label.name" :key="runIndex">
              <mark v-if="run.match" data-slot="mention-highlight" class="rounded-[2px] bg-primary/20 text-inherit">{{ run.text }}</mark>
              <template v-else>{{ run.text }}</template>
            </template>
          </span>
          <template v-if="row.label.folder.length > 0">
            <!-- A blank between the name and the folder for the option's accessible name (ignored by the flex layout). -->
            {{ ' ' }}<span class="max-w-full min-w-0 truncate text-xs text-muted-foreground">
              <template v-for="(run, runIndex) in row.label.folder" :key="runIndex">
                <mark v-if="run.match" data-slot="mention-highlight" class="rounded-[2px] bg-primary/20 text-inherit">{{ run.text }}</mark>
                <template v-else>{{ run.text }}</template>
              </template>
            </span>
          </template>
        </span>
      </div>
      <div
        v-if="items.length === 0 && (state !== 'loading' || searching)"
        aria-hidden="true"
        data-slot="mention-status"
        :class="cn('flex min-h-(--row-height) items-center gap-2 px-2 text-sm text-muted-foreground', state === 'error' && 'text-destructive')"
      >
        <template v-if="state === 'loading'">
          <Loader2Icon aria-hidden="true" class="size-4 animate-spin" />
          Searching files…
        </template>
        <template v-else-if="state === 'error'">
          {{ errorMessage ?? DEFAULT_ERROR }}
        </template>
        <template v-else>
          No matching files
        </template>
      </div>
    </div>
    <div v-if="truncated" aria-hidden="true" data-slot="mention-truncated" class="border-t px-3 py-1.5 text-xs text-muted-foreground">
      Showing the first 50 matches. Type more to narrow it down.
    </div>
  </div>
  <p class="sr-only" aria-live="polite" aria-atomic="true" data-slot="mention-announcer">
    {{ announcement }}
  </p>
</template>
