<script setup lang="ts">
// Diff of a workspace write or edit (docs/UI.md 2.14, 7.19; ADR-032): a header with the path in mono, a "New file"
// badge, `+a −d` and a CopyButton for the path; the lines are a grid (old line number | new line number | sign | text)
// in font-mono text-xs whitespace-pre inside an overflow-x-auto block (diff-line, data-kind = add | del | context), so a
// long line scrolls inside the block and never widens the page; runs of more than 8 unchanged lines fold, past maxLines
// "Show {n} more lines" (diff-expand, data-action = unfold | show-all); truncated -> "Diff truncated by server"; no
// hunks + truncated (a `null` server diff) -> "The diff is too large to show." Below `sm` one line-number column. Each
// changed line has an sr-only "Added" / "Removed" label. Store-free (the share page renders it too).
// Contract (docs/UI.md 10.4, 10.5): props below, no emits, no slots; root diff-view (data-path, data-state = created |
// modified, data-numbers = on | off; role="region" aria-label "Changes to {path}"). Phase 8 (C20): the header totals
// come from the `stats` prop (WorkspaceToolBody and the changes panel pass the server's totals, which count cut hunks
// too; null / absent = counted from the hunks), shown when additions + deletions > 0, aria-hidden with the sr-only
// diffStatsLabel text; `lineNumbers: false` hides the line numbers and hunk headers (approval previews diff a snippet,
// whose line numbers are not the file's). The `stats` slot and the `data-numbers` fallthrough attribute of v1.3 are gone.
import type { DiffHunk } from '@harness-forge/shared'
import { computed, ref, watch } from 'vue'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import CopyButton from '~/components/common/CopyButton.vue'
import { testIds } from '~/utils/testids'
import { countDiffLines, diffStatsLabel, MINUS_SIGN } from './workspace-tools'

const props = withDefaults(defineProps<{
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
  /**
   * + Phase 8: the header's `+a −d` (the server's totals, which count cut hunks too); null / absent = counted from the
   * hunks.
   */
  stats?: { additions: number, deletions: number } | null
  /** + Phase 8: false = no line numbers and no hunk headers (approval previews); default true. */
  lineNumbers?: boolean
}>(), {
  path: null,
  created: false,
  truncated: false,
  maxLines: 200,
  stats: null,
  lineNumbers: true,
})

/** Runs of more unchanged lines than this fold; FOLD_KEEP lines stay next to each change. */
const FOLD_MIN = 8
const FOLD_KEEP = 3

type LineKind = 'add' | 'del' | 'context'
interface DiffLineRow { type: 'line', key: string, kind: LineKind, old: number | null, new: number | null, text: string }
type DiffRow
  = | { type: 'hunk', key: string, text: string }
    | DiffLineRow
    | { type: 'note', key: string, text: string }
    | { type: 'fold', key: string, count: number }

const numbers = computed(() => props.lineNumbers)

const unfolded = ref<string[]>([])
const showAll = ref(false)
watch(() => props.hunks, () => {
  unfolded.value = []
  showAll.value = false
})

/** The header totals: the `stats` prop, else counted from the hunks. */
const totals = computed(() => props.stats ?? countDiffLines(props.hunks))
const showTotals = computed(() => totals.value.additions + totals.value.deletions > 0)

/** Every row of every hunk, numbered, before folding. */
const hunkRows = computed(() => props.hunks.map((hunk, h) => {
  let oldNo = hunk.oldStart
  let newNo = hunk.newStart
  const lines: Array<DiffLineRow | { type: 'note', key: string, text: string }> = hunk.lines.map((raw, l) => {
    const key = `${h}-${l}`
    const sign = raw.charAt(0)
    const text = raw.slice(1)
    if (sign === '+')
      return { type: 'line', key, kind: 'add', old: null, new: newNo++, text }
    if (sign === '-')
      return { type: 'line', key, kind: 'del', old: oldNo++, new: null, text }
    if (sign === '\\')
      return { type: 'note', key, text: raw.slice(1).trim() }
    return { type: 'line', key, kind: 'context', old: oldNo++, new: newNo++, text: sign === ' ' ? text : raw }
  })
  return {
    key: `${h}`,
    header: `@@ ${MINUS_SIGN}${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    lines,
  }
}))

const isContext = (row: { type: string, kind?: LineKind }) => row.type === 'line' && row.kind === 'context'

/** Rows with long unchanged runs folded (unless unfolded), hunk headers between hunks. */
const foldedRows = computed<DiffRow[]>(() => {
  const rows: DiffRow[] = []
  for (const hunk of hunkRows.value) {
    if (numbers.value)
      rows.push({ type: 'hunk', key: `h${hunk.key}`, text: hunk.header })
    else if (hunk.key !== '0')
      rows.push({ type: 'hunk', key: `h${hunk.key}`, text: '⋯' })
    const lines = hunk.lines
    let index = 0
    while (index < lines.length) {
      if (!isContext(lines[index]!)) {
        rows.push(lines[index]!)
        index++
        continue
      }
      let end = index
      while (end < lines.length && isContext(lines[end]!))
        end++
      const run = lines.slice(index, end)
      const foldKey = `f${hunk.key}-${index}`
      if (run.length > FOLD_MIN && !unfolded.value.includes(foldKey)) {
        const keepStart = index > 0 ? FOLD_KEEP : 0
        const keepEnd = end < lines.length ? FOLD_KEEP : 0
        rows.push(...run.slice(0, keepStart))
        rows.push({ type: 'fold', key: foldKey, count: run.length - keepStart - keepEnd })
        rows.push(...run.slice(run.length - keepEnd))
      }
      else {
        rows.push(...run)
      }
      index = end
    }
  }
  return rows
})

const lineTotal = computed(() => foldedRows.value.filter(row => row.type === 'line').length)
const hiddenLines = computed(() => (showAll.value ? 0 : Math.max(0, lineTotal.value - props.maxLines)))

/** The rows shown: everything up to the maxLines-th line until "Show {n} more lines". */
const rows = computed<DiffRow[]>(() => {
  if (hiddenLines.value === 0)
    return foldedRows.value
  const shown: DiffRow[] = []
  let lines = 0
  for (const row of foldedRows.value) {
    if (row.type === 'line') {
      if (lines >= props.maxLines)
        break
      lines++
    }
    shown.push(row)
  }
  return shown
})

/** Width of a line-number column: the digits of the largest number. */
const numberWidth = computed(() => {
  let max = 1
  for (const hunk of props.hunks)
    max = Math.max(max, hunk.oldStart + hunk.oldLines, hunk.newStart + hunk.newLines)
  return `${String(max).length}ch`
})

const emptyText = computed(() => {
  if (props.truncated)
    return 'The diff is too large to show.'
  return props.created ? 'Empty file.' : 'No changes.'
})

const LINE_CLASS: Record<LineKind, string> = {
  add: 'bg-success/10 text-foreground',
  del: 'bg-destructive/10 text-foreground',
  context: 'text-muted-foreground',
}
const SIGN: Record<LineKind, { text: string, class: string, label: string | null }> = {
  add: { text: '+', class: 'text-success', label: 'Added' },
  del: { text: MINUS_SIGN, class: 'text-destructive', label: 'Removed' },
  context: { text: ' ', class: '', label: null },
}
const NUMBER_CLASS = 'box-content w-(--diff-number) shrink-0 px-2 text-right text-muted-foreground/70 select-none'
const EXPAND_CLASS = 'rounded-sm font-sans font-medium text-foreground underline decoration-primary/60 underline-offset-2 outline-none hover:decoration-primary focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:min-h-10'

function unfold(key: string) {
  unfolded.value = [...unfolded.value, key]
}
</script>

<template>
  <div
    :data-testid="testIds.diffView"
    :data-path="path ?? ''"
    :data-state="created ? 'created' : 'modified'"
    :data-numbers="numbers ? 'on' : 'off'"
    role="region"
    :aria-label="path ? `Changes to ${path}` : 'Changes'"
    class="flex min-w-0 flex-col overflow-hidden rounded-md border bg-background text-xs"
    :style="{ '--diff-number': numberWidth }"
  >
    <div class="flex min-h-8 min-w-0 items-center gap-2 border-b py-0.5 pr-0.5 pl-2.5">
      <span v-if="path" class="min-w-0 truncate font-mono text-foreground" :title="path">{{ path }}</span>
      <Badge v-if="created" variant="secondary" class="h-4 px-1.5 text-[10px]">
        New file
      </Badge>
      <span class="ml-auto flex shrink-0 items-center gap-1.5 font-mono tabular-nums">
        <template v-if="showTotals">
          <span aria-hidden="true" data-slot="diff-stats" class="flex items-center gap-1.5">
            <span class="text-success">+{{ totals.additions }}</span>
            <span class="text-destructive">{{ MINUS_SIGN }}{{ totals.deletions }}</span>
          </span>
          <span class="sr-only">{{ diffStatsLabel(totals.additions, totals.deletions) }}</span>
        </template>
      </span>
      <CopyButton v-if="path" :text="path" label="Copy path" class="pointer-coarse:size-10" />
    </div>

    <div v-if="rows.length > 0" class="overflow-x-auto">
      <div class="w-max min-w-full py-1 font-mono leading-5">
        <template v-for="row in rows" :key="row.key">
          <pre
            v-if="row.type === 'hunk'"
            data-slot="diff-hunk"
            class="bg-muted/60 px-2 font-mono text-muted-foreground select-none"
          >{{ row.text }}</pre>
          <div
            v-else-if="row.type === 'line'"
            :data-testid="testIds.diffLine"
            :data-kind="row.kind"
            :class="cn('flex whitespace-pre', LINE_CLASS[row.kind])"
          >
            <template v-if="numbers">
              <span aria-hidden="true" :class="cn(NUMBER_CLASS, 'hidden sm:block')">{{ row.old ?? '' }}</span>
              <span aria-hidden="true" :class="NUMBER_CLASS">
                <span class="sm:hidden">{{ row.new ?? row.old ?? '' }}</span>
                <span class="hidden sm:inline">{{ row.new ?? '' }}</span>
              </span>
            </template>
            <span aria-hidden="true" :class="cn('w-4 shrink-0 text-center select-none', !numbers && 'ml-1', SIGN[row.kind].class)">{{ SIGN[row.kind].text }}</span>
            <span v-if="SIGN[row.kind].label" class="sr-only">{{ SIGN[row.kind].label }}: </span>
            <span class="pr-4">{{ row.text }}</span>
          </div>
          <pre
            v-else-if="row.type === 'note'"
            data-slot="diff-note"
            class="px-2 font-sans text-muted-foreground italic select-none"
          >{{ row.text }}</pre>
          <div v-else class="px-2 py-0.5">
            <button
              type="button"
              :data-testid="testIds.diffExpand"
              data-action="unfold"
              :class="EXPAND_CLASS"
              @click="unfold(row.key)"
            >
              ⋯ {{ row.count }} unchanged {{ row.count === 1 ? 'line' : 'lines' }}
            </button>
          </div>
        </template>
      </div>
    </div>
    <p v-else data-slot="diff-empty" class="px-2.5 py-2 text-muted-foreground">
      {{ emptyText }}
    </p>

    <p
      v-if="hiddenLines > 0 || (truncated && rows.length > 0)"
      class="flex flex-wrap items-center gap-x-3 gap-y-1 border-t px-2.5 py-1.5 text-[11px] text-muted-foreground"
    >
      <button
        v-if="hiddenLines > 0"
        type="button"
        :data-testid="testIds.diffExpand"
        data-action="show-all"
        :class="EXPAND_CLASS"
        @click="showAll = true"
      >
        Show {{ hiddenLines }} more {{ hiddenLines === 1 ? 'line' : 'lines' }}
      </button>
      <span v-if="truncated && rows.length > 0" data-slot="server-truncated">Diff truncated by server</span>
    </p>
  </div>
</template>
