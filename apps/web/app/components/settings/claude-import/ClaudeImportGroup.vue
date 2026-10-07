<script setup lang="ts">
// One group of the import preview (Phase 12, ADR-055; docs/UI.md 9.14, 10.9, 14.2): `claude-import-group` (`data-kind` =
// an import kind or `unsupported`, `data-count`), a `role="group"` labelled by its heading "{group} · {n}" (with a warning
// icon and "runs commands" for screen readers when it holds items that run commands), Select all {n}
// (`claude-import-select-all`, tri-state from `groupState`: reka reports `aria-checked="mixed"` and
// `data-state="indeterminate"`, the box shows a minus; none for the unsupported group; under the heading when the row is
// narrow) and its items (ClaudeImportItem) in a list. Select all picks every selectable item with its default choice and
// keeps the choices already made. Store-free.
// Props, emits and the root test id are frozen from Gate P12-0b (C46 stub); body W12.10 (P12-A).
import type { ClaudeImportChoice, ClaudeImportGroupView, ClaudeImportSelection } from './claude-import'
import { CheckIcon, MinusIcon, ShieldAlertIcon } from '@lucide/vue'
import { computed, useId } from 'vue'
import { Checkbox } from '@/components/ui/checkbox'
import { testIds } from '~/utils/testids'
import { defaultChoice, groupState, isSelectable } from './claude-import'
import ClaudeImportItem from './ClaudeImportItem.vue'

const props = defineProps<{ group: ClaudeImportGroupView, selection: ClaudeImportSelection }>()

const emit = defineEmits<{ 'update:selection': [selection: ClaudeImportSelection] }>()

const ids = { heading: useId(), all: useId() }

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
    if (value === true) {
      const first = item.actions.find(action => action !== 'skip') ?? item.defaultAction
      items[item.key] ??= defaultChoice(item) ?? (first === 'rename' && item.renameTo ? { action: 'rename', renameTo: item.renameTo } : { action: first })
    }
    else {
      delete items[item.key]
    }
  }
  emit('update:selection', { ...props.selection, items })
}
</script>

<template>
  <section
    role="group"
    :aria-labelledby="ids.heading"
    :data-testid="testIds.claudeImportGroup"
    :data-kind="group.kind"
    :data-count="group.items.length"
    class="grid min-w-0 gap-1"
  >
    <div class="flex min-h-8 min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b pb-1">
      <h3 :id="ids.heading" class="flex items-center gap-1.5 text-sm font-medium">
        {{ group.title }} · {{ group.items.length }}
        <template v-if="group.executable">
          <ShieldAlertIcon aria-hidden="true" class="size-3.5 text-warning" />
          <span class="sr-only">(runs commands)</span>
        </template>
      </h3>
      <div v-if="selectable.length > 0" class="flex items-center gap-2">
        <Checkbox
          :id="ids.all"
          :model-value="state"
          :data-testid="testIds.claudeImportSelectAll"
          class="pointer-coarse:after:-inset-[13px]"
          @update:model-value="selectAll"
        >
          <template #default="{ state: checked }">
            <MinusIcon v-if="checked === 'indeterminate'" />
            <CheckIcon v-else />
          </template>
        </Checkbox>
        <label :for="ids.all" class="text-sm select-none">
          Select all {{ selectable.length }}
        </label>
      </div>
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
