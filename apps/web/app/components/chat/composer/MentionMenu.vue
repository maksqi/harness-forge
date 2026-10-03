<script setup lang="ts">
// The `@` file menu of a project chat (docs/UI.md 2.16, 7.26, 10.6; ADR-042): mounted by ChatComposer after SlashMenu,
// with the state of `useFileMentions`. The SlashMenu contract: a listbox above the composer while `open`; the textarea
// keeps focus and forwards its keydown events to `handleKeydown` (true = consumed: ↑/↓ move, Enter or Tab pick, Esc
// closes) and points `aria-activedescendant` at `activeId`. Props, emits, exposes and root test id frozen from Gate
// P9-0b (C25); W9.8 builds the menu (rows with highlights, the states, the footer) behind them.
// Root `mention-menu` (`data-state` loading | ready | error, `data-count`; `role="listbox"`, `aria-busy` while loading);
// `mention-menu-item` per entry (`data-path`, `data-kind`).
// P9-0b stub: renders the empty listbox while open and consumes no key.
import type { ProjectFileEntry } from '@harness-forge/shared'
import { computed, useId } from 'vue'
import { testIds } from '~/utils/testids'

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

// The stub never picks or closes by itself (W9.8 emits them).
defineEmits<{
  select: [entry: ProjectFileEntry]
  close: []
}>()

const listId = `mention-menu-${useId()}`
/** Id of the highlighted row (for `aria-activedescendant`), or undefined when the menu is closed. */
const activeId = computed<string | undefined>(() => undefined)
const label = computed(() => (props.projectName ? `Files in ${props.projectName}` : 'Files'))

/** Handles a keydown of the textarea; true when the menu consumed it. P9-0b stub: never. */
function handleKeydown(_event: KeyboardEvent): boolean {
  return false
}

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
    class="absolute inset-x-0 bottom-full z-30 mb-2 overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-md"
  />
</template>
