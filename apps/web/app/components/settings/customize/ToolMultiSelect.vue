<script setup lang="ts">
// The tool picker of the definition editor (docs/UI.md 9.12, 10.7): a Popover with the tools grouped by plugin and the
// chosen tools as chips; a name the tool list does not know stays as a warning chip ("Not available now"). null = no
// restriction ("All tools"). Props and emits are frozen from Gate P10-0b (C33 stub); W10.8 implements it in P10-A.
// No root test id (the editor sets customization-tools); the stub shows the chosen tools as chips.
import type { ToolSummary } from '@harness-forge/shared'
import { testIds } from '~/utils/testids'

const props = defineProps<{ modelValue: string[] | null, tools: readonly ToolSummary[], label: string, disabled?: boolean }>()
defineEmits<{ 'update:modelValue': [value: string[] | null] }>()

function known(name: string): boolean {
  return props.tools.some(tool => tool.name === name)
}
</script>

<template>
  <div role="group" :aria-label="label" :aria-disabled="disabled ? 'true' : undefined" class="flex flex-wrap gap-1.5">
    <span
      v-for="name in modelValue ?? []"
      :key="name"
      :data-testid="testIds.customizationToolChip"
      :data-tool-name="name"
      :data-state="known(name) ? 'known' : 'unknown'"
      class="rounded-md border px-1.5 py-0.5 font-mono text-xs"
    >{{ name }}</span>
  </div>
</template>
