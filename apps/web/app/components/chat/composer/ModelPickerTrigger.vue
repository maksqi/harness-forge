<script setup lang="ts">
// Trigger of the model picker (docs/UI.md 7.9). Composer: ghost h-8 button, provider icon + model name (truncated at
// 18ch) + chevron; an unavailable model (provider disabled or removed) shows `TriangleAlert` in warning color.
// Field (settings): a full-width select-like button. Attributes from ModelPicker (data-testid, aria-*) and the
// Popover / Drawer trigger props land on the button.
import { ChevronDownIcon, ChevronsUpDownIcon, TriangleAlertIcon } from '@lucide/vue'
import { computed } from 'vue'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import ProviderIcon from '~/components/providers/ProviderIcon.vue'
import { useComposerModel } from '~/composables/useComposerModel'
import { testIds } from '~/utils/testids'

const props = withDefaults(defineProps<{
  modelValue: string | null
  variant?: 'composer' | 'field'
  noneLabel?: string
  disabled?: boolean
}>(), {
  variant: 'composer',
  noneLabel: 'None',
  disabled: false,
})

const current = useComposerModel(() => props.modelValue)
const unavailable = computed(() => props.modelValue !== null && !current.available.value)
const label = computed(() => {
  if (!props.modelValue)
    return props.variant === 'field' ? props.noneLabel : 'Choose a model'
  return current.displayName.value
})
const providerName = computed(() => current.provider.value?.name ?? '')
const ariaLabel = computed(() => {
  if (!props.modelValue)
    return props.variant === 'field' ? `Model: ${props.noneLabel}` : 'Choose a model'
  return `Model: ${label.value}${unavailable.value ? ' (unavailable)' : ''}`
})
</script>

<template>
  <Button
    type="button"
    :variant="variant === 'field' ? 'outline' : 'ghost'"
    size="sm"
    :disabled="disabled"
    :data-testid="testIds.modelPickerTrigger"
    :data-model-ref="modelValue ?? undefined"
    :data-available="unavailable ? 'false' : undefined"
    :aria-label="ariaLabel"
    :class="cn(
      'gap-1.5 font-normal',
      variant === 'composer'
        ? 'h-8 max-w-full min-w-0 shrink px-2 text-muted-foreground hover:text-foreground aria-expanded:text-foreground pointer-coarse:h-10'
        : 'h-9 w-full justify-between px-3',
    )"
  >
    <TriangleAlertIcon v-if="unavailable" aria-hidden="true" class="size-4 shrink-0 text-warning" />
    <ProviderIcon
      v-else-if="modelValue && current.provider.value"
      :id="current.provider.value.id"
      :icon="current.provider.value.icon"
      :name="providerName"
      size="sm"
      variant="auto"
    />
    <span
      :class="cn(
        'min-w-0 truncate text-left',
        variant === 'composer' ? 'max-w-[18ch]' : 'flex-1',
        !modelValue && 'text-muted-foreground',
      )"
    >{{ label }}</span>
    <span v-if="variant === 'field' && modelValue && providerName" class="shrink-0 truncate text-xs text-muted-foreground">
      {{ providerName }}
    </span>
    <ChevronsUpDownIcon v-if="variant === 'field'" aria-hidden="true" class="size-4 shrink-0 opacity-60" />
    <ChevronDownIcon v-else aria-hidden="true" class="size-3.5 shrink-0 opacity-60" />
  </Button>
</template>
