<script setup lang="ts">
// Meta text of an assistant message (docs/UI.md 7.5): model · duration · "Stopped" · "Max tokens reached"; hovering
// shows tokens, cost and the start time. A `reply` command answer shows "Command reply" instead of the model. An image
// turn (`metadata.image`, ADR-028) adds the line "2 images · 16:9 · edited 1 image" and labels its cost "Estimated
// cost" (image prices are estimates).
import type { MessageMetadata } from '@harness-forge/shared'
import { computed } from 'vue'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import ModelLabel from '~/components/providers/ModelLabel.vue'
import { testIds } from '~/utils/testids'
import { formatCost, formatDuration, formatImageTurn, formatTokens } from './chat-format'

const props = defineProps<{
  metadata?: MessageMetadata
  commandReply?: boolean
}>()

const duration = computed(() => formatDuration(props.metadata?.durationMs))
const stopped = computed(() => props.metadata?.aborted === true)
const maxTokens = computed(() => props.metadata?.finishReason === 'length')
const imageLine = computed(() => (props.metadata?.image ? formatImageTurn(props.metadata.image) : ''))

const rows = computed(() => {
  const usage = props.metadata?.usage
  const list: Array<{ label: string, value: string }> = []
  const add = (label: string, value: string) => {
    if (value)
      list.push({ label, value })
  }
  add('Input tokens', formatTokens(usage?.inputTokens))
  add('Output tokens', formatTokens(usage?.outputTokens))
  add('Reasoning tokens', formatTokens(usage?.reasoningTokens))
  add('Cache read tokens', formatTokens(usage?.cacheReadTokens))
  add('Cache write tokens', formatTokens(usage?.cacheWriteTokens))
  add(props.metadata?.image ? 'Estimated cost' : 'Cost', formatCost(props.metadata?.costUsd))
  if (props.metadata?.startedAt)
    add('Started', new Date(props.metadata.startedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' }))
  return list
})
</script>

<template>
  <HoverCard v-if="metadata || commandReply" :open-delay="400" :close-delay="100">
    <HoverCardTrigger as-child>
      <span
        :data-testid="testIds.messageMeta"
        tabindex="0"
        class="ml-1.5 inline-flex min-w-0 items-center gap-1.5 rounded-sm text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <span v-if="commandReply">Command reply</span>
        <ModelLabel v-else-if="metadata?.modelRef" :model-ref="metadata.modelRef" size="sm" />
        <template v-if="duration">
          <span aria-hidden="true">·</span>
          <span class="tabular-nums">{{ duration }}</span>
        </template>
        <template v-if="stopped">
          <span aria-hidden="true">·</span>
          <span>Stopped</span>
        </template>
        <template v-if="maxTokens">
          <span aria-hidden="true">·</span>
          <span>Max tokens reached</span>
        </template>
      </span>
    </HoverCardTrigger>
    <HoverCardContent v-if="rows.length || imageLine" align="start" class="w-60 p-3">
      <p v-if="imageLine" data-slot="message-meta-images" class="text-xs" :class="{ 'mb-2': rows.length > 0 }">
        {{ imageLine }}
      </p>
      <dl v-if="rows.length" class="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-xs">
        <template v-for="row in rows" :key="row.label">
          <dt class="text-muted-foreground">
            {{ row.label }}
          </dt>
          <dd class="text-right tabular-nums">
            {{ row.value }}
          </dd>
        </template>
      </dl>
    </HoverCardContent>
  </HoverCard>
</template>
