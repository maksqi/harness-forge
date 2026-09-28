<script setup lang="ts">
// Browse filter as a select, for screens below md where the sidebar is a sheet (docs/UI.md 8.2, 14.5). Options
// carry their counts from the plugins store.
import type { AcceptableValue } from 'reka-ui'
import type { PluginCounts, PluginFilter } from '~/stores/plugins'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { isPluginFilter } from '~/stores/plugins'
import { testIds } from '~/utils/testids'
import { PLUGIN_FILTER_OPTIONS } from './plugin-display'

defineOptions({ inheritAttrs: false })

defineProps<{ modelValue: PluginFilter, counts?: PluginCounts | null }>()

const emit = defineEmits<{ 'update:modelValue': [value: PluginFilter] }>()

function onUpdate(value: AcceptableValue) {
  if (isPluginFilter(value))
    emit('update:modelValue', value)
}
</script>

<template>
  <Select :model-value="modelValue" @update:model-value="onUpdate">
    <SelectTrigger
      aria-label="Show plugins"
      :data-testid="testIds.pluginsFilter"
      :data-value="modelValue"
      v-bind="$attrs"
    >
      <SelectValue />
    </SelectTrigger>
    <SelectContent position="popper" align="end">
      <SelectItem v-for="option in PLUGIN_FILTER_OPTIONS" :key="option.value" :value="option.value">
        <component :is="option.icon" aria-hidden="true" class="text-muted-foreground" />
        <span>{{ option.label }}</span>
        <span v-if="counts" class="ml-auto pl-3 text-xs text-muted-foreground tabular-nums">{{ counts[option.value] }}</span>
      </SelectItem>
    </SelectContent>
  </Select>
</template>
