<script setup lang="ts">
// One item of the import preview (Phase 12, ADR-055; docs/UI.md 9.14, 10.9): `claude-import-item` (`data-kind`,
// `data-status`, `data-name`) with its checkbox (`claude-import-select`; none for unchanged, unsupported and invalid
// items), the name, the source file, the summary and the status word (`STATUS_TEXT`); update and conflict items get the
// resolution (`claude-import-resolution`: Keep mine / Replace / Import as {renameTo}); items that run commands show
// "Imported turned off: …" and Turn on after import (`data-action="enable"`); MCP servers that need values show an input
// per name (`data-action="variable"`, `data-name`). `update:choice(null)` = not selected. Store-free.
// Props, emits and the root test id are frozen from Gate P12-0b (C46 stub); W12.10 implements the item in P12-A.
import type { ClaudeImportPlan } from '@harness-forge/shared'
import type { ClaudeImportChoice } from './claude-import'
import { computed } from 'vue'
import { Checkbox } from '@/components/ui/checkbox'
import { testIds } from '~/utils/testids'
import { defaultChoice, isSelectable, STATUS_TEXT } from './claude-import'

const props = defineProps<{ item: ClaudeImportPlan['items'][number], choice: ClaudeImportChoice | null }>()

const emit = defineEmits<{ 'update:choice': [choice: ClaudeImportChoice | null] }>()

const selectable = computed(() => isSelectable(props.item))
const resolvable = computed(() => props.item.status === 'update' || props.item.status === 'conflict')

function onChecked(value: boolean | 'indeterminate'): void {
  if (value !== true) {
    emit('update:choice', null)
    return
  }
  const first = props.item.actions.find(action => action !== 'skip') ?? props.item.defaultAction
  emit('update:choice', defaultChoice(props.item) ?? (first === 'rename' && props.item.renameTo ? { action: 'rename', renameTo: props.item.renameTo } : { action: first }))
}

function onResolution(event: Event): void {
  const action = (event.target as HTMLSelectElement).value
  if (action === 'skip') {
    emit('update:choice', null)
    return
  }
  if (action === 'overwrite' || action === 'rename')
    emit('update:choice', action === 'rename' && props.item.renameTo ? { action, renameTo: props.item.renameTo } : { action })
}
</script>

<template>
  <li
    :data-testid="testIds.claudeImportItem"
    :data-kind="item.kind"
    :data-status="item.status"
    :data-name="item.name"
    class="flex min-w-0 items-start gap-3 py-2"
  >
    <Checkbox
      v-if="selectable"
      :model-value="choice !== null"
      :aria-label="`Import ${item.name}`"
      :data-testid="testIds.claudeImportSelect"
      class="mt-0.5"
      @update:model-value="onChecked"
    />
    <div class="grid min-w-0 flex-1 gap-0.5">
      <p class="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <span class="text-sm font-medium break-all">{{ item.name }}</span>
        <span class="font-mono text-xs text-muted-foreground">{{ item.source.file }}</span>
        <span class="text-xs">{{ STATUS_TEXT[item.status] }}</span>
      </p>
      <p v-if="item.summary" class="text-xs text-muted-foreground">
        {{ item.summary }}
      </p>
    </div>
    <select
      v-if="resolvable && selectable"
      :value="choice?.action ?? 'skip'"
      aria-label="Resolution"
      :data-testid="testIds.claudeImportResolution"
      :data-value="choice?.action ?? 'skip'"
      class="h-8 rounded-md border bg-transparent px-2 text-sm"
      @change="onResolution"
    >
      <option value="skip">
        Keep mine
      </option>
      <option v-if="item.actions.includes('overwrite')" value="overwrite">
        Replace
      </option>
      <option v-if="item.actions.includes('rename') && item.renameTo" value="rename">
        Import as {{ item.renameTo }}
      </option>
    </select>
  </li>
</template>
