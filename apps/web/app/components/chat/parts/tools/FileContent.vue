<script setup lang="ts">
// File content of `read_file` and of `write_file` approval previews (docs/UI.md 2.14, 7.19; ADR-032): numbered lines
// starting at startLine, 20 lines, then Show all; "Showing lines {a}–{b} of {total}" and "Truncated by server" when the
// output says so. Long lines scroll inside the block. Store-free (the share page renders it too).
// Contract (docs/UI.md 10.4): props below, no emits; root file-content (data-path).
import { computed, ref, watch } from 'vue'
import CopyButton from '~/components/common/CopyButton.vue'
import { splitLines } from '~/utils/line-diff'
import { testIds } from '~/utils/testids'

const props = withDefaults(defineProps<{
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

/** Lines shown before "Show all". */
const PREVIEW_LINES = 20

const expanded = ref(false)
watch(() => props.content, () => {
  expanded.value = false
})

const lines = computed(() => splitLines(props.content))
const shown = computed(() => (expanded.value ? lines.value : lines.value.slice(0, PREVIEW_LINES)))
const hiddenLines = computed(() => lines.value.length - shown.value.length)
const endLine = computed(() => props.startLine + lines.value.length - 1)
const numberWidth = computed(() => `${String(Math.max(endLine.value, 1)).length}ch`)

/** "Showing lines a–b of n" when this is not the whole file. */
const range = computed(() => {
  if (lines.value.length === 0)
    return null
  const total = props.totalLines
  const whole = props.startLine === 1 && total !== null && endLine.value >= total && !props.truncated
  if (whole)
    return null
  const of = total === null ? '' : ` of ${total}`
  return `Showing lines ${props.startLine}–${endLine.value}${of}`
})

const SHOW_ALL_CLASS = 'rounded-sm font-medium text-foreground underline decoration-primary/60 underline-offset-2 outline-none hover:decoration-primary focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:min-h-10'
</script>

<template>
  <div
    :data-testid="testIds.fileContent"
    :data-path="path"
    class="flex min-w-0 flex-col overflow-hidden rounded-md border bg-background text-xs"
    :style="{ '--file-number': numberWidth }"
  >
    <div class="flex min-h-8 min-w-0 items-center gap-2 border-b py-0.5 pr-0.5 pl-2.5">
      <span class="min-w-0 truncate font-mono text-foreground" :title="path">{{ path }}</span>
      <CopyButton :text="path" label="Copy path" class="ml-auto pointer-coarse:size-10" />
    </div>
    <div v-if="shown.length > 0" class="overflow-x-auto">
      <div class="w-max min-w-full py-1 font-mono leading-5">
        <div v-for="(line, index) in shown" :key="index" data-slot="file-line" class="flex whitespace-pre">
          <span
            aria-hidden="true"
            class="box-content w-(--file-number) shrink-0 px-2 text-right text-muted-foreground/70 select-none"
          >{{ startLine + index }}</span>
          <span class="pr-4 pl-1 text-foreground">{{ line }}</span>
        </div>
      </div>
    </div>
    <p v-else data-slot="file-empty" class="px-2.5 py-2 text-muted-foreground">
      Empty file.
    </p>
    <p
      v-if="hiddenLines > 0 || range || truncated"
      class="flex flex-wrap items-center gap-x-3 gap-y-1 border-t px-2.5 py-1.5 text-[11px] text-muted-foreground"
    >
      <span v-if="range" data-slot="file-range">{{ range }}</span>
      <button v-if="hiddenLines > 0" type="button" data-action="show-all" :class="SHOW_ALL_CLASS" @click="expanded = true">
        Show all
      </button>
      <span v-if="truncated" data-slot="server-truncated">Truncated by server</span>
    </p>
  </div>
</template>
