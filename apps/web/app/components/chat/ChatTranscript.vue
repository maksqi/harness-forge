<script setup lang="ts">
// The transcript column (docs/UI.md 5.7, 5.9, 7.6) on AiConversation (stick to bottom): opening jumps to the bottom
// at once, new content is followed only while the reader is near the bottom, scrolling up shows the round
// scroll-to-bottom pill 12px above the composer. Finished messages are memoized (v-memo): a request starting or
// ending re-renders only the last message; the Edit and Regenerate buttons of older messages hide through the
// column's `data-busy` (CSS), so long transcripts do not re-render as a whole twice per reply. A long history
// renders its newest messages first and the older ones in batches right after (all at once when the reader scrolls
// up), so opening it never blocks the page for long. A request that failed before any reply shows its error on its
// own; a submitted request shows the "Thinking…" placeholder. A history that takes longer than a moment to arrive
// shows a skeleton (never for fast loads, so nothing flashes). Messages with versions (`branches`, ADR-023) show a
// switcher and re-render when a request or a switch starts or ends (it disables them); after a switch, focus moves
// to the same control of the new version's switcher (docs/UI.md 14.1). "Delete this version" (ADR-030) is re-emitted
// with the message id; ChatView confirms it and uses the exposed focus helpers afterwards.
// Phase 8 (C20 declares, W8.9 implements; frozen from Gate P8-0b): "Rewind files to here" is re-emitted as `rewind`
// with the message id (ChatView opens the RewindDialog); `startEdit(id)` opens the editor on a user message ("Restore
// files and edit") and `focusRewind(id)` puts focus back on its rewind button. In a project chat (`projectId`) a user
// message gets the button when a finished `write_file` / `edit_file` call follows it on the shown path: one backwards
// pass computes the set (`rewindable`, part of each row's v-memo); while a reply runs the button hides like Edit.
// Phase 9 (C25 declares, W9.11 implements; frozen from Gate P9-0b): `compactionLayout(messages).dimmed` gives each row
// its `compacted` flag (part of the row's v-memo); `activity` (the session's transient activity, from ChatView) goes to
// the submitted placeholder and the streaming last row ("Compacting conversation…"). The dividers render inside
// ChatMessage at their part's position. A `task` call (a sub-agent) whose steps hold a done `write_file` / `edit_file`
// counts as an agent edit for "Rewind files to here" (its writes are journaled under the reply, ADR-043).
// Phase 10 (ADR-046; W10.11): a carrier message (`isTaskResultMessage`, the turn the server started for finished
// background agents) is never edited (↑ edits the last message the user wrote) and never offers a rewind. A background
// agent's writes are journaled under the reply that launched it, so a delivered result on the shown path whose steps
// hold a done `write_file` / `edit_file` counts as an edit of that reply.
// Phase 11 (ADR-048; C39 widens the prop, W11.12 owns the rows; frozen from Gate P11-0b): `activity` widens to
// 'compacting' | 'hooks' | null ('hooks': command hooks of a message-level event run, "Running hooks…"; the per-tool
// line comes through the HOOK_ACTIVITY injection because the rows are `v-memo`ed); a hook carrier
// (`isHookCarrierMessage`, the turn the server started after a Stop hook blocked) is never edited and never offers a
// rewind, like a background agent carrier.
import type { HarnessUIMessage, MessageBranch } from '@harness-forge/shared'
import type { ChatStatus, FileUIPart } from 'ai'
import type { ToolApprovalDecision } from '~/composables/useChatSession'
import { usePreferredReducedMotion, useScroll } from '@vueuse/core'
import { isToolUIPart } from 'ai'
import { computed, defineComponent, onBeforeUnmount, provide, ref, useTemplateRef, watch } from 'vue'
import { useStickToBottomContext } from 'vue-stick-to-bottom'
import AiConversation from '@/components/ai-elements/conversation/Conversation.vue'
import { Skeleton } from '@/components/ui/skeleton'
import { testIds } from '~/utils/testids'
import { TRANSCRIPT_SCROLL } from './chat-context'
import { isTaskResultMessage, TASK_TOOL_NAME, taskResultsOf, toolNameOf } from './chat-format'
import ChatMessage from './ChatMessage.vue'
import { compactionLayout } from './compaction/compaction'
import { isHookCarrierMessage } from './hooks/hook-notes'
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
  /** `ChatDetail.branches` of the shown path: the versions of the messages that have more than one. */
  branches?: Record<string, MessageBranch>
  /** A version switch is in flight. */
  switching?: boolean
  /** + Phase 8: the chat's project; null = none (no "Rewind files to here"). */
  projectId?: string | null
  /**
   * + Phase 9 (ADR-040): the session's transient activity (`session.activity`): 'compacting' while a summary is written
   * (the submitted placeholder and the streaming last row say "Compacting conversation…"); + Phase 11: 'hooks' while
   * command hooks run ("Running hooks…"); default null.
   */
  activity?: 'compacting' | 'hooks' | null
}>(), {
  loading: false,
  branches: () => ({}),
  switching: false,
  projectId: null,
  activity: null,
})

const emit = defineEmits<{
  'regenerate': [messageId: string]
  /** A new version of a user message: its text and the full new set of files. */
  'edit': [messageId: string, text: string, files: FileUIPart[]]
  'approval': [decision: ToolApprovalDecision]
  /** Retry of the last request (the failed last reply, or a request that failed before any reply). */
  'retry': []
  /** Show another version of a message (a sibling of a shown message). */
  'select-version': [messageId: string]
  /** "Delete this version" was clicked on a shown message (ChatView asks for confirmation). */
  'delete-version': [messageId: string]
  /** + Phase 8: "Rewind files to here" was clicked on a user message (ChatView opens the RewindDialog). */
  'rewind': [messageId: string]
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

/** + Phase 9: the activity of a row: only the streaming last reply shows it. */
function activityFor(index: number): 'compacting' | 'hooks' | null {
  return isStreaming(index) ? props.activity : null
}

function errorFor(index: number): unknown {
  return props.error && index === props.messages.length - 1 && props.messages[index]?.role === 'assistant' ? props.error : null
}

function isCommandReply(index: number): boolean {
  const previous = props.messages[index - 1]
  return props.messages[index]?.role === 'assistant' && previous?.role === 'user' && previous.metadata?.command?.type === 'reply'
}

/**
 * The `busy` prop of a row. Older rows without versions get false (their Edit / Regenerate hide through the column's
 * `data-busy`), so a request starting or ending re-renders only the last row and the rows with a switcher.
 */
function isBusyRow(index: number, message: HarnessUIMessage): boolean {
  return busy.value && (index === props.messages.length - 1 || props.branches[message.id] !== undefined)
}

/** The Retry of a stored error: the last message retries the last request, an older reply gets a new version. */
function onRetry(messageId: string) {
  if (props.messages.at(-1)?.id === messageId)
    emit('retry')
  else
    emit('regenerate', messageId)
}

// ---------- versions ----------

const column = useTemplateRef<HTMLElement>('column')
const BRANCH_CONTROLS = [testIds.messageBranchPrevious, testIds.messageBranchNext] as const
/** The switcher control that had focus when a version was chosen: it gets focus again on the new version. */
let focusAfterSwitch: { messageId: string, control: string } | null = null

function onSelectVersion(messageId: string) {
  const active = typeof document === 'undefined' ? null : document.activeElement
  const control = active instanceof HTMLElement ? active.dataset.testid : undefined
  focusAfterSwitch = control && (BRANCH_CONTROLS as readonly string[]).includes(control) ? { messageId, control } : null
  // eslint-disable-next-line vue/custom-event-name-casing -- contract name from docs/UI.md 10.4
  emit('select-version', messageId)
}

// Runs after the DOM shows the new path: the old switcher is gone with its message, the new one is rendered.
watch([() => props.switching, () => props.messages], ([switching]) => {
  const target = focusAfterSwitch
  if (switching || !target)
    return
  focusAfterSwitch = null
  const switcher = [...(column.value?.querySelectorAll<HTMLElement>(`[data-testid="${testIds.messageBranch}"]`) ?? [])]
    .find(element => element.dataset.messageId === target.messageId)
  switcher?.querySelector<HTMLElement>(`[data-testid="${target.control}"]`)?.focus()
}, { flush: 'post' })

function onDeleteVersion(messageId: string) {
  // eslint-disable-next-line vue/custom-event-name-casing -- contract name from docs/UI.md 10.4
  emit('delete-version', messageId)
}

/** The rendered row of a shown message, or null. */
function messageElement(messageId: string): HTMLElement | null {
  const rows = column.value?.querySelectorAll<HTMLElement>(`[data-testid="${testIds.messageUser}"], [data-testid="${testIds.messageAssistant}"]`)
  return [...(rows ?? [])].find(row => row.dataset.messageId === messageId) ?? null
}

/**
 * After a version was deleted (docs/UI.md 7.5, 14.1): focus on the switcher of the version now shown (its first enabled
 * control), or on its Copy button when no other version is left (else the first button of its action row). False when
 * the message is not rendered.
 */
function focusShownVersion(messageId: string): boolean {
  const row = messageElement(messageId)
  if (!row)
    return false
  const controls = [...row.querySelectorAll<HTMLElement>(`[data-testid="${testIds.messageBranch}"] button`)]
  const target = controls.find(control => control.getAttribute('aria-disabled') !== 'true')
    ?? controls[0]
    ?? row.querySelector<HTMLElement>(`[data-testid="${testIds.messageCopy}"]`)
    ?? row.querySelector<HTMLElement>('[data-slot="message-action-row"] button')
  target?.focus()
  return target !== null && target !== undefined
}

/** A canceled or failed deletion: focus back on "Delete this version" of that message. False when it is not shown. */
function focusDeleteVersion(messageId: string): boolean {
  const button = messageElement(messageId)?.querySelector<HTMLElement>(`[data-testid="${testIds.messageDeleteVersion}"]`)
  button?.focus()
  return !!button
}

// ---------- rewind (Phase 8) ----------

/** Agent edits that can be rewound: a finished `write_file` / `edit_file` call (docs/UI.md 7.22). */
const REWINDABLE_TOOLS: ReadonlySet<string> = new Set(['write_file', 'edit_file'])

/**
 * + Phase 9: a sub-agent's output (final or a preliminary snapshot) whose kept steps hold a done `write_file` /
 * `edit_file` call (`TaskOutput.steps`; a light structural check, run on every chunk of the streaming reply).
 */
function taskWroteFiles(output: unknown): boolean {
  const steps = typeof output === 'object' && output !== null ? (output as { steps?: unknown }).steps : undefined
  if (!Array.isArray(steps))
    return false
  return steps.some((step) => {
    if (typeof step !== 'object' || step === null)
      return false
    const { toolName, state } = step as { toolName?: unknown, state?: unknown }
    return state === 'done' && typeof toolName === 'string' && REWINDABLE_TOOLS.has(toolName)
  })
}

function hasFinishedEdit(message: HarnessUIMessage): boolean {
  return message.parts.some((part) => {
    if (!isToolUIPart(part) || part.state !== 'output-available')
      return false
    const name = toolNameOf(part)
    return REWINDABLE_TOOLS.has(name) || (name === TASK_TOOL_NAME && taskWroteFiles(part.output))
  })
}

/**
 * + Phase 10: the replies whose background agents wrote files, from the results delivered on the shown path
 * (`TaskResultData.messageId` is the launching reply; ADR-046).
 */
function backgroundEditors(messages: readonly HarnessUIMessage[]): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const result of taskResultsOf(messages).values()) {
    if (taskWroteFiles(result.output))
      ids.add(result.messageId)
  }
  return ids
}

/** Older messages are finished, so their answer is kept (the last one may still change in place). */
const finishedEdits = new WeakMap<HarnessUIMessage, boolean>()

/**
 * + Phase 8: the user messages of the shown path that a finished agent edit follows, in a project chat: they offer
 * "Rewind files to here". One backwards pass; the preview stays the truth (edits older than v1.4 have no checkpoints).
 */
const rewindable = computed<ReadonlySet<string>>(() => {
  const ids = new Set<string>()
  if (!props.projectId)
    return ids
  const messages = props.messages
  const background = backgroundEditors(messages)
  let edited = false
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (message.role === 'user') {
      if (edited && !isTaskResultMessage(message) && !isHookCarrierMessage(message))
        ids.add(message.id)
      continue
    }
    if (edited || message.role !== 'assistant')
      continue
    if (background.has(message.id)) {
      edited = true
      continue
    }
    if (index === messages.length - 1) {
      edited = hasFinishedEdit(message)
      continue
    }
    let known = finishedEdits.get(message)
    if (known === undefined) {
      known = hasFinishedEdit(message)
      finishedEdits.set(message, known)
    }
    edited = known
  }
  return ids
})

// ---------- compaction (Phase 9) ----------

/** + Phase 9: the rows the latest compaction replaced for the model (dimmed, `data-compacted`; docs/UI.md 7.24). */
const layout = computed(() => compactionLayout(props.messages))

/** + Phase 8: a closed rewind dialog puts focus back on "Rewind files to here" of that message (docs/UI.md 7.22). */
function focusRewind(messageId: string): void {
  messageElement(messageId)?.querySelector<HTMLElement>(`[data-testid="${testIds.messageRewind}"]`)?.focus()
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

/** + Phase 8: opens the editor on a shown user message ("Restore files and edit"), unless a request is in flight. */
function startEdit(messageId: string): void {
  if (!busy.value)
    messageRefs.get(messageId)?.startEdit()
}

/** Opens the editor on the last user message; false when there is none. */
function editLastUserMessage(): boolean {
  const last = [...props.messages].reverse().find(message => message.role === 'user' && !isTaskResultMessage(message) && !isHookCarrierMessage(message))
  const target = last ? messageRefs.get(last.id) : undefined
  target?.startEdit()
  return !!target
}

defineExpose({
  editLastUserMessage,
  scrollToBottom: (behavior?: 'instant' | 'smooth') => controls.value?.scrollToBottom(behavior),
  focusShownVersion,
  focusDeleteVersion,
  focusRewind,
  startEdit,
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
      ref="column"
      :data-busy="busy ? 'true' : undefined"
      class="group/transcript hf-transcript mx-auto flex w-full max-w-3xl flex-col gap-(--message-gap) px-4 pt-6 pb-[calc(var(--hf-composer-h,8rem)+1.5rem)] md:px-6"
      :aria-busy="loading || undefined"
    >
      <template v-if="!loading">
        <div
          v-for="(message, index) in messages"
          :key="message.id"
          v-memo="[message, index >= renderStart, index === messages.length - 1, isStreaming(index), showThinking, index === messages.length - 1 && busy, errorFor(index), branches[message.id], branches[message.id] !== undefined && (busy || switching), rewindable.has(message.id), layout.dimmed.has(message.id), activityFor(index)]"
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
            :busy="isBusyRow(index, message)"
            :error="errorFor(index)"
            :command-reply="isCommandReply(index)"
            :branch="branches[message.id] ?? null"
            :switching="switching"
            :can-rewind="rewindable.has(message.id)"
            :compacted="layout.dimmed.has(message.id)"
            :activity="activityFor(index)"
            @regenerate="emit('regenerate', message.id)"
            @edit="(text, files) => emit('edit', message.id, text, files)"
            @approval="decision => emit('approval', decision)"
            @retry="onRetry(message.id)"
            @select-version="onSelectVersion"
            @delete-version="onDeleteVersion(message.id)"
            @rewind="emit('rewind', message.id)"
          />
        </div>
        <SubmittedPlaceholder v-if="showPlaceholder" :activity="activity" />
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
