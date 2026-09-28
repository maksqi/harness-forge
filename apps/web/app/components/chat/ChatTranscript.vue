<script setup lang="ts">
// The transcript column (docs/UI.md 5.7, 5.9, 7.6) on AiConversation (stick to bottom): opening jumps to the bottom
// at once, new content is followed only while the reader is near the bottom, scrolling up shows the round
// scroll-to-bottom pill 12px above the composer. Finished messages are memoized (v-memo). A request that failed
// before any reply shows its error on its own; a submitted request shows the "Thinking…" placeholder.
import type { HarnessUIMessage } from '@harness-forge/shared'
import type { ChatStatus } from 'ai'
import type { ToolApprovalDecision } from '~/composables/useChatSession'
import { usePreferredReducedMotion, useScroll } from '@vueuse/core'
import { computed, defineComponent, onBeforeUnmount, provide, ref, watch } from 'vue'
import { useStickToBottomContext } from 'vue-stick-to-bottom'
import {
  Conversation as AiConversation,
  ConversationScrollButton as AiConversationScrollButton,
} from '@/components/ai-elements/conversation'
import { testIds } from '~/utils/testids'
import { TRANSCRIPT_SCROLL } from './chat-context'
import ChatMessage from './ChatMessage.vue'
import ErrorPart from './parts/ErrorPart.vue'
import SubmittedPlaceholder from './SubmittedPlaceholder.vue'

const props = withDefaults(defineProps<{
  messages: HarnessUIMessage[]
  status: ChatStatus
  error?: unknown
  showThinking: boolean
  /** Hide the messages until the history arrived (the column keeps its layout). */
  loading?: boolean
}>(), {
  loading: false,
})

const emit = defineEmits<{
  'regenerate': [messageId: string]
  'edit': [messageId: string, text: string]
  'approval': [decision: ToolApprovalDecision]
  'retry': []
  /** The transcript is scrolled away from the top (the header shows its border). */
  'update:scrolled': [value: boolean]
}>()

const busy = computed(() => props.status === 'submitted' || props.status === 'streaming')
const lastMessage = computed(() => props.messages.at(-1))
const lastIsAssistant = computed(() => lastMessage.value?.role === 'assistant')
/** An error without a reply to attach it to (the request failed before streaming). */
const standaloneError = computed(() => (props.error && !lastIsAssistant.value ? props.error : null))
const showPlaceholder = computed(() => props.status === 'submitted' && !lastIsAssistant.value)

function isStreaming(index: number): boolean {
  return busy.value && index === props.messages.length - 1 && props.messages[index]?.role === 'assistant'
}

function errorFor(index: number): unknown {
  return props.error && index === props.messages.length - 1 && props.messages[index]?.role === 'assistant' ? props.error : null
}

function isCommandReply(index: number): boolean {
  const previous = props.messages[index - 1]
  return props.messages[index]?.role === 'assistant' && previous?.role === 'user' && previous.metadata?.command?.type === 'reply'
}

// ---------- scrolling ----------

// Opening a chat jumps to the bottom at once, also while markdown renders in batches; afterwards new content is
// followed smoothly (instantly with reduced motion).
const reducedMotion = usePreferredReducedMotion()
const settled = ref(false)
let settleTimer: ReturnType<typeof setTimeout> | undefined
watch(() => props.loading, (loading) => {
  clearTimeout(settleTimer)
  if (!loading) {
    settleTimer = setTimeout(() => {
      settled.value = true
    }, 800)
  }
}, { immediate: true })
onBeforeUnmount(() => clearTimeout(settleTimer))
const resizeAnimation = computed(() => (!settled.value || reducedMotion.value === 'reduce' ? 'instant' : undefined))

// The stick-to-bottom context lives inside AiConversation; this bridge hands it to the transcript.

interface ScrollControls {
  scrollToBottom: (behavior?: 'instant' | 'smooth') => void
  holdPosition: () => void
}

const controls = ref<ScrollControls | null>(null)

const ScrollBridge = defineComponent({
  name: 'TranscriptScrollBridge',
  setup() {
    const context = useStickToBottomContext()
    const { y } = useScroll(context.scrollRef)
    watch(() => y.value > 0, scrolled => emit('update:scrolled', scrolled), { immediate: true })
    controls.value = {
      scrollToBottom: behavior => void context.scrollToBottom(
        behavior === 'instant' || reducedMotion.value === 'reduce' ? 'instant' : 'smooth',
      ),
      holdPosition: () => context.stopScroll(),
    }
    return () => null
  },
})

provide(TRANSCRIPT_SCROLL, { holdPosition: () => controls.value?.holdPosition() })

// ---------- message editor (↑ in an empty composer) ----------

const messageRefs = new Map<string, { startEdit: () => void }>()

function setMessageRef(id: string, instance: unknown) {
  if (instance && typeof (instance as { startEdit?: unknown }).startEdit === 'function')
    messageRefs.set(id, instance as { startEdit: () => void })
  else
    messageRefs.delete(id)
}

/** Opens the editor on the last user message; false when there is none. */
function editLastUserMessage(): boolean {
  const last = [...props.messages].reverse().find(message => message.role === 'user')
  const target = last ? messageRefs.get(last.id) : undefined
  target?.startEdit()
  return !!target
}

defineExpose({
  editLastUserMessage,
  scrollToBottom: (behavior?: 'instant' | 'smooth') => controls.value?.scrollToBottom(behavior),
})
</script>

<template>
  <AiConversation
    initial="instant"
    :resize="resizeAnimation"
    aria-label="Transcript"
    aria-live="off"
    :data-testid="testIds.transcript"
    class="min-h-0 flex-1"
  >
    <ScrollBridge />
    <div
      class="hf-transcript mx-auto flex w-full max-w-3xl flex-col gap-(--message-gap) px-4 pt-6 pb-[calc(var(--hf-composer-h,8rem)+1.5rem)] md:px-6"
      :aria-busy="loading || undefined"
    >
      <template v-if="!loading">
        <ChatMessage
          v-for="(message, index) in messages"
          :key="message.id"
          :ref="(instance: unknown) => setMessageRef(message.id, instance)"
          v-memo="[message, index === messages.length - 1, isStreaming(index), showThinking, busy, errorFor(index)]"
          :message="message"
          :is-last="index === messages.length - 1"
          :streaming="isStreaming(index)"
          :show-thinking="showThinking"
          :busy="busy"
          :error="errorFor(index)"
          :command-reply="isCommandReply(index)"
          @regenerate="emit('regenerate', message.id)"
          @edit="text => emit('edit', message.id, text)"
          @approval="decision => emit('approval', decision)"
          @retry="emit('retry')"
        />
        <SubmittedPlaceholder v-if="showPlaceholder" />
        <div v-if="standaloneError && !busy" data-slot="request-error">
          <ErrorPart :error="standaloneError" @retry="emit('retry')" />
        </div>
      </template>
    </div>
    <AiConversationScrollButton
      :data-testid="testIds.scrollToBottom"
      class="bottom-[calc(var(--hf-composer-h,8rem)+12px)] z-10 size-8 bg-background shadow-sm"
    />
  </AiConversation>
</template>
