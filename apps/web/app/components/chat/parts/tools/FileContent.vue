<script setup lang="ts">
// File content of `read_file` and of `write_file` approval previews (docs/UI.md 2.14, 7.19; ADR-032): numbered lines
// starting at startLine, 20 lines, then Show all; "Showing lines {a}–{b} of {total}" and "Truncated by server" when the
// output says so. Store-free (the share page renders it too).
// Contract (docs/UI.md 10.4): props below, no emits; root file-content (data-path).
// Stub (C15, P7-0b): implemented by W7.11 in P7-A; props are frozen. The stub renders its root only.
import { testIds } from '~/utils/testids'

withDefaults(defineProps<{
  /** Project-relative path. */
  path: string
  content: string
  /** 1-based number of the first line; default 1. */
  startLine?: number
  /** Lines of the whole file; null when unknown. */
  totalLines?: number | null
  truncated?: boolean
}>(), {
  startLine: 1,
  totalLines: null,
  truncated: false,
})
</script>

<template>
  <div
    :data-testid="testIds.fileContent"
    :data-path="path"
    class="overflow-x-auto rounded-md border font-mono text-xs"
  />
</template>
