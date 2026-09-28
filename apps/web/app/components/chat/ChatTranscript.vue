<script setup lang="ts">
// The transcript column (docs/UI.md 5.7, 5.9, 7.6) on AiConversation (stick to bottom): opening jumps to the bottom
// at once, new content is followed only while the reader is near the bottom, scrolling up shows the round
// scroll-to-bottom pill 12px above the composer. Finished messages are memoized (v-memo): a request starting or
// ending re-renders only the last message; the Edit buttons of older user messages hide through the column's
// `data-busy` (CSS), so long transcripts do not re-render as a whole twice per reply. A long history renders its
// newest messages first and the older ones in batches right after (all at once when the reader scrolls up), so
// opening it never blocks the page for long. A request that failed before any reply shows its error on its own; a
// submitted request shows the "Thinking…" placeholder. A history that takes longer than a moment to arrive shows a
// skeleton (never for fast loads, so nothing flashes).
import type { HarnessUIMessage } from '@harness-forge/shared'
import type { ChatStatus } from 'ai'
import type { ToolApprovalDecision } from '~/composables/useChatSession'
import { usePreferredReducedMotion, useScroll } from '@vueuse/core'
import { computed, defineComponent, onBeforeUnmount, provide, ref, watch } from 'vue'
import { useStickToBottomContext } from 'vue-stick-to-bottom'
import AiConversation from '@/components/ai-elements/conversation/Conversation.vue'
import { Skeleton } from '@/components/ui/skeleton'
import { testIds } from '~/utils/testids'
import { TRANSCRIPT_SCROLL } from './chat-context'
import ChatMessage from './ChatMessage.vue'
import ErrorPart from './parts/ErrorPart.vue'
import SubmittedPlaceholder from './SubmittedPlaceholder.vue'
import TranscriptScrollButton from './TranscriptScrollButton.vue'

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

// ---------- loading ----------

/** Loads shorter than this never show the skeleton. */
const SKELETON_DELAY_MS = 300
const showSkeleton = ref(false)
let skeletonTimer: ReturnType<typeof setTimeout> | undefined
watch(() => props.loading, (loading) => {
  clearTimeout(skeletonTimer)
  showSkeleton.value = false
  if (loading) {
    skeletonTimer = setTimeout(() => {
      showSkeleton.value = true
    }, SKELETON_DELAY_MS)
  }
}, { immediate: true })
onBeforeUnmount(() => clearTimeout(skeletonTimer))

// ---------- progressive history ----------

/** Messages rendered at once when a history appears; older ones follow in batches of `HISTORY_BATCH`. */
const HISTORY_FIRST_BATCH = 40
const HISTORY_BATCH = 80
/** Index of the oldest rendered message while older ones are still pending (0 = everything is rendered). */
const renderFrom = ref(0)
let batchTimer: ReturnType<typeof setTimeout> | undefined

// Every message keeps its slot (a `display: contents` wrapper, empty until rendered), so the memoized slots of the
// rendered messages stay valid while older ones are added above them.
const renderStart = computed(() => Math.min(renderFrom.value, Math.max(0, props.messages.length - HISTORY_FIRST_BATCH)))

function renderOlder() {
  batchTimer = undefined
  renderFrom.value = Math.max(0, renderStart.value - HISTORY_BATCH)
  if (renderFrom.value > 0)
    batchTimer = setTimeout(renderOlder, 16)
  else
    settleLater()
}

/** The reader scrolled up before the history finished: render the rest now (content above must not keep moving). */
function renderAll() {
  if (renderStart.value === 0)
    return
  clearTimeout(batchTimer)
  batchTimer = undefined
  renderFrom.value = 0
  settleLater()
}

watch(() => props.loading, (loading) => {
  clearTimeout(batchTimer)
  batchTimer = undefined
  if (loading)
    return
  renderFrom.value = Math.max(0, props.messages.length - HISTORY_FIRST_BATCH)
  if (renderFrom.value > 0)
    batchTimer = setTimeout(renderOlder, 16)
}, { immediate: true })
onBeforeUnmount(() => clearTimeout(batchTimer))

// ---------- scrolling ----------

// Opening a chat jumps to the bottom at once, also while the history and its markdown render in batches; afterwards
// new content is followed smoothly (instantly with reduced motion).
const reducedMotion = usePreferredReducedMotion()
const settled = ref(false)
let settleTimer: ReturnType<typeof setTimeout> | undefined
function settleLater() {
  clearTimeout(settleTimer)
  settleTimer = setTimeout(() => {
    settled.value = true
  }, 800)
}
watch(() => props.loading, (loading) => {
  clearTimeout(settleTimer)
  if (!loading && renderFrom.value === 0)
    settleLater()
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
    watch(() => context.escapedFromLock.value, (escaped) => {
      if (escaped)
        renderAll()
    })
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
      :data-busy="busy ? 'true' : undefined"
      class="group/transcript hf-transcript mx-auto flex w-full max-w-3xl flex-col gap-(--message-gap) px-4 pt-6 pb-[calc(var(--hf-composer-h,8rem)+1.5rem)] md:px-6"
      :aria-busy="loading || undefined"
    >
      <template v-if="!loading">
        <div
          v-for="(message, index) in messages"
          :key="message.id"
          v-memo="[message, index >= renderStart, index === messages.length - 1, isStreaming(index), showThinking, index === messages.length - 1 && busy, errorFor(index)]"
          data-slot="transcript-message"
          class="contents"
        >
          <ChatMessage
            v-if="index >= renderStart"
            :ref="(instance: unknown) => setMessageRef(message.id, instance)"
            :message="message"
            :is-last="index === messages.length - 1"
            :streaming="isStreaming(index)"
            :show-thinking="showThinking"
            :busy="index === messages.length - 1 && busy"
            :error="errorFor(index)"
            :command-reply="isCommandReply(index)"
            @regenerate="emit('regenerate', message.id)"
            @edit="text => emit('edit', message.id, text)"
            @approval="decision => emit('approval', decision)"
            @retry="emit('retry')"
          />
        </div>
        <SubmittedPlaceholder v-if="showPlaceholder" />
        <div v-if="standaloneError && !busy" data-slot="request-error">
          <ErrorPart :error="standaloneError" @retry="emit('retry')" />
        </div>
      </template>
      <div
        v-else-if="showSkeleton"
        :data-testid="testIds.transcriptSkeleton"
        aria-hidden="true"
        class="flex flex-col gap-(--message-gap)"
      >
        <Skeleton class="h-10 w-2/5 self-end rounded-2xl" />
        <div class="flex flex-col gap-2.5">
          <Skeleton class="h-4 w-11/12" />
          <Skeleton class="h-4 w-4/5" />
          <Skeleton class="h-4 w-3/5" />
        </div>
        <Skeleton class="h-10 w-1/3 self-end rounded-2xl" />
        <div class="flex flex-col gap-2.5">
          <Skeleton class="h-4 w-5/6" />
          <Skeleton class="h-4 w-2/3" />
        </div>
      </div>
    </div>
    <TranscriptScrollButton
      :data-testid="testIds.scrollToBottom"
      class="bottom-[calc(var(--hf-composer-h,8rem)+12px)] z-10 size-8 bg-background shadow-sm pointer-coarse:size-10"
    />
  </AiConversation>
</template>
