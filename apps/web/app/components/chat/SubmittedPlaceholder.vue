<script setup lang="ts">
// Submitted state (docs/UI.md 7.6): one transcript line with a shimmering "Thinking…" until the reply starts.
// Phase 9 (ADR-040, docs/UI.md 7.24): "Compacting conversation…" instead while the session's transient activity is
// `compacting` (a summary is being written before or during the reply).
// Phase 11 (ADR-048; C39 widens the prop, W11.12 owns it; frozen from Gate P11-0b): "Running hooks…" while it is `hooks`
// (command hooks of a message-level event run: UserPromptSubmit, SessionStart, Stop, PreCompact), the line marked
// `data-slot="running-hook"`; never announced (`aria-hidden`); reduced motion shows static muted text.
// Phase 12 (ADR-057; docs/UI.md 7.34; W12.17): while it is `hooks`, a running hook's `statusMessage` (the session's
// `hookActivity.label`, through the HOOK_ACTIVITY injection like ToolPart's "Running hook…": the transcript rows are
// `v-memo`ed, and the props stay frozen) replaces "Running hooks…". The parents pass `hooks` only for message-level hooks
// (ChatMessage leaves a tool row's own hooks to that row), so the label always belongs to this line. Absent on share
// pages (null default).
import { computed, inject } from 'vue'
import { testIds } from '~/utils/testids'
import { HOOK_ACTIVITY } from './chat-context'

const props = withDefaults(defineProps<{
  /**
   * + Phase 9: the session's transient activity; 'compacting' shows "Compacting conversation…". + Phase 11: 'hooks'
   * shows "Running hooks…" (+ Phase 12: the running hook's status message when it has one).
   */
  activity?: 'compacting' | 'hooks' | null
}>(), {
  activity: null,
})

/** + Phase 12: the hooks running in the chat's stream (ChatView provides it). */
const hookActivity = inject(HOOK_ACTIVITY, null)

/** + Phase 12: the running hook's status message, '' without one. */
const hookLabel = computed(() => {
  const label = hookActivity?.value?.label
  return typeof label === 'string' ? label.trim() : ''
})

const label = computed(() => {
  if (props.activity === 'compacting')
    return 'Compacting conversation…'
  if (props.activity === 'hooks')
    return hookLabel.value || 'Running hooks…'
  return 'Thinking…'
})
</script>

<template>
  <p :data-testid="testIds.submittedPlaceholder" class="h-[1lh] text-muted-foreground" aria-hidden="true">
    <!-- One line: a long status message is cut with an ellipsis (the row keeps its height). -->
    <span
      class="hf-shimmer-text inline-block max-w-full truncate align-top"
      :data-slot="activity === 'hooks' ? 'running-hook' : undefined"
    >{{ label }}</span>
  </p>
</template>
