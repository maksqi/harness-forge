<script setup lang="ts">
// One hook record in the transcript (Phase 11, ADR-048; docs/UI.md 7.31, 10.8): `role="note"` named "Hook {event}:
// {summary}", the line by outcome (icon, text, source), the system messages, and a details toggle (`hook-note-toggle`,
// `aria-expanded` / `aria-controls`) that opens `hook-note-details` (the context in `data-slot="hook-context"`, each
// hook's error text in `data-slot="hook-output"`, the source lines). Store-free: ChatMessage renders it for block kind
// `hook` (variant inline), under a user message's bubble (inline), for a hook carrier (variant turn: a card, the reason
// as its body) and ToolPart inside a tool row (variant tool); `pluginName` names the plugin of a plugin hook. Props and
// the root test id are frozen from Gate P11-0b (C39 stub); W11.12 implements the note in P11-A. The stub shows the line.
import type { HookData } from '@harness-forge/shared'
import { computed } from 'vue'
import { cn } from '@/lib/utils'
import { testIds } from '~/utils/testids'
import { hookOutcomeText } from './hook-notes'

const props = defineProps<{ data: HookData, variant: 'inline' | 'turn' | 'tool', pluginName?: string | null }>()

const line = computed(() => hookOutcomeText(props.data))
</script>

<template>
  <div
    :data-testid="testIds.hookNote"
    :data-event="data.event"
    :data-outcome="data.outcome"
    :data-source="data.hooks[0]?.source"
    :data-variant="variant"
    role="note"
    :aria-label="`Hook ${data.event}: ${line}`"
    :class="cn(
      'flex min-w-0 flex-col gap-0.5 text-sm',
      variant === 'turn' ? 'rounded-lg border bg-muted/30 px-3 py-2' : 'text-muted-foreground',
    )"
  >
    <p class="min-w-0 truncate">
      {{ line }}
    </p>
    <p v-if="variant === 'turn' && data.reason" class="min-w-0 break-words whitespace-pre-wrap">
      {{ data.reason }}
    </p>
  </div>
</template>
