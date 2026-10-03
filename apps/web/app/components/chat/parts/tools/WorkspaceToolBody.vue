<script setup lang="ts">
// Expanded body of a workspace tool row (docs/UI.md 2.14, 7.19; ADR-032): DiffView, TerminalOutput, FileContent or
// FileList by view.kind, then the toggle "Raw input and output" (tool-raw-toggle, data-state = open | closed), which
// shows the generic ToolValueBlocks. Replaces the Input / Output blocks of ToolPart (the error block stays).
// Store-free (the share page renders it too).
// Contract (docs/UI.md 10.4): props below, no emits; no root test id of its own.
// Stub (C15, P7-0b): implemented by W7.11 in P7-A; props are frozen. The stub renders the view without the raw
// toggle.
import type { WorkspaceToolView } from './workspace-tools'
import DiffView from './DiffView.vue'
import FileContent from './FileContent.vue'
import FileList from './FileList.vue'
import TerminalOutput from './TerminalOutput.vue'

withDefaults(defineProps<{
  view: WorkspaceToolView
  running?: boolean
}>(), {
  running: false,
})
</script>

<template>
  <div data-slot="workspace-tool-body" :data-kind="view.kind" class="flex flex-col gap-2">
    <DiffView
      v-if="view.kind === 'diff'"
      :hunks="view.hunks"
      :path="view.path"
      :created="view.created"
      :truncated="view.truncated"
    />
    <TerminalOutput
      v-else-if="view.kind === 'terminal'"
      :command="view.command"
      :output="view.output"
      :running="running"
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
    />
  </div>
</template>
