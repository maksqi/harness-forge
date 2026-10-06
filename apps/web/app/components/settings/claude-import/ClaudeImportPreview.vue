<script setup lang="ts">
// Step 2 of the import (Phase 12, ADR-055; docs/UI.md 9.14, 10.9): `claude-import-preview` (`data-count` = the plan's
// items), "Found {n} items" (a polite live region), the `CLAUDE.md` mode (`claude-import-instructions-mode`: Append /
// Replace / Skip) and one ClaudeImportGroup per `groupsOf(plan)`. Store-free.
// Props, emits and the root test id are frozen from Gate P12-0b (C46 stub); W12.10 implements the preview in P12-A.
import type { ClaudeImportPlan } from '@harness-forge/shared'
import type { ClaudeImportSelection } from './claude-import'
import { computed } from 'vue'
import { testIds } from '~/utils/testids'
import { groupsOf } from './claude-import'
import ClaudeImportGroup from './ClaudeImportGroup.vue'

const props = defineProps<{ plan: ClaudeImportPlan, selection: ClaudeImportSelection }>()

const emit = defineEmits<{ 'update:selection': [selection: ClaudeImportSelection] }>()

const groups = computed(() => groupsOf(props.plan))
const hasInstructions = computed(() => props.plan.items.some(item => item.kind === 'instructions'))

function onInstructions(event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  if (value === 'append' || value === 'replace' || value === 'skip')
    emit('update:selection', { ...props.selection, instructions: value })
}
</script>

<template>
  <div :data-testid="testIds.claudeImportPreview" :data-count="plan.items.length" class="grid min-w-0 gap-4">
    <p class="text-sm" role="status" aria-live="polite">
      Found {{ plan.items.length }} {{ plan.items.length === 1 ? 'item' : 'items' }}
    </p>
    <label v-if="hasInstructions" class="flex items-center gap-2 text-sm">
      CLAUDE.md
      <select
        :value="selection.instructions"
        :data-testid="testIds.claudeImportInstructionsMode"
        :data-value="selection.instructions"
        class="h-8 rounded-md border bg-transparent px-2 text-sm"
        @change="onInstructions"
      >
        <option value="append">Append</option>
        <option value="replace">Replace</option>
        <option value="skip">Skip</option>
      </select>
    </label>
    <ClaudeImportGroup
      v-for="group in groups"
      :key="group.kind"
      :group="group"
      :selection="selection"
      @update:selection="value => emit('update:selection', value)"
    />
  </div>
</template>
