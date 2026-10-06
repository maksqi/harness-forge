<script setup lang="ts">
// One group of the import preview (Phase 12, ADR-055; docs/UI.md 9.14, 10.9): `claude-import-group` (`data-kind` = an
// import kind or `unsupported`, `data-count`), the heading "{group} · {n}" (a warning icon when it holds items that run
// commands), Select all {n} (`claude-import-select-all`, tri-state from `groupState`; none for the unsupported group)
// and its items (ClaudeImportItem). Store-free.
// Props, emits and the root test id are frozen from Gate P12-0b (C46 stub); W12.10 implements the group in P12-A.
import type { ClaudeImportChoice, ClaudeImportGroupView, ClaudeImportSelection } from './claude-import'
import { computed } from 'vue'
import { Checkbox } from '@/components/ui/checkbox'
import { testIds } from '~/utils/testids'
import { defaultChoice, groupState, isSelectable } from './claude-import'
import ClaudeImportItem from './ClaudeImportItem.vue'

const props = defineProps<{ group: ClaudeImportGroupView, selection: ClaudeImportSelection }>()

const emit = defineEmits<{ 'update:selection': [selection: ClaudeImportSelection] }>()

const selectable = computed(() => props.group.items.filter(isSelectable))
const state = computed(() => groupState(props.group, props.selection))

function setChoice(key: string, choice: ClaudeImportChoice | null): void {
  const items = { ...props.selection.items }
  if (choice)
    items[key] = choice
  else
    delete items[key]
  emit('update:selection', { ...props.selection, items })
}

function selectAll(value: boolean | 'indeterminate'): void {
  const items = { ...props.selection.items }
  for (const item of selectable.value) {
    if (value === true)
      items[item.key] ??= defaultChoice(item) ?? { action: item.actions.find(action => action !== 'skip') ?? item.defaultAction }
    else
      delete items[item.key]
  }
  emit('update:selection', { ...props.selection, items })
}
</script>

<template>
  <section
    :data-testid="testIds.claudeImportGroup"
    :data-kind="group.kind"
    :data-count="group.items.length"
    :aria-label="`${group.title} · ${group.items.length}`"
    class="grid min-w-0 gap-1"
  >
    <div class="flex min-w-0 items-center justify-between gap-3">
      <h3 class="text-sm font-medium">
        {{ group.title }} · {{ group.items.length }}
      </h3>
      <label v-if="selectable.length > 0" class="flex items-center gap-2 text-sm">
        <Checkbox
          :model-value="state"
          :data-testid="testIds.claudeImportSelectAll"
          @update:model-value="selectAll"
        />
        Select all {{ selectable.length }}
      </label>
    </div>
    <ul class="grid min-w-0 divide-y">
      <ClaudeImportItem
        v-for="item in group.items"
        :key="item.key"
        :item="item"
        :choice="selection.items[item.key] ?? null"
        @update:choice="choice => setChoice(item.key, choice)"
      />
    </ul>
  </section>
</template>
