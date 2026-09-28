<script setup lang="ts">
// Send / Stop (docs/UI.md 7.7): one 32px ember circle in one slot. `ArrowUp` sends, a filled `Square` stops a
// running response; a spinner while sending waits for uploads. Disabled = muted colors, kept focusable with
// `aria-disabled` so its tooltip can explain why. Same size in every state (no layout shift).
import type { SendKey } from '@harness-forge/shared'
import { ArrowUpIcon, Loader2Icon, SquareIcon } from '@lucide/vue'
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
}>(), {
  disabled: false,
  pending: false,
  reason: null,
  sendKey: 'enter',
})

const emit = defineEmits<{
  send: []
  stop: []
}>()

const inactive = computed(() => props.disabled || props.pending)

function onSend() {
  if (!inactive.value)
    emit('send')
}

const BUTTON_CLASS = 'relative inline-flex size-8 shrink-0 items-center justify-center rounded-full outline-none transition-colors duration-(--duration-fast) focus-visible:ring-[3px] focus-visible:ring-ring/50 after:absolute after:-inset-1 pointer-coarse:after:-inset-1.5'
</script>

<template>
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
