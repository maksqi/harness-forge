<script setup lang="ts">
// Expiry select of a link card and of the new-link form (docs/UI.md 2.8, 7.14): Never · 1 day · 7 days · 30 days ·
// 90 days. The trigger shows `label` (the link's state, e.g. "Expires in 5 days"). A card passes no `modelValue`, so
// choosing the same item again still emits (and extends the link from now); the form passes its current choice.
import type { AcceptableValue } from 'reka-ui'
import type { ShareExpiryChoice } from './share-links'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { testIds } from '~/utils/testids'
import { isShareExpiryChoice, SHARE_EXPIRY_OPTIONS } from './share-links'

withDefaults(defineProps<{
  /** Trigger text. */
  label: string
  /** The selected choice (new-link form); null = nothing selected (link cards). */
  modelValue?: ShareExpiryChoice | null
  disabled?: boolean
}>(), {
  modelValue: null,
  disabled: false,
})

const emit = defineEmits<{
  select: [choice: ShareExpiryChoice]
}>()

function onSelect(value: AcceptableValue) {
  if (isShareExpiryChoice(value))
    emit('select', value)
}
</script>

<template>
  <Select :model-value="modelValue" :disabled="disabled" @update:model-value="onSelect">
    <SelectTrigger
      size="sm"
      aria-label="Link expiry"
      :data-testid="testIds.shareExpiry"
      class="min-w-0 tabular-nums pointer-coarse:data-[size=sm]:h-10"
    >
      <span class="truncate">{{ label }}</span>
    </SelectTrigger>
    <SelectContent position="popper" align="end" class="min-w-36">
      <SelectItem
        v-for="option in SHARE_EXPIRY_OPTIONS"
        :key="option.value"
        :value="option.value"
        :data-testid="testIds.shareExpiryOption"
        :data-value="option.value"
      >
        {{ option.label }}
      </SelectItem>
    </SelectContent>
  </Select>
</template>
