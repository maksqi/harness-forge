<script setup lang="ts">
// User message (docs/UI.md 5.7, 7.1): attachments right-aligned above a `bg-muted rounded-2xl` bubble of plain text
// (not markdown, whitespace kept); a slash command shows its badge and the text as typed.
// Phase 10 (W10.11): never a bubble for the carrier of a turn the server started for finished background agents
// (`isTaskResultMessage`; ChatMessage renders its notes instead), so this renders nothing for one. The command badge
// gets the whole `metadata.command` (its source, model and tool limit, docs/UI.md 7.28); a shared message carries only
// the name.
import type { HarnessUIMessage } from '@harness-forge/shared'
import type { FileUIPart } from 'ai'
import { computed } from 'vue'
import { isTaskResultMessage } from './chat-format'
import CommandBadge from './parts/CommandBadge.vue'
import FilePart from './parts/FilePart.vue'

const props = defineProps<{ message: HarnessUIMessage }>()

const files = computed(() => props.message.parts.filter((part): part is FileUIPart => part.type === 'file'))
const text = computed(() => props.message.parts
  .flatMap(part => (part.type === 'text' ? [part.text] : []))
  .join('\n\n'))
const command = computed(() => props.message.metadata?.command ?? null)
const carrier = computed(() => isTaskResultMessage(props.message))
</script>

<template>
  <div v-if="!carrier" data-slot="user-message" class="flex max-w-[85%] min-w-0 flex-col items-end gap-1.5">
    <div v-if="files.length" class="flex flex-wrap justify-end gap-1.5">
      <FilePart v-for="(file, index) in files" :key="`${file.url}-${index}`" :part="file" />
    </div>
    <div
      v-if="text || command"
      class="min-w-0 rounded-2xl bg-muted px-4 py-2.5 break-words whitespace-pre-wrap text-foreground"
    >
      <CommandBadge v-if="command" :name="command.name" :command="command" class="mb-1.5 flex w-fit" />
      <span v-if="text">{{ text }}</span>
    </div>
  </div>
</template>
