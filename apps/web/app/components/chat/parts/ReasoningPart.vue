<script setup lang="ts">
// Reasoning part (docs/UI.md 7.1): one row, "Thinking… 4s" (shimmer, live seconds) while it streams, then "Thought
// for 12s" (metadata.reasoningMs when known, so it survives reloads; else the measured time; else "Thought").
// Collapsed unless Show thinking is on and never opened automatically; the body is markdown in a
// CollapsibleContent (AiReasoning without its auto open/close: isStreaming stays false). The row is the plain
// CollapsibleTrigger that AiReasoningTrigger wraps: that component statically imports its motion-v shimmer, which
// this row never shows (it has its own "Thinking…" label), so using it would ship motion-v with every chat.
import type { ReasoningUIPart } from 'ai'
import { ChevronRightIcon } from '@lucide/vue'
import { computed, inject, onBeforeUnmount, ref, watch } from 'vue'
import AiReasoning from '@/components/ai-elements/reasoning/Reasoning.vue'
import { CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import Markdown from '~/components/common/Markdown.vue'
import { testIds } from '~/utils/testids'
import { TRANSCRIPT_SCROLL } from '../chat-context'
import { wholeSeconds } from '../chat-format'

const props = defineProps<{
  part: ReasoningUIPart
  /** The message is streaming. */
  streaming: boolean
  showThinking: boolean
  /** Reasoning time of the message (`metadata.reasoningMs`), when it applies to this part. */
  durationMs?: number
}>()

const open = ref(props.showThinking)
watch(() => props.showThinking, (value) => {
  open.value = value
})
const scroll = inject(TRANSCRIPT_SCROLL, null)
watch(open, (isOpen) => {
  if (isOpen)
    scroll?.holdPosition()
})

const active = computed(() => props.streaming && props.part.state === 'streaming')

const startedAt = ref<number | null>(null)
const measuredMs = ref<number | null>(null)
const now = ref(Date.now())
let ticker: ReturnType<typeof setInterval> | undefined

function stopTicker() {
  if (ticker !== undefined) {
    clearInterval(ticker)
    ticker = undefined
  }
}

watch(active, (isActive) => {
  if (isActive) {
    startedAt.value ??= Date.now()
    now.value = Date.now()
    stopTicker()
    ticker = setInterval(() => {
      now.value = Date.now()
    }, 1000)
    return
  }
  stopTicker()
  if (startedAt.value !== null)
    measuredMs.value = Date.now() - startedAt.value
}, { immediate: true })

onBeforeUnmount(stopTicker)

const liveSeconds = computed(() => Math.floor(Math.max(0, now.value - (startedAt.value ?? now.value)) / 1000) + 1)
const doneLabel = computed(() => {
  const ms = props.durationMs ?? measuredMs.value
  return ms && ms > 0 ? `Thought for ${wholeSeconds(ms)}s` : 'Thought'
})
</script>

<template>
  <AiReasoning
    v-model:open="open"
    :is-streaming="false"
    :default-open="false"
    data-slot="reasoning-part"
    class="mb-0"
  >
    <div
      :data-testid="testIds.reasoningRow"
      :data-state="active ? 'streaming' : 'done'"
      :data-expanded="open ? 'true' : 'false'"
      class="flex h-(--row-height) items-center pointer-coarse:h-10"
    >
      <CollapsibleTrigger
        class="group/reasoning -mx-1.5 flex h-full w-[calc(100%+0.75rem)] items-center gap-2 rounded-md px-1.5 text-sm text-muted-foreground outline-none transition-colors duration-(--duration-fast) hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <ChevronRightIcon
          aria-hidden="true"
          class="size-3.5 shrink-0 transition-transform duration-(--duration-base) group-data-[state=open]/reasoning:rotate-90"
        />
        <span v-if="active" class="hf-shimmer-text tabular-nums">Thinking… {{ liveSeconds }}s</span>
        <span v-else class="tabular-nums">{{ doneLabel }}</span>
      </CollapsibleTrigger>
    </div>
    <CollapsibleContent
      class="overflow-hidden data-closed:animate-out data-closed:fade-out-0 data-open:animate-in data-open:fade-in-0"
    >
      <div class="mt-1 mb-2 border-l-2 border-border pl-3 text-sm text-muted-foreground">
        <Markdown :content="part.text" :final="!active" />
      </div>
    </CollapsibleContent>
  </AiReasoning>
</template>
