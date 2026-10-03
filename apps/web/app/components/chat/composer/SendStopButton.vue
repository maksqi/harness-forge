<script setup lang="ts">
// Send / Stop (docs/UI.md 7.7): one 32px ember circle in one slot. `ArrowUp` sends, a filled `Square` stops a
// running response; a spinner while sending waits for uploads. Disabled = muted colors, kept focusable with
// `aria-disabled` so its tooltip can explain why. Same size in every state (no layout shift).
// Phase 9 (ADR-042; C25 declares, W9.8 builds it; frozen from Gate P9-0b): `canQueue` (a run is active and the composer
// has content) adds the outline "Queue message" button (`composer-queue`, `ListPlus`, the label hidden below `sm`, 40px
// on coarse pointers) left of Stop, which emits `queue` (what the send key does while a response runs). Stop never
// moves; `disabled` / `pending` / `reason` then apply to the queue button.
import type { SendKey } from '@harness-forge/shared'
import { ArrowUpIcon, ListPlusIcon, Loader2Icon, SquareIcon } from '@lucide/vue'
import { computed } from 'vue'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import KbdCombo from '~/components/common/KbdCombo.vue'
import { testIds } from '~/utils/testids'
import { sendKeyCombo } from './send-key'

const props = withDefaults(defineProps<{
  /** A response is streaming (or submitted): show Stop. */
  running: boolean
  disabled?: boolean
  /** Sending waits for uploads. */
  pending?: boolean
  /** Why sending is disabled (tooltip). */
  reason?: string | null
  sendKey?: SendKey
  /** + Phase 9: while running, offer "Queue message" left of Stop (default false). */
  canQueue?: boolean
}>(), {
  disabled: false,
  pending: false,
  reason: null,
  sendKey: 'enter',
  canQueue: false,
})

const emit = defineEmits<{
  send: []
  stop: []
  /** + Phase 9: "Queue message" was clicked (what the send key does while a response runs). */
  queue: []
}>()

const inactive = computed(() => props.disabled || props.pending)

function onSend() {
  if (!inactive.value)
    emit('send')
}

function onQueue() {
  if (!inactive.value)
    emit('queue')
}

const showQueue = computed(() => props.running && props.canQueue)

const BUTTON_CLASS = 'relative inline-flex size-8 shrink-0 items-center justify-center rounded-full outline-none transition-colors duration-(--duration-fast) focus-visible:ring-[3px] focus-visible:ring-ring/50 after:absolute after:-inset-1 pointer-coarse:after:-inset-1.5'
</script>

<template>
  <Tooltip v-if="showQueue">
    <TooltipTrigger as-child>
      <button
        type="button"
        :data-testid="testIds.composerQueue"
        :aria-disabled="inactive || undefined"
        :aria-busy="pending || undefined"
        :class="cn(
          'inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-full border bg-background px-2.5 text-sm font-medium outline-none transition-colors duration-(--duration-fast)',
          'focus-visible:ring-[3px] focus-visible:ring-ring/50 max-sm:w-8 max-sm:px-0 pointer-coarse:h-10 pointer-coarse:max-sm:w-10',
          inactive ? 'cursor-not-allowed text-muted-foreground' : 'hover:bg-accent hover:text-accent-foreground',
        )"
        @click="onQueue"
      >
        <Loader2Icon v-if="pending" aria-hidden="true" class="size-4 animate-spin" />
        <ListPlusIcon v-else aria-hidden="true" class="size-4" />
        <span class="max-sm:sr-only">Queue message</span>
      </button>
    </TooltipTrigger>
    <TooltipContent side="top">
      <template v-if="disabled && reason">
        {{ reason }}
      </template>
      <template v-else-if="pending">
        Waiting for uploads…
      </template>
      <template v-else>
        Queue message <KbdCombo :keys="sendKeyCombo(sendKey)" class="max-lg:hidden pointer-coarse:hidden" />
      </template>
    </TooltipContent>
  </Tooltip>
  <Tooltip>
    <TooltipTrigger as-child>
      <button
        v-if="running"
        type="button"
        :data-testid="testIds.composerStop"
        aria-label="Stop"
        :class="cn(BUTTON_CLASS, 'bg-primary text-primary-foreground hover:bg-primary/85')"
        @click="emit('stop')"
      >
        <SquareIcon aria-hidden="true" class="size-3 fill-current" />
      </button>
      <button
        v-else
        type="button"
        :data-testid="testIds.composerSend"
        aria-label="Send message"
        :aria-disabled="disabled || undefined"
        :aria-busy="pending || undefined"
        :data-state="pending ? 'pending' : disabled ? 'disabled' : 'ready'"
        :class="cn(
          BUTTON_CLASS,
          disabled
            ? 'cursor-not-allowed bg-muted text-muted-foreground'
            : 'bg-primary text-primary-foreground hover:bg-primary/85',
          pending && 'cursor-progress',
        )"
        @click="onSend"
      >
        <Loader2Icon v-if="pending" aria-hidden="true" class="size-4 animate-spin" />
        <ArrowUpIcon v-else aria-hidden="true" class="size-4" :stroke-width="2.25" />
      </button>
    </TooltipTrigger>
    <TooltipContent side="top">
      <template v-if="running">
        Stop <KbdCombo keys="escape" class="max-lg:hidden pointer-coarse:hidden" />
      </template>
      <template v-else-if="disabled && reason">
        {{ reason }}
      </template>
      <template v-else-if="pending">
        Waiting for uploads…
      </template>
      <template v-else>
        Send <KbdCombo :keys="sendKeyCombo(sendKey)" class="max-lg:hidden pointer-coarse:hidden" />
      </template>
    </TooltipContent>
  </Tooltip>
</template>
