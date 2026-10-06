<script setup lang="ts">
// The hook mark of a tool row's status cell (Phase 11, ADR-048; docs/UI.md 7.31, 10.8): the outcome of the call's
// PreToolUse record: `denied` "Blocked by hook" (`ShieldBan`, replaces "Denied"), `allowed` a `Webhook` icon with a
// check (tooltip "Allowed by hook"), `rewritten` a `Webhook` icon with a pencil (tooltip "Input changed by hook"); the
// sr-only text adds ", blocked by hook" / ", allowed by hook" / ", input changed by hook" (the ToolRuleBadge pattern).
// Renders nothing without a PreToolUse record of one of those outcomes. Store-free (ToolPart renders it with its
// `hooks`). Props and the root test id are frozen from Gate P11-0b (C39 stub); W11.12 implements the badge in P11-A.
// The stub shows the sr-only text.
import type { HookData } from '@harness-forge/shared'
import { computed } from 'vue'
import { testIds } from '~/utils/testids'

const props = defineProps<{ hooks: readonly HookData[] }>()

const BADGE_TEXT = {
  denied: ', blocked by hook',
  allowed: ', allowed by hook',
  rewritten: ', input changed by hook',
} as const

type BadgeOutcome = keyof typeof BADGE_TEXT

function isBadgeOutcome(outcome: string): outcome is BadgeOutcome {
  return Object.hasOwn(BADGE_TEXT, outcome)
}

/** The outcome of the call's PreToolUse record, when it is one the badge shows. */
const outcome = computed<BadgeOutcome | null>(() => {
  const record = props.hooks.find(data => data.event === 'PreToolUse' && isBadgeOutcome(data.outcome))
  return record && isBadgeOutcome(record.outcome) ? record.outcome : null
})
</script>

<template>
  <span
    v-if="outcome"
    :data-testid="testIds.toolRowHook"
    :data-value="outcome"
    class="inline-flex shrink-0 items-center text-muted-foreground"
  >
    <span class="sr-only">{{ BADGE_TEXT[outcome] }}</span>
  </span>
</template>
