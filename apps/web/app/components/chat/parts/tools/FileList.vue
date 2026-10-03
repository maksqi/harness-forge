<script setup lang="ts">
// File list of `list_directory`, `find_files` and `search_files` (docs/UI.md 2.14, 7.19; ADR-032): up to maxItems
// items (file-list-item, data-path), then "Show {n} more"; folders end with `/`; search matches are grouped by path
// with `line:` prefixes and the matched line in mono; "More results were cut by the server" when truncated.
// Store-free (the share page renders it too).
// Contract (docs/UI.md 10.4): props below, no emits; root file-list.
// Stub (C15, P7-0b): implemented by W7.11 in P7-A; props are frozen. The stub renders its root only.
import type { FileListItem } from './workspace-tools'
import { testIds } from '~/utils/testids'

withDefaults(defineProps<{
  items: readonly FileListItem[]
  truncated?: boolean
  /** Items shown before "Show {n} more"; default 50. */
  maxItems?: number
}>(), {
  truncated: false,
  maxItems: 50,
})
</script>

<template>
  <div :data-testid="testIds.fileList" class="flex flex-col font-mono text-xs" />
</template>
