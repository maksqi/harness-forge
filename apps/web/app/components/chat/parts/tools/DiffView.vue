<script setup lang="ts">
// Diff of a workspace write or edit (docs/UI.md 2.14, 7.19; ADR-032): a header with the path in mono, a "New file"
// badge, `+a −d` and a CopyButton for the path; the lines are a grid (old line number | new line number | sign | text)
// in font-mono text-xs whitespace-pre inside an overflow-x-auto block (diff-line, data-kind = add | del | context);
// runs of more than 8 unchanged lines fold, past maxLines "Show {n} more lines" (diff-expand, data-action = unfold |
// show-all); truncated -> "Diff truncated by server". Store-free (the share page renders it too).
// Contract (docs/UI.md 10.4): props below, no emits; root diff-view (data-path, data-state = created | modified;
// role="region" aria-label "Changes to {path}").
// Stub (C15, P7-0b): implemented by W7.11 in P7-A; props are frozen. The stub renders its root only.
import type { DiffHunk } from '@harness-forge/shared'
import { testIds } from '~/utils/testids'

withDefaults(defineProps<{
  /** The server's hunks (workspaceDiffSchema) or utils/line-diff.ts output. */
  hunks: readonly DiffHunk[]
  /** Project-relative path shown in the header. */
  path?: string | null
  /** A new file ("New file" badge). */
  created?: boolean
  /** "Diff truncated by server". */
  truncated?: boolean
  /** Lines shown before "Show {n} more lines"; default 200. */
  maxLines?: number
}>(), {
  path: null,
  created: false,
  truncated: false,
  maxLines: 200,
})
</script>

<template>
  <div
    :data-testid="testIds.diffView"
    :data-path="path ?? ''"
    :data-state="created ? 'created' : 'modified'"
    role="region"
    :aria-label="path ? `Changes to ${path}` : 'Changes'"
    class="overflow-x-auto rounded-md border font-mono text-xs"
  />
</template>
