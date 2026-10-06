<script setup lang="ts">
// The hooks of a plugin on its detail page (Phase 11, ADR-048, plugin API 1.5.0; docs/UI.md 8.8, 10.8): the command hooks
// (`contributes.hooks`: the event, the matcher and the mono command, "Runs only while you trust this plugin.") and the
// code hooks (`ctx.hooks.on`, their HookMap keys as chips). PluginContributions renders it with the plugin's command
// entries of `useHooksStore().list(null)` and `contributions.hooks`. Props and the root test id are frozen from Gate
// P11-0b (C39 stub); W11.8 implements the list in P11-A. The stub lists the events.
import type { HookEntry } from '@harness-forge/shared'
import { computed } from 'vue'
import { testIds } from '~/utils/testids'

const props = defineProps<{
  /** The plugin's command hooks (`GET /hooks` entries of the plugin). */
  entries: readonly HookEntry[]
  /** The plugin's code hook names (HookMap keys). */
  codeHooks: readonly string[]
}>()

const rows = computed(() => [
  ...props.entries.map(entry => ({ key: entry.key, event: entry.event, kind: 'command' as const, command: entry.kind === 'command' ? entry.command : '' })),
  ...props.codeHooks.map(name => ({ key: `code:${name}`, event: name, kind: 'code' as const, command: '' })),
])
</script>

<template>
  <ul :data-testid="testIds.pluginHooks" :data-count="rows.length" role="list" class="flex flex-col gap-1">
    <li
      v-for="row in rows"
      :key="row.key"
      :data-testid="testIds.pluginHook"
      :data-event="row.event"
      :data-kind="row.kind"
      class="flex min-w-0 items-baseline gap-3 text-sm"
    >
      <span class="shrink-0 font-mono text-[13px]">{{ row.event }}</span>
      <span v-if="row.command" class="min-w-0 truncate font-mono text-xs text-muted-foreground">{{ row.command }}</span>
    </li>
  </ul>
</template>
