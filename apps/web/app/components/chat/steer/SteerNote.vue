<script setup lang="ts">
// Steer note (docs/UI.md 7.26, 10.6; ADR-042): a message the user queued while the agent worked, delivered at a step
// boundary and stored inside the reply as a `data-steer` part (ChatMessage renders it for block kind `steer`). Props and
// root test id frozen from Gate P9-0b (C25); W9.11 builds the note (right-aligned muted bubble, file chips, the caption
// "You · while it worked") behind them. Root `steer-note` with `data-message-id` = the queued message id; `role="note"`
// with the sr-only prefix "You said while the agent worked:".
import type { SteerData } from '@harness-forge/shared'
import { computed } from 'vue'
import { testIds } from '~/utils/testids'

const props = defineProps<{ steer: SteerData }>()

const text = computed(() => props.steer.parts.flatMap(part => (part.type === 'text' ? [part.text] : [])).join('\n\n'))
</script>

<template>
  <div
    :data-testid="testIds.steerNote"
    :data-message-id="steer.id"
    role="note"
    class="max-w-[85%] self-end rounded-2xl bg-muted/70 px-3 py-2 text-sm whitespace-pre-wrap"
  >
    <span class="sr-only">You said while the agent worked:</span>
    {{ text }}
  </div>
</template>
