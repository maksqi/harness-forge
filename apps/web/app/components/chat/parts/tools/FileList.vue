<script setup lang="ts">
// File list of `list_directory`, `find_files` and `search_files` (docs/UI.md 2.14, 7.19; ADR-032): up to maxItems
// items (file-list-item, data-path), then "Show {n} more"; folders end with `/`; search matches are grouped by path
// with `line:` prefixes and the matched line in mono; "More results were cut by the server" when truncated. Directory
// entries show their name (data-path keeps the project-relative path). Store-free (the share page renders it too).
// Contract (docs/UI.md 10.4): props below, no emits; root file-list. Additive (not frozen): the slot `empty` replaces
// the text of an empty list (WorkspaceToolBody names the noun).
import type { FileListItem } from './workspace-tools'
import { FileIcon, FolderIcon } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import { testIds } from '~/utils/testids'

const props = withDefaults(defineProps<{
  items: readonly FileListItem[]
  truncated?: boolean
  /** Items shown before "Show {n} more"; default 50. */
  maxItems?: number
}>(), {
  truncated: false,
  maxItems: 50,
})

defineSlots<{ empty?: () => unknown }>()

const expanded = ref(false)
watch(() => props.items, () => {
  expanded.value = false
})

const shown = computed(() => (expanded.value ? props.items : props.items.slice(0, props.maxItems)))
const hiddenItems = computed(() => props.items.length - shown.value.length)

/** Search matches (items with a line) render grouped by path, in the order the paths first appear. */
const groups = computed(() => {
  const byPath = new Map<string, FileListItem[]>()
  for (const item of shown.value) {
    const group = byPath.get(item.path)
    if (group)
      group.push(item)
    else
      byPath.set(item.path, [item])
  }
  return Array.from(byPath, ([path, matches]) => ({ path, matches }))
})
const isSearch = computed(() => props.items.some(item => item.line !== undefined))

function entryName(item: FileListItem): string {
  if (item.type === undefined)
    return item.path
  const name = item.path.split('/').at(-1) || item.path
  return item.type === 'dir' ? `${name}/` : name
}

const SHOW_MORE_CLASS = 'rounded-sm font-medium text-foreground underline decoration-primary/60 underline-offset-2 outline-none hover:decoration-primary focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:min-h-10'
</script>

<template>
  <div :data-testid="testIds.fileList" class="flex min-w-0 flex-col gap-1 font-mono text-xs">
    <p v-if="items.length === 0" data-slot="file-list-empty" class="font-sans text-muted-foreground">
      <slot name="empty">
        No results.
      </slot>
    </p>
    <ul v-else-if="isSearch" class="flex min-w-0 flex-col gap-2">
      <li v-for="group in groups" :key="group.path" data-slot="file-list-group" class="min-w-0">
        <p class="truncate text-foreground" :title="group.path">
          {{ group.path }}
        </p>
        <ul class="mt-0.5 flex min-w-0 flex-col">
          <li
            v-for="(match, index) in group.matches"
            :key="index"
            :data-testid="testIds.fileListItem"
            :data-path="match.path"
            :data-line="match.line"
            class="flex min-w-0 gap-2 pl-3"
          >
            <span class="shrink-0 text-muted-foreground tabular-nums select-none">{{ match.line }}:</span>
            <span class="min-w-0 truncate text-foreground" :title="match.text">{{ match.text }}</span>
          </li>
        </ul>
      </li>
    </ul>
    <ul v-else class="flex min-w-0 flex-col">
      <li
        v-for="item in shown"
        :key="item.path"
        :data-testid="testIds.fileListItem"
        :data-path="item.path"
        :data-type="item.type"
        class="flex min-w-0 items-center gap-1.5"
      >
        <FolderIcon v-if="item.type === 'dir'" aria-hidden="true" class="size-3.5 shrink-0 text-muted-foreground" />
        <FileIcon v-else-if="item.type !== undefined" aria-hidden="true" class="size-3.5 shrink-0 text-muted-foreground" />
        <span class="min-w-0 truncate text-foreground" :title="item.path">{{ entryName(item) }}</span>
      </li>
    </ul>
    <p
      v-if="hiddenItems > 0 || truncated"
      class="flex flex-wrap items-center gap-x-3 gap-y-1 font-sans text-[11px] text-muted-foreground"
    >
      <button v-if="hiddenItems > 0" type="button" data-action="show-all" :class="SHOW_MORE_CLASS" @click="expanded = true">
        Show {{ hiddenItems }} more
      </button>
      <span v-if="truncated" data-slot="server-truncated">More results were cut by the server</span>
    </p>
  </div>
</template>
