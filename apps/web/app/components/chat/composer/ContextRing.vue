<script setup lang="ts">
// Context ring (docs/UI.md 7.12): an 18px circular meter of the context used by the last assistant turn against
// the model's context window, inside the AI Elements `Context` hover card. Muted, warning from 80%, destructive from
// 95%. The card lists "42% of context used", "84K / 200K tokens", the input / output / reasoning / cache rows and
// the chat cost when known. Renders nothing without usage or a context window.
import type { MessageUsage } from '@harness-forge/shared'
import { computed } from 'vue'
import {
  Context as AiContext,
  ContextCacheUsage as AiContextCacheUsage,
  ContextContent as AiContextContent,
  ContextContentBody as AiContextContentBody,
  ContextContentFooter as AiContextContentFooter,
  ContextContentHeader as AiContextContentHeader,
  ContextInputUsage as AiContextInputUsage,
  ContextOutputUsage as AiContextOutputUsage,
  ContextReasoningUsage as AiContextReasoningUsage,
  ContextTrigger as AiContextTrigger,
} from '@/components/ai-elements/context'
import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'
import { formatTokenCount } from '~/components/common/format'
import { testIds } from '~/utils/testids'
import { contextUsage, formatUsd, toLanguageModelUsage } from './context-usage'

const props = withDefaults(defineProps<{
  usage?: MessageUsage | null
  contextWindow?: number | null
  chatCostUsd?: number | null
}>(), {
  usage: null,
  contextWindow: null,
  chatCostUsd: null,
})

const view = computed(() => contextUsage(props.usage, props.contextWindow))
const usageForRows = computed(() => (props.usage ? toLanguageModelUsage(props.usage) : undefined))
const cost = computed(() => (props.chatCostUsd == null ? '' : formatUsd(props.chatCostUsd)))

const RADIUS = 7
const CIRCUMFERENCE = 2 * Math.PI * RADIUS
const dashOffset = computed(() => CIRCUMFERENCE * (1 - (view.value?.percent ?? 0) / 100))

const LEVEL_CLASS = {
  normal: 'text-muted-foreground',
  warning: 'text-warning',
  danger: 'text-destructive',
} as const
</script>

<template>
  <AiContext v-if="view" :used-tokens="view.used" :max-tokens="view.max" :usage="usageForRows">
    <AiContextTrigger>
      <button
        type="button"
        :data-testid="testIds.contextRing"
        :data-value="view.percent"
        :data-level="view.level"
        :aria-label="`${view.percent}% of context used`"
        :class="cn(
          'inline-flex size-8 pointer-coarse:size-10 shrink-0 items-center justify-center rounded-full outline-none transition-colors duration-(--duration-fast) hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50',
          LEVEL_CLASS[view.level],
        )"
      >
        <svg aria-hidden="true" viewBox="0 0 18 18" class="size-[18px] -rotate-90">
          <circle cx="9" cy="9" :r="RADIUS" fill="none" stroke="currentColor" stroke-width="2" opacity="0.25" />
          <circle
            cx="9"
            cy="9"
            :r="RADIUS"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            :stroke-dasharray="CIRCUMFERENCE"
            :stroke-dashoffset="dashOffset"
          />
        </svg>
      </button>
    </AiContextTrigger>
    <AiContextContent side="top" align="end" class="w-64 rounded-xl">
      <AiContextContentHeader>
        <div class="flex items-baseline justify-between gap-3 text-xs">
          <p class="font-medium">
            {{ view.percent }}% of context used
          </p>
        </div>
        <p class="text-xs text-muted-foreground tabular-nums">
          {{ formatTokenCount(view.used) }} / {{ formatTokenCount(view.max) }} tokens
        </p>
        <Progress :model-value="view.percent" :class="cn('h-1.5', view.level !== 'normal' && '*:data-[slot=progress-indicator]:bg-current', LEVEL_CLASS[view.level])" />
      </AiContextContentHeader>
      <AiContextContentBody class="space-y-1.5 tabular-nums">
        <AiContextInputUsage />
        <AiContextOutputUsage />
        <AiContextReasoningUsage />
        <AiContextCacheUsage />
      </AiContextContentBody>
      <AiContextContentFooter v-if="cost">
        <span class="text-muted-foreground">Chat cost</span>
        <span class="tabular-nums">{{ cost }}</span>
      </AiContextContentFooter>
    </AiContextContent>
  </AiContext>
</template>
