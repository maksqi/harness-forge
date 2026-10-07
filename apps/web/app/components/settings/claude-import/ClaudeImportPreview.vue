<script setup lang="ts">
// Step 2 of the import (Phase 12, ADR-055; docs/UI.md 2.19, 9.14, 10.9): `claude-import-preview` (`data-count` = the
// plan's items), "Found {n} items" (a polite live region), the files the server did not use and the plan's problems,
// then one ClaudeImportGroup per `groupsOf(plan)` (Agents, Commands, Skills, Output styles, Hooks, MCP servers, Allowed
// shell commands, Denied tools, Instructions, Settings, Unsupported). The `CLAUDE.md` mode
// (`claude-import-instructions-mode`) sits in the Instructions item; every change goes through `syncInstructions`, so the
// selection's mode always matches that item. Store-free.
// Props, emits and the root test id are frozen from Gate P12-0b (C46 stub); body W12.10 (P12-A).
import type { ClaudeImportPlan } from '@harness-forge/shared'
import type { ClaudeImportSelection } from './claude-import'
import { computed } from 'vue'
import { testIds } from '~/utils/testids'
import { foundText, groupsOf, syncInstructions } from './claude-import'
import ClaudeImportGroup from './ClaudeImportGroup.vue'

const props = defineProps<{ plan: ClaudeImportPlan, selection: ClaudeImportSelection }>()

const emit = defineEmits<{ 'update:selection': [selection: ClaudeImportSelection] }>()

const groups = computed(() => groupsOf(props.plan))
const problems = computed(() => props.plan.diagnostics.filter(diagnostic => diagnostic.level !== 'info').map(diagnostic => diagnostic.message))
const skippedText = computed(() => {
  const count = props.plan.skipped.length
  return count === 0 ? '' : `${count} ${count === 1 ? 'file was' : 'files were'} not used (too large, not readable or not on the list).`
})

function onSelection(value: ClaudeImportSelection): void {
  emit('update:selection', syncInstructions(props.plan, value))
}
</script>

<template>
  <div :data-testid="testIds.claudeImportPreview" :data-count="plan.items.length" class="grid min-w-0 gap-4">
    <div class="grid gap-1">
      <p class="text-sm font-medium" role="status" aria-live="polite">
        {{ foundText(plan.items.length) }}
      </p>
      <p v-if="skippedText" class="text-xs text-muted-foreground">
        {{ skippedText }}
      </p>
      <ul v-if="problems.length > 0" aria-label="Problems" class="grid gap-0.5 text-xs text-muted-foreground">
        <li v-for="(problem, index) in problems" :key="index" class="break-words">
          {{ problem }}
        </li>
      </ul>
    </div>
    <ClaudeImportGroup
      v-for="group in groups"
      :key="group.kind"
      :group="group"
      :selection="selection"
      @update:selection="onSelection"
    />
  </div>
</template>
