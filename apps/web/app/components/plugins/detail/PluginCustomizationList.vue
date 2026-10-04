<script setup lang="ts">
// The agents or skills of a plugin on its detail page (docs/UI.md 8.8, 10.7; ADR-045, plugin API 1.4.0): one row per
// entry (`plugin-customization`, `data-name`: the mono name, the description, the model or "{n} tools"), the
// contributed names without a catalog entry as name-only rows, and "Open in Customize". PluginContributions renders one
// per kind with `customizations.catalog(null)` filtered by the plugin. Props and the root test id are frozen from Gate
// P10-0b (C33 stub); W10.12 implements the list in P10-A. The stub lists the names and descriptions.
import type { CustomizationEntry } from '@harness-forge/shared'
import { computed } from 'vue'
import { testIds } from '~/utils/testids'

const props = defineProps<{
  kind: 'agent' | 'skill'
  pluginId: string
  /** `customizations.catalog(null)` filtered by the plugin and the kind. */
  entries: readonly CustomizationEntry[]
  /** Contributed names without an entry (name-only rows). */
  missing: readonly string[]
}>()

const rows = computed(() => [
  ...props.entries.map(entry => ({ name: entry.name, description: entry.description, state: entry.state === 'shadowed' ? 'shadowed' : 'active' })),
  ...props.missing.map(name => ({ name, description: '', state: 'active' })),
].sort((a, b) => a.name.localeCompare(b.name)))
</script>

<template>
  <ul
    role="list"
    :data-testid="testIds.pluginCustomizations"
    :data-kind="kind"
    :data-count="rows.length"
    class="divide-y divide-border overflow-hidden rounded-xl border bg-card"
  >
    <li
      v-for="row in rows"
      :key="row.name"
      :data-testid="testIds.pluginCustomization"
      :data-name="row.name"
      :data-state="row.state"
      class="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-4 py-2.5"
    >
      <code class="font-mono text-[13px] font-medium">{{ row.name }}</code>
      <span class="min-w-0 flex-1 text-sm text-muted-foreground">{{ row.description }}</span>
    </li>
  </ul>
</template>
