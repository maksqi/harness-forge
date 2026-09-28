<script setup lang="ts">
// One transcript message (docs/UI.md 5.7, 7.1, 7.5). User: attachments + a plain-text bubble on the right, Copy and
// Edit below (Edit turns the bubble into MessageEditor). Assistant: no bubble, parts in order (text, reasoning, tool
// rows with approval cards, files, sources, notices), the error of the message, then a fixed-height row with Copy,
// Regenerate (every finished reply) and the meta. The action row is always laid out (hidden while streaming, revealed
// on hover / focus, always shown on the last finished reply), so nothing moves when it appears. A message with
// versions (ADR-023) starts that row with the BranchSwitcher, which stays visible outside the hover fade.
import type { HarnessUIMessage, MessageBranch } from '@harness-forge/shared'
import type { TextUIPart } from 'ai'
import { computed, ref } from 'vue'
import { cn } from '@/lib/utils'
import { testIds } from '~/utils/testids'
import BranchSwitcher from './BranchSwitcher.vue'
import { messageBlocks, messageText } from './chat-format'
import MessageActions from './MessageActions.vue'
import MessageEditor from './MessageEditor.vue'
import MessageMeta from './MessageMeta.vue'
import ErrorPart from './parts/ErrorPart.vue'
import FilePart from './parts/FilePart.vue'
import NoticePart from './parts/NoticePart.vue'
import ReasoningPart from './parts/ReasoningPart.vue'
import SourcesPart from './parts/SourcesPart.vue'
import TextPart from './parts/TextPart.vue'
import ToolPart from './parts/ToolPart.vue'
import SubmittedPlaceholder from './SubmittedPlaceholder.vue'
import UserMessageBubble from './UserMessageBubble.vue'

const props = withDefaults(defineProps<{
  message: HarnessUIMessage
  isLast: boolean
  /** This message is being streamed. */
  streaming: boolean
  showThinking: boolean
  /** A request is in flight in this chat (no edits or regenerations meanwhile). */
  busy?: boolean
  /** Live error of the last request (shown on the last assistant message; stored ones come from metadata). */
  error?: unknown
  /** The previous user message ran a `reply` command: the meta reads "Command reply". */
  commandReply?: boolean
  /** `ChatDetail.branches[message.id]`: the versions of this message; shows the BranchSwitcher. */
  branch?: MessageBranch | null
  /** A version switch is in flight (the switcher is disabled). */
  switching?: boolean
}>(), {
  busy: false,
  commandReply: false,
  branch: null,
  switching: false,
})

const emit = defineEmits<{
  'regenerate': []
  'edit': [text: string]
  'approval': [response: { id: string, approved: boolean, toolName: string, alwaysAllow: boolean }]
  'retry': []
  /** The version chosen in the BranchSwitcher (a sibling of this message). */
  'select-version': [messageId: string]
}>()

const editing = ref(false)

/** Opens the editor on a user message (Edit button, ↑ in an empty composer). */
function startEdit() {
  if (props.message.role === 'user' && !props.busy)
    editing.value = true
}

defineExpose({ startEdit })

function onSave(text: string) {
  editing.value = false
  emit('edit', text)
}

function selectVersion(messageId: string) {
  // eslint-disable-next-line vue/custom-event-name-casing -- contract name from docs/UI.md 10.4
  emit('select-version', messageId)
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

/** Final once the message stopped streaming, the part says so, or a later part exists. */
function isTextFinal(blockIndex: number, part: TextUIPart): boolean {
  return !props.streaming || part.state === 'done' || blockIndex < blocks.value.length - 1
}

const copyText = () => messageText(props.message)

/** Every finished reply can get a new version; older ones hide theirs through the transcript's `data-busy`. */
const canRegenerate = computed(() => !props.streaming && !props.busy)
const branchDisabled = computed(() => props.busy || props.switching)

const actionsClass = computed(() => {
  if (props.streaming)
    return 'invisible'
  if (props.isLast && props.message.role === 'assistant')
    return ''
  return cn(
    'opacity-0 transition-opacity duration-(--duration-fast)',
    'group-hover/message:opacity-100 group-focus-within/message:opacity-100 pointer-coarse:opacity-100',
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
    <MessageEditor v-if="editing" :text="copyText()" @save="onSave" @cancel="editing = false" />
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
        <MessageActions align="end" :class="actionsClass" :copy-text="copyText" :can-edit="!busy" @edit="startEdit" />
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
      <div v-else-if="block.kind === 'file'" class="flex">
        <FilePart :part="block.part" />
      </div>
      <SourcesPart v-else-if="block.kind === 'sources'" :parts="block.parts" />
      <NoticePart v-else-if="block.kind === 'notice'" :notice="block.notice" />
    </template>
    <SubmittedPlaceholder v-if="streaming && blocks.length === 0" />
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
        :can-regenerate="canRegenerate"
        @regenerate="emit('regenerate')"
      >
        <MessageMeta :metadata="message.metadata" :command-reply="commandReply" />
      </MessageActions>
    </div>
  </div>
</template>
