<script setup lang="ts">
// One hook of the Customize Hooks tab (Phase 11, ADR-048; docs/UI.md 9.13, 10.8): `Webhook` (`WebhookOff` for off and
// blocked), the event, the matcher ("All tools" for an empty or `*` tool matcher), the command (mono, truncated in the
// middle, `data-slot="hook-row-command"`), the state badge (`hookStateBadge`), the meta line (`hookRowMeta`), the
// diagnostics of an invalid row and the menu (`hook-row-menu`: personal Edit… · Duplicate · Turn off / on · Copy as
// JSON · Delete…; project Review… · Copy to personal · Copy as JSON; plugin Open plugin · Copy as JSON). Store-free.
// Props, emits and the root test id are frozen from Gate P11-0b (C39 stub); W11.8 implements the row in P11-A. The stub
// shows the event and the command.
import type { HookEntry } from '@harness-forge/shared'
import type { HookAction } from './hooks'
import { testIds } from '~/utils/testids'

defineProps<{ entry: HookEntry, busy?: boolean }>()
defineEmits<{ action: [action: HookAction] }>()
</script>

<template>
  <div
    :data-testid="testIds.hookRow"
    :data-source="entry.source"
    :data-event="entry.event"
    :data-kind="entry.kind"
    :data-state="entry.state"
    :data-hook-id="entry.source === 'personal' ? entry.id : undefined"
    :data-path="entry.kind === 'command' && entry.source === 'project' ? entry.path : undefined"
    :data-plugin-id="entry.source === 'plugin' ? entry.pluginId : undefined"
    :aria-busy="busy ? 'true' : undefined"
    class="flex min-h-(--row-height) min-w-0 items-baseline gap-3 py-1.5 text-sm"
  >
    <span class="shrink-0 font-medium">{{ entry.event }}</span>
    <span v-if="entry.kind === 'command'" class="min-w-0 truncate font-mono text-muted-foreground">{{ entry.command }}</span>
  </div>
</template>
