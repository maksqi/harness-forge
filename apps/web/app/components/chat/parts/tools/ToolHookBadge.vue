<script setup lang="ts">
// The hook mark of a tool row's status cell (Phase 11, ADR-048; docs/UI.md 7.31, 10.8, 14.2): the outcome of the call's
// PreToolUse record. `denied`: "Blocked by hook" (`ShieldBan`, `text-destructive`), which replaces "Denied" (ToolPart
// renders it in place of the denied status); `allowed`: a `Webhook` icon with a check, tooltip "Allowed by hook";
// `rewritten`: a `Webhook` icon with a pencil, tooltip "Input changed by hook". The sr-only text adds ", blocked by hook" /
// ", allowed by hook" / ", input changed by hook" to the row's name (the ToolRuleBadge pattern: the visible text and the
// icons are hidden from screen readers). The tooltip shows on hover and while the row has keyboard focus: the badge sits
// inside the row's button, and a button may not contain a focusable element, so the row's focus stands in for the
// badge's own (like TaskBlock's agent card). Renders nothing without a PreToolUse record of one of those outcomes. Store-free (ToolPart
// renders it with its `hooks`). Props and the root test id are frozen from Gate P11-0b (C39).
import type { HookData } from '@harness-forge/shared'
import { CheckIcon, PencilIcon, ShieldBanIcon, WebhookIcon } from '@lucide/vue'
import { useEventListener } from '@vueuse/core'
import { computed, ref, useTemplateRef } from 'vue'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { testIds } from '~/utils/testids'

const props = defineProps<{ hooks: readonly HookData[] }>()

const BADGE_TEXT = {
  denied: ', blocked by hook',
  allowed: ', allowed by hook',
  rewritten: ', input changed by hook',
} as const

const TOOLTIP_TEXT = {
  allowed: 'Allowed by hook',
  rewritten: 'Input changed by hook',
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
/** The screen reader text and the tooltip of the outcome ('' when the badge shows nothing or has no tooltip). */
const srText = computed(() => (outcome.value ? BADGE_TEXT[outcome.value] : ''))
const tooltip = computed(() => (outcome.value === 'allowed' || outcome.value === 'rewritten' ? TOOLTIP_TEXT[outcome.value] : ''))

/** The tooltip trigger and the row button around it (ToolPart's CollapsibleTrigger; null outside a button). */
const trigger = useTemplateRef<HTMLElement>('trigger')
const row = computed(() => trigger.value?.closest('button') ?? null)
/** The tooltip's own state: hover (reka closes it on Escape, a pointer down, a scroll or another tooltip opening). */
const hoverOpen = ref(false)
/** The row has keyboard focus (`:focus-visible`; a click's focus does not count). */
const rowFocused = ref(false)
const tooltipOpen = computed(() => hoverOpen.value || rowFocused.value)

function isKeyboardFocus(element: Element): boolean {
  try {
    return element.matches(':focus-visible')
  }
  catch {
    return false
  }
}

useEventListener(row, 'focus', (event: FocusEvent) => {
  rowFocused.value = event.currentTarget instanceof Element && isKeyboardFocus(event.currentTarget)
})
useEventListener(row, 'blur', () => {
  rowFocused.value = false
})

/** Any close (Escape, a pointer down, the pointer leaving) also ends the focus opening until the row is focused again. */
function onOpenChange(open: boolean) {
  hoverOpen.value = open
  if (!open)
    rowFocused.value = false
}
</script>

<template>
  <span
    v-if="outcome === 'denied'"
    :data-testid="testIds.toolRowHook"
    data-value="denied"
    class="inline-flex shrink-0 items-center gap-1.5 text-destructive"
  >
    <ShieldBanIcon aria-hidden="true" class="size-3.5" />
    <span aria-hidden="true">Blocked by hook</span>
    <span class="sr-only">{{ srText }}</span>
  </span>
  <Tooltip v-else-if="outcome" :open="tooltipOpen" @update:open="onOpenChange">
    <TooltipTrigger as-child>
      <span
        ref="trigger"
        :data-testid="testIds.toolRowHook"
        :data-value="outcome"
        class="relative inline-flex shrink-0 items-center text-muted-foreground"
      >
        <WebhookIcon aria-hidden="true" class="size-3.5" />
        <CheckIcon
          v-if="outcome === 'allowed'"
          aria-hidden="true"
          class="absolute -right-1 -bottom-1 size-2.5 rounded-full bg-background text-success"
        />
        <PencilIcon
          v-else
          aria-hidden="true"
          class="absolute -right-1 -bottom-1 size-2.5 rounded-full bg-background text-foreground"
        />
        <span class="sr-only">{{ srText }}</span>
      </span>
    </TooltipTrigger>
    <TooltipContent>{{ tooltip }}</TooltipContent>
  </Tooltip>
</template>
