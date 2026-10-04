<script setup lang="ts">
// One definition of the Customize page (docs/UI.md 9.12, 10.7): the kind icon, the name and the description, the meta
// line, the state badges with the diagnostics and the row menu. Props, emits and the root test id are frozen from Gate
// P10-0b (C33 stub); W10.8 implements the row in P10-A. The stub shows the name and the description.
import type { CustomizationEntry } from '@harness-forge/shared'
import type { CustomizationAction } from './customize'
import { testIds } from '~/utils/testids'

defineProps<{ entry: CustomizationEntry, busy?: boolean }>()
defineEmits<{ action: [action: CustomizationAction] }>()
</script>

<template>
  <div
    :data-testid="testIds.customizationRow"
    :data-kind="entry.kind"
    :data-name="entry.name"
    :data-source="entry.source"
    :data-state="entry.state"
    :data-customization-id="entry.source === 'user' ? entry.id : undefined"
    :data-path="entry.source === 'project' ? entry.path : undefined"
    :data-plugin-id="entry.source === 'plugin' ? entry.pluginId : undefined"
    :aria-busy="busy ? 'true' : undefined"
    class="flex min-h-(--row-height) min-w-0 items-baseline gap-3 py-1.5 text-sm"
  >
    <span class="shrink-0 font-mono">{{ entry.kind === 'command' ? `/${entry.name}` : entry.name }}</span>
    <span class="min-w-0 truncate text-muted-foreground">{{ entry.description }}</span>
  </div>
</template>
