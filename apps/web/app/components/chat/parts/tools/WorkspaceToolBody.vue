<script setup lang="ts">
// Expanded body of a workspace tool row (docs/UI.md 2.14, 7.19; ADR-032): DiffView, TerminalOutput, FileContent or
// FileList by view.kind, then the toggle "Raw input and output" (tool-raw-toggle, data-state = open | closed), which
// shows the generic ToolValueBlocks. Replaces the Input / Output blocks of ToolPart and ShareToolRow (their error block
// stays). Store-free (the share page renders it too).
// Contract (docs/UI.md 10.4): props below, no emits; no root test id of its own. Additive (not frozen): the slot `raw`
// holds the generic blocks; the toggle renders only when the caller fills it. Phase 8 (C20): the diff's server totals go
// to DiffView's `stats` prop (they count cut hunks too); W8.10: the terminal view's `cwd` goes to TerminalOutput (the
// folder of a running command; a finished output names its own).
import type { WorkspaceToolView } from './workspace-tools'
import { ChevronRightIcon } from '@lucide/vue'
import { computed, ref, useId } from 'vue'
import { cn } from '@/lib/utils'
import { testIds } from '~/utils/testids'
import DiffView from './DiffView.vue'
import FileContent from './FileContent.vue'
import FileList from './FileList.vue'
import TerminalOutput from './TerminalOutput.vue'

const props = withDefaults(defineProps<{
  view: WorkspaceToolView
  running?: boolean
}>(), {
  running: false,
})

const slots = defineSlots<{ raw?: () => unknown }>()

const rawOpen = ref(false)
const rawId = useId()

const EMPTY_LIST: Record<Extract<WorkspaceToolView, { kind: 'list' }>['noun'], string> = {
  entries: 'The folder is empty.',
  files: 'No files match.',
  matches: 'No matches.',
}
const emptyText = computed(() => (props.view.kind === 'list' ? EMPTY_LIST[props.view.noun] : ''))
</script>

<template>
  <div data-slot="workspace-tool-body" :data-kind="view.kind" class="flex min-w-0 flex-col gap-2">
    <DiffView
      v-if="view.kind === 'diff'"
      :hunks="view.hunks"
      :path="view.path"
      :created="view.created"
      :truncated="view.truncated"
      :stats="{ additions: view.additions, deletions: view.deletions }"
    />
    <TerminalOutput
      v-else-if="view.kind === 'terminal'"
      :command="view.command"
      :output="view.output"
      :running="running"
      :cwd="view.cwd"
    />
    <FileContent
      v-else-if="view.kind === 'file'"
      :path="view.path"
      :content="view.content"
      :start-line="view.startLine"
      :total-lines="view.totalLines"
      :truncated="view.truncated"
    />
    <FileList
      v-else
      :items="view.items"
      :truncated="view.truncated"
    >
      <template #empty>
        {{ emptyText }}
      </template>
    </FileList>

    <template v-if="slots.raw">
      <button
        type="button"
        :data-testid="testIds.toolRawToggle"
        :data-state="rawOpen ? 'open' : 'closed'"
        :aria-expanded="rawOpen"
        :aria-controls="rawOpen ? rawId : undefined"
        class="group/raw flex h-7 items-center gap-1 self-start rounded-sm px-1 -ml-1 font-sans text-[11px] font-medium text-muted-foreground outline-none transition-colors duration-(--duration-fast) hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:h-10"
        @click="rawOpen = !rawOpen"
      >
        Raw input and output
        <ChevronRightIcon
          aria-hidden="true"
          :class="cn('size-3 transition-transform duration-(--duration-base)', rawOpen && 'rotate-90')"
        />
      </button>
      <div v-if="rawOpen" :id="rawId" data-slot="tool-raw" class="flex min-w-0 flex-col gap-3">
        <slot name="raw" />
      </div>
    </template>
  </div>
</template>
