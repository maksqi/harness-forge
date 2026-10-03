<script setup lang="ts">
// Steer note (docs/UI.md 2.16, 7.26, 10.6, 14.2; ADR-042): a message the user queued while the agent worked, delivered
// at a step boundary and stored inside the reply as a `data-steer` part (ChatMessage renders it for block kind
// `steer`). Right-aligned inside the reply: its files as chips (like a user message's attachments), the text in a muted
// `bg-muted/70 rounded-2xl` bubble (plain text, whitespace kept, never Markdown) and the caption "You · while it
// worked". After a reload the note stays where it was delivered.
// Contract (frozen from Gate P9-0b): prop `steer`; root `steer-note` with `data-message-id` = the queued message id,
// `role="note"` with the sr-only prefix "You said while the agent worked:" (the visible caption is aria-hidden).
import type { SteerData } from '@harness-forge/shared'
import type { FileUIPart } from 'ai'
import { computed } from 'vue'
import { testIds } from '~/utils/testids'
import FilePart from '../parts/FilePart.vue'

const props = defineProps<{ steer: SteerData }>()

const text = computed(() => props.steer.parts.flatMap(part => (part.type === 'text' ? [part.text] : [])).join('\n\n'))
const files = computed(() => props.steer.parts.filter((part): part is FileUIPart => part.type === 'file'))
</script>

<template>
  <div
    :data-testid="testIds.steerNote"
    :data-message-id="steer.id"
    role="note"
    class="flex max-w-[85%] min-w-0 flex-col items-end gap-1 self-end"
  >
    <span class="sr-only">You said while the agent worked:</span>
    <div v-if="files.length" data-slot="steer-files" class="flex flex-wrap justify-end gap-1.5">
      <FilePart v-for="(file, index) in files" :key="`${file.url}-${index}`" :part="file" />
    </div>
    <p
      v-if="text"
      data-slot="steer-text"
      class="max-w-full min-w-0 rounded-2xl bg-muted/70 px-3 py-2 text-sm break-words whitespace-pre-wrap text-foreground"
    >
      <span>{{ text }}</span>
    </p>
    <p aria-hidden="true" class="text-xs text-muted-foreground">
      You · while it worked
    </p>
  </div>
</template>
