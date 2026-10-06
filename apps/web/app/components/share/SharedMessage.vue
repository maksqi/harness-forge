<script setup lang="ts">
// One message of a shared chat (docs/UI.md 7.15), rendered with the chat's own part components and nothing that reads
// a store: a user message is the transcript's bubble (attachments, command badge, plain text); an assistant message
// shows its parts in order (markdown text, collapsed reasoning, ShareToolRow, files, consecutive images as one
// ImageGallery with its lightbox and Download link, merged sources), then the model id (muted mono, not the
// store-backed ModelLabel) and "Stopped" or "This reply failed." (error details are never shared). No actions, version
// switchers or status dots.
// Phase 9: a steer arrives as its own user message (the server splits the reply there) and reads as an ordinary user
// bubble; compaction markers never reach a snapshot; the agent tools render through ShareToolRow (task, todo and plan
// bodies when tool details are shared).
// Phase 11: hook records never reach a snapshot (no notes, no carriers; a hook denial reads "Denied").
import type { ShareMessage } from '@harness-forge/shared'
import { CircleAlertIcon } from '@lucide/vue'
import { computed } from 'vue'
import FilePart from '~/components/chat/parts/FilePart.vue'
import ImageGallery from '~/components/chat/parts/ImageGallery.vue'
import ReasoningPart from '~/components/chat/parts/ReasoningPart.vue'
import SourcesPart from '~/components/chat/parts/SourcesPart.vue'
import TextPart from '~/components/chat/parts/TextPart.vue'
import UserMessageBubble from '~/components/chat/UserMessageBubble.vue'
import { testIds } from '~/utils/testids'
import { modelIdOf, shareMessageBlocks, toUserMessage } from './share-view'
import ShareToolRow from './ShareToolRow.vue'

const props = defineProps<{
  message: ShareMessage
  /** Position in the snapshot (messages carry no ids). */
  index: number
}>()

const status = computed(() => props.message.status === 'failed' || props.message.status === 'stopped' ? props.message.status : 'done')
/** Snapshot messages carry no ids: the key of this one (its gallery's data-message-id). */
const messageKey = computed(() => `share-message-${props.index}`)
const userMessage = computed(() => (props.message.role === 'user' ? toUserMessage(props.message, messageKey.value) : null))
const blocks = computed(() => (props.message.role === 'assistant' ? shareMessageBlocks(props.message.parts) : []))
const modelId = computed(() => (props.message.modelRef ? modelIdOf(props.message.modelRef) : null))
</script>

<template>
  <article
    v-if="userMessage"
    :data-testid="testIds.shareMessage"
    data-role="user"
    :data-status="status"
    aria-label="User"
    class="flex min-w-0 flex-col items-end"
  >
    <UserMessageBubble :message="userMessage" />
  </article>

  <article
    v-else
    :data-testid="testIds.shareMessage"
    data-role="assistant"
    :data-status="status"
    aria-label="Assistant"
    class="flex min-w-0 flex-col gap-2"
  >
    <template v-for="block in blocks" :key="block.key">
      <TextPart v-if="block.kind === 'text'" :part="block.part" :final="true" class="font-reading" />
      <ReasoningPart
        v-else-if="block.kind === 'reasoning'"
        :part="block.part"
        :streaming="false"
        :show-thinking="false"
      />
      <ShareToolRow v-else-if="block.kind === 'tool'" :part="block.part" />
      <div v-else-if="block.kind === 'file'" class="flex">
        <FilePart :part="block.part" />
      </div>
      <ImageGallery v-else-if="block.kind === 'gallery'" :images="block.parts" :message-id="messageKey" />
      <SourcesPart v-else-if="block.kind === 'sources'" :parts="block.parts" />
    </template>
    <p
      v-if="status === 'failed'"
      class="flex items-center gap-1.5 text-sm text-muted-foreground"
    >
      <CircleAlertIcon aria-hidden="true" class="size-3.5 shrink-0 text-destructive" />
      This reply failed.
    </p>
    <p
      v-if="modelId || status === 'stopped'"
      data-slot="share-message-meta"
      class="min-w-0 truncate text-xs text-muted-foreground"
    >
      <span v-if="modelId" class="font-mono">{{ modelId }}</span>
      <template v-if="modelId && status === 'stopped'">
        {{ ' · ' }}
      </template>
      <span v-if="status === 'stopped'">Stopped</span>
    </p>
  </article>
</template>
