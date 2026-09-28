<script setup lang="ts">
// One transcript message (docs/UI.md 5.7, 7.1, 7.5, 7.16). User: attachments + a plain-text bubble on the right, Copy,
// Edit and Delete this version below (Edit turns the bubble into MessageEditor, with the message's attachments).
// Assistant: no bubble, parts in order (text, reasoning, tool rows with approval cards, files, galleries of generated
// images, sources, notices), placeholder tiles while an image turn has no image yet, the error of the message, then a
// fixed-height row with Copy (only with text), Read aloud (finished replies with text), Regenerate (every finished
// reply), Delete this version and the meta. The action row is always laid out (hidden while streaming, revealed on
// hover / focus, always shown on the last finished reply and while the reply is read aloud), so nothing moves when it
// appears. A message with versions (ADR-023) starts that row with the BranchSwitcher, which stays visible outside the
// hover fade; "Delete this version" asks ChatView for confirmation (ADR-030).
import type { HarnessUIMessage, MessageBranch } from '@harness-forge/shared'
import type { FileUIPart, TextUIPart } from 'ai'
import { isFileUIPart } from 'ai'
import { computed, ref } from 'vue'
import { cn } from '@/lib/utils'
import { useSpeechPlayer } from '~/composables/useSpeechPlayer'
import { testIds } from '~/utils/testids'
import BranchSwitcher from './BranchSwitcher.vue'
import { messageBlocks, messageText } from './chat-format'
import MessageActions from './MessageActions.vue'
import MessageEditor from './MessageEditor.vue'
import MessageMeta from './MessageMeta.vue'
import ErrorPart from './parts/ErrorPart.vue'
import FilePart from './parts/FilePart.vue'
import GeneratingImages from './parts/GeneratingImages.vue'
import ImageGallery from './parts/ImageGallery.vue'
import NoticePart from './parts/NoticePart.vue'
import ReasoningPart from './parts/ReasoningPart.vue'
import SourcesPart from './parts/SourcesPart.vue'
import TextPart from './parts/TextPart.vue'
import ToolPart from './parts/ToolPart.vue'
import ReadAloudButton from './ReadAloudButton.vue'
import SubmittedPlaceholder from './SubmittedPlaceholder.vue'
import UserMessageBubble from './UserMessageBubble.vue'

const props = withDefaults(defineProps<{
  message: HarnessUIMessage
  isLast: boolean
  /** This message is being streamed. */
  streaming: boolean
  showThinking: boolean
  /** A request is in flight in this chat (no edits, regenerations or deletions meanwhile). */
  busy?: boolean
  /** Live error of the last request (shown on the last assistant message; stored ones come from metadata). */
  error?: unknown
  /** The previous user message ran a `reply` command: the meta reads "Command reply". */
  commandReply?: boolean
  /** `ChatDetail.branches[message.id]`: the versions of this message; shows the BranchSwitcher. */
  branch?: MessageBranch | null
  /** A version switch (or a deletion) is in flight (the switcher is disabled). */
  switching?: boolean
}>(), {
  busy: false,
  commandReply: false,
  branch: null,
  switching: false,
})

const emit = defineEmits<{
  'regenerate': []
  /** The edited text and the files left in the editor (the full new set). */
  'edit': [text: string, files: FileUIPart[]]
  'approval': [response: { id: string, approved: boolean, toolName: string, alwaysAllow: boolean }]
  'retry': []
  /** The version chosen in the BranchSwitcher (a sibling of this message). */
  'select-version': [messageId: string]
  /** "Delete this version" was clicked; ChatView asks for confirmation. */
  'delete-version': []
}>()

const editing = ref(false)

/** Opens the editor on a user message (Edit button, ↑ in an empty composer). */
function startEdit() {
  if (props.message.role === 'user' && !props.busy)
    editing.value = true
}

defineExpose({ startEdit })

function onSave(text: string, files: FileUIPart[]) {
  editing.value = false
  emit('edit', text, files)
}

function selectVersion(messageId: string) {
  // eslint-disable-next-line vue/custom-event-name-casing -- contract name from docs/UI.md 10.4
  emit('select-version', messageId)
}

function deleteVersion() {
  // eslint-disable-next-line vue/custom-event-name-casing -- contract name from docs/UI.md 10.4
  emit('delete-version')
}

const blocks = computed(() => (props.message.role === 'assistant' ? messageBlocks(props.message.parts) : []))
const reasoningCount = computed(() => blocks.value.filter(block => block.kind === 'reasoning').length)
const displayError = computed(() => props.error ?? props.message.metadata?.error ?? null)
const status = computed(() => {
  if (props.streaming)
    return 'streaming'
  if (displayError.value)
    return 'error'
  return props.message.metadata?.aborted ? 'aborted' : 'done'
})

/** The files of a user message, for the editor. */
const fileParts = computed(() => props.message.parts.filter(isFileUIPart))

/** The text parts as markdown (Copy, Read aloud); '' for a reply of images only. */
const replyText = computed(() => messageText(props.message))
const hasText = computed(() => replyText.value.length > 0)
const copyText = () => replyText.value

/**
 * An image turn in flight whose images have not arrived yet: placeholder tiles (docs/UI.md 7.16). A finished, failed or
 * stopped turn keeps `metadata.image` without file parts, so those end the placeholders even before the stream closes.
 */
const generatingImages = computed(() => {
  const metadata = props.message.metadata
  if (!props.streaming || !metadata?.image || metadata.finishedAt !== undefined || metadata.error || metadata.aborted)
    return null
  if (props.message.parts.some(part => part.type === 'file'))
    return null
  return { n: metadata.image.n, aspectRatio: metadata.image.aspectRatio, startedAt: metadata.startedAt }
})

/** Final once the message stopped streaming, the part says so, or a later part exists. */
function isTextFinal(blockIndex: number, part: TextUIPart): boolean {
  return !props.streaming || part.state === 'done' || blockIndex < blocks.value.length - 1
}

/** Every finished reply can get a new version; older ones hide theirs through the transcript's `data-busy`. */
const canRegenerate = computed(() => !props.streaming && !props.busy)
const branchDisabled = computed(() => props.busy || props.switching)
/** A message with versions can lose one while nothing runs (ADR-030). */
const canDeleteVersion = computed(() => props.branch !== null && !props.busy && !props.switching)

const player = useSpeechPlayer()
/** This reply is being read aloud: its action row stays visible (docs/UI.md 7.18). */
const reading = computed(() => player.activeId.value === props.message.id && player.state.value !== 'idle')

const actionsClass = computed(() => {
  if (props.streaming)
    return 'invisible'
  if ((props.isLast && props.message.role === 'assistant') || reading.value)
    return ''
  return cn(
    'opacity-0 transition-opacity duration-(--duration-fast)',
    'group-hover/message:opacity-100 group-focus-within/message:opacity-100 pointer-coarse:opacity-100',
    // Read aloud pressed (loading or playing), also before the player state reaches this row.
    'has-[[data-testid=message-read-aloud][aria-pressed=true]]:opacity-100',
  )
})
</script>

<template>
  <div
    v-if="message.role === 'user'"
    :data-testid="testIds.messageUser"
    :data-message-id="message.id"
    data-status="done"
    class="group/message flex min-w-0 flex-col items-end gap-1"
  >
    <MessageEditor v-if="editing" :text="copyText()" :files="fileParts" @save="onSave" @cancel="editing = false" />
    <template v-else>
      <UserMessageBubble :message="message" />
      <div data-slot="message-action-row" class="flex h-7 max-w-full min-w-0 items-center justify-end gap-0.5 pointer-coarse:h-10">
        <BranchSwitcher
          v-if="branch"
          :siblings="branch.siblings"
          :index="branch.index"
          :disabled="branchDisabled"
          @select="selectVersion"
        />
        <MessageActions
          align="end"
          :class="actionsClass"
          :copy-text="copyText"
          :can-edit="!busy"
          :can-delete-version="canDeleteVersion"
          @edit="startEdit"
          @delete-version="deleteVersion"
        />
      </div>
    </template>
  </div>

  <div
    v-else-if="message.role === 'assistant'"
    :data-testid="testIds.messageAssistant"
    :data-message-id="message.id"
    :data-status="status"
    class="group/message flex min-w-0 flex-col gap-2"
  >
    <template v-for="(block, blockIndex) in blocks" :key="block.key">
      <TextPart
        v-if="block.kind === 'text'"
        :part="block.part"
        :final="isTextFinal(blockIndex, block.part)"
        class="font-reading"
      />
      <ReasoningPart
        v-else-if="block.kind === 'reasoning'"
        :part="block.part"
        :streaming="streaming"
        :show-thinking="showThinking"
        :duration-ms="reasoningCount === 1 ? message.metadata?.reasoningMs : undefined"
      />
      <ToolPart
        v-else-if="block.kind === 'tool'"
        :part="block.part"
        :streaming="streaming"
        :superseded="!isLast"
        @approval="emit('approval', $event)"
      />
      <ImageGallery v-else-if="block.kind === 'gallery'" :images="block.parts" :message-id="message.id" />
      <div v-else-if="block.kind === 'file'" class="flex">
        <FilePart :part="block.part" />
      </div>
      <SourcesPart v-else-if="block.kind === 'sources'" :parts="block.parts" />
      <NoticePart v-else-if="block.kind === 'notice'" :notice="block.notice" />
    </template>
    <GeneratingImages
      v-if="generatingImages"
      :n="generatingImages.n"
      :aspect-ratio="generatingImages.aspectRatio"
      :started-at="generatingImages.startedAt"
    />
    <SubmittedPlaceholder v-else-if="streaming && blocks.length === 0" />
    <ErrorPart v-if="displayError && !streaming" :error="displayError" @retry="emit('retry')" />
    <div data-slot="message-action-row" class="flex h-7 min-w-0 items-center gap-0.5 pointer-coarse:h-10">
      <BranchSwitcher
        v-if="branch"
        :siblings="branch.siblings"
        :index="branch.index"
        :disabled="branchDisabled"
        @select="selectVersion"
      />
      <MessageActions
        :class="cn('flex-1', actionsClass)"
        :copy-text="copyText"
        :can-copy="hasText"
        :can-regenerate="canRegenerate"
        :can-delete-version="canDeleteVersion"
        @regenerate="emit('regenerate')"
        @delete-version="deleteVersion"
      >
        <template v-if="!streaming && hasText" #after-copy>
          <ReadAloudButton :message-id="message.id" :markdown="replyText" />
        </template>
        <MessageMeta :metadata="message.metadata" :command-reply="commandReply" />
      </MessageActions>
    </div>
  </div>
</template>
