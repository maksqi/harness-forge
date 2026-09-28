<script setup lang="ts">
// What a share link includes besides the text (docs/UI.md 2.8, 7.14): the "Files and images" (attachments and
// generated images; option key `attachments`), Reasoning and Tool details switches of a link card and of the new-link
// form. Presentational: emits the changed key; the card sends it as an options-only update, the form keeps it until
// "Create link".
import type { ShareOptions } from '@harness-forge/shared'
import type { ShareOptionKey } from './share-links'
import { useId } from 'vue'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { testIds } from '~/utils/testids'
import { SHARE_OPTION_FIELDS } from './share-links'

withDefaults(defineProps<{
  options: ShareOptions
  disabled?: boolean
}>(), {
  disabled: false,
})

const emit = defineEmits<{
  change: [key: ShareOptionKey, value: boolean]
}>()

const baseId = useId()
</script>

<template>
  <div data-slot="share-options" class="flex flex-wrap items-center gap-x-4 gap-y-2">
    <div v-for="field in SHARE_OPTION_FIELDS" :key="field.key" class="flex items-center gap-2">
      <Switch
        :id="`${baseId}-${field.value}`"
        :model-value="options[field.key]"
        :disabled="disabled"
        :data-testid="testIds.shareOption"
        :data-value="field.value"
        @update:model-value="(value: boolean) => emit('change', field.key, value)"
      />
      <Label :for="`${baseId}-${field.value}`" class="text-sm font-normal">
        {{ field.label }}
      </Label>
    </div>
  </div>
</template>
