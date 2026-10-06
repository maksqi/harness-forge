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
// Phase 8 (C20 declares, W8.9 / W8.10 use; frozen from Gate P8-0b): `canRewind` shows "Rewind files to here" on a user
// message (re-emitted as `rewind`), and the approval payload passes the card's `allowRules` on.
// Phase 9 (C25 declares, W9.11 implements; frozen from Gate P9-0b): block kinds `compaction` (CompactionDivider at the
// part's position, `history` or `run` from the marker's position, docs/UI.md 7.24), `steer` (SteerNote) and `task`
// (TaskBlock); `compacted` marks a row the latest compaction replaced for the model (`data-compacted`, dimmed until it
// is hovered or holds the focus); in a row that is not compacted, the blocks before its last compaction marker (an
// in-run compaction) are dimmed the same way. While the reply streams, `activity` = 'compacting' shows "Compacting
// conversation…" at its end (instead of "Thinking…"); "Thinking…" also shows while nothing follows its last divider.
// The approval payload passes the plan card's `planMode` / `reason` on.
// Phase 10 (ADR-046; C33 declares, W10.11 implements; frozen from Gate P10-0b): block kind `task-result` renders
// TaskResultNote (variant inline) at the part's position; a carrier user message (`isTaskResultMessage`: only
// `data-task-result` parts, the turn the server started for finished background agents) renders its notes (variant
// turn) left-aligned with the caption "Sent to the agent", and no bubble, actions, edit, versions or rewind.
// Phase 11 (ADR-048; C39 declares and wires, W11.12 implements; frozen from Gate P11-0b): block kind `hook` renders
// HookNote (variant inline) at the part's position; tool-linked records (`toolHooksOf`) go to their ToolPart (`hooks`)
// and, for a `task` call, render inline right after its TaskBlock; the `data-hook` parts of a user message
// (UserPromptSubmit / SessionStart context) render as inline notes under the bubble (right-aligned, like the
// attachments); a hook carrier (`isHookCarrierMessage`: only `data-hook` parts, the turn the server started after a
// Stop hook blocked) renders its notes (variant turn) left-aligned with the caption "Sent to the agent", and no bubble,
// actions, edit, versions or rewind. `activity` widens to 'compacting' | 'hooks' | null ("Running hooks…").
import type { HarnessUIMessage, HookData, MessageBranch } from '@harness-forge/shared'
import type { FileUIPart, TextUIPart } from 'ai'
import type { AllowRules } from '~/components/workspace/allowlist/allow-rule'
import { isFileUIPart } from 'ai'
import { computed, ref } from 'vue'
import { cn } from '@/lib/utils'
import { useSpeechPlayer } from '~/composables/useSpeechPlayer'
import { testIds } from '~/utils/testids'
import TaskBlock from './agent/TaskBlock.vue'
import TaskResultNote from './agent/TaskResultNote.vue'
import BranchSwitcher from './BranchSwitcher.vue'
import { isTaskResultMessage, messageBlocks, messageText, taskResultsOf } from './chat-format'
import { messageCompaction } from './compaction/compaction'
import CompactionDivider from './compaction/CompactionDivider.vue'
import { hookDataOf, isHookCarrierMessage, toolHooksOf } from './hooks/hook-notes'
import HookNote from './hooks/HookNote.vue'
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
import SteerNote from './steer/SteerNote.vue'
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
  /**
   * + Phase 8: a user message followed by finished agent edits in a project chat: "Rewind files to here" (the
   * transcript decides, docs/UI.md 7.22); default false.
   */
  canRewind?: boolean
  /**
   * + Phase 9 (ADR-040): the latest compaction on the path replaced this message for the model: `data-compacted`, shown
   * dimmed (full opacity on hover and focus-within); default false.
   */
  compacted?: boolean
  /**
   * + Phase 9: the session's transient activity while this reply streams ('compacting': "Compacting conversation…"
   * instead of "Thinking…"); + Phase 11: 'hooks' ("Running hooks…"); default null.
   */
  activity?: 'compacting' | 'hooks' | null
}>(), {
  busy: false,
  commandReply: false,
  branch: null,
  switching: false,
  canRewind: false,
  compacted: false,
  activity: null,
})

const emit = defineEmits<{
  'regenerate': []
  /** The edited text and the files left in the editor (the full new set). */
  'edit': [text: string, files: FileUIPart[]]
  /**
   * + Phase 7: `acceptEdits` = "Accept all edits in this chat" (the session switches the mode to `edits`). + Phase 8:
   * `allowRules` = the shell rules to create before the approval is sent. + Phase 9: `planMode` / `reason` = the plan
   * card's mode and feedback.
   */
  'approval': [response: { id: string, approved: boolean, toolName: string, alwaysAllow: boolean, acceptEdits?: boolean, allowRules?: AllowRules, planMode?: 'edits' | 'ask', reason?: string }]
  'retry': []
  /** The version chosen in the BranchSwitcher (a sibling of this message). */
  'select-version': [messageId: string]
  /** "Delete this version" was clicked; ChatView asks for confirmation. */
  'delete-version': []
  /** + Phase 8: "Rewind files to here" was clicked on this user message; ChatView opens the RewindDialog. */
  'rewind': []
}>()

const editing = ref(false)

/** + Phase 10: the carrier of a turn the server started for finished background agents (never edited). */
const carrier = computed(() => isTaskResultMessage(props.message))
/** The results a carrier holds, in part order. */
const carrierResults = computed(() => (carrier.value ? [...taskResultsOf([props.message]).values()] : []))

/** + Phase 11: the carrier of a turn the server started after a Stop hook blocked (never edited). */
const hookCarrier = computed(() => !carrier.value && isHookCarrierMessage(props.message))
/** + Phase 11: the hook records of a user message (a carrier's, or the context records under a bubble), in part order. */
const userHooks = computed<HookData[]>(() => (props.message.role === 'user'
  ? props.message.parts.flatMap((part) => {
      const data = hookDataOf(part)
      return data ? [data] : []
    })
  : []))
/** + Phase 11: the tool-linked hook records of a reply, by tool call id. */
const toolHooks = computed(() => (props.message.role === 'assistant' ? toolHooksOf(props.message.parts) : new Map<string, HookData[]>()))

/** Opens the editor on a user message (Edit button, ↑ in an empty composer); never on a carrier. */
function startEdit() {
  if (props.message.role === 'user' && !props.busy && !carrier.value && !hookCarrier.value)
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

/** + Phase 9: dimmed content (compacted for the model), back to full opacity on hover and focus-within. */
const DIMMED_CLASS = 'opacity-70 transition-opacity duration-(--duration-fast) hover:opacity-100 focus-within:opacity-100'

/** + Phase 9: a row the latest compaction replaced is dimmed until it is hovered or holds the focus. */
const compactedClass = computed(() => (props.compacted ? DIMMED_CLASS : ''))

/** + Phase 9: the compaction markers of a reply (divider variants, the last marker's part index). */
const compaction = computed(() => (props.message.role === 'assistant' ? messageCompaction(props.message) : null))

/**
 * + Phase 9: the class of a block. In a row that is not compacted itself, the blocks before its last compaction marker
 * were compacted during the reply (docs/UI.md 7.24): dimmed like a compacted row.
 */
function blockClass(index: number): string | undefined {
  const last = compaction.value?.lastIndex ?? null
  return !props.compacted && last !== null && index < last ? DIMMED_CLASS : undefined
}

/**
 * The streaming reply's activity line: "Compacting conversation…" while the session compacts, else "Thinking…" while
 * nothing renders yet or nothing follows the last compaction divider (the next step has not started).
 */
const showPlaceholder = computed(() => {
  if (!props.streaming)
    return false
  if (props.activity === 'compacting' || blocks.value.length === 0)
    return true
  return blocks.value.at(-1)!.kind === 'compaction'
})

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
    v-if="carrier"
    :data-testid="testIds.messageUser"
    :data-message-id="message.id"
    data-status="done"
    :data-compacted="compacted || undefined"
    :class="cn('flex min-w-0 flex-col items-start gap-1', compactedClass)"
  >
    <TaskResultNote v-for="result in carrierResults" :key="result.taskId" :result="result" variant="turn" />
    <p aria-hidden="true" class="text-xs text-muted-foreground">
      Sent to the agent
    </p>
  </div>

  <div
    v-else-if="hookCarrier"
    :data-testid="testIds.messageUser"
    :data-message-id="message.id"
    data-status="done"
    :data-compacted="compacted || undefined"
    :class="cn('flex min-w-0 flex-col items-start gap-1', compactedClass)"
  >
    <HookNote v-for="data in userHooks" :key="data.id" :data="data" variant="turn" />
    <p aria-hidden="true" class="text-xs text-muted-foreground">
      Sent to the agent
    </p>
  </div>

  <div
    v-else-if="message.role === 'user'"
    :data-testid="testIds.messageUser"
    :data-message-id="message.id"
    data-status="done"
    :data-compacted="compacted || undefined"
    :class="cn('group/message flex min-w-0 flex-col items-end gap-1', compactedClass)"
  >
    <MessageEditor v-if="editing" :text="copyText()" :files="fileParts" @save="onSave" @cancel="editing = false" />
    <template v-else>
      <UserMessageBubble :message="message" />
      <div v-if="userHooks.length > 0" data-slot="user-hook-notes" class="flex max-w-[85%] min-w-0 flex-col items-end gap-1">
        <HookNote v-for="data in userHooks" :key="data.id" :data="data" variant="inline" />
      </div>
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
          :can-rewind="canRewind && !busy"
          :can-delete-version="canDeleteVersion"
          @edit="startEdit"
          @rewind="emit('rewind')"
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
    :data-compacted="compacted || undefined"
    :class="cn('group/message flex min-w-0 flex-col gap-2', compactedClass)"
  >
    <template v-for="(block, blockIndex) in blocks" :key="block.key">
      <TextPart
        v-if="block.kind === 'text'"
        :part="block.part"
        :final="isTextFinal(blockIndex, block.part)"
        :class="cn('font-reading', blockClass(block.index))"
      />
      <ReasoningPart
        v-else-if="block.kind === 'reasoning'"
        :class="blockClass(block.index)"
        :part="block.part"
        :streaming="streaming"
        :show-thinking="showThinking"
        :duration-ms="reasoningCount === 1 ? message.metadata?.reasoningMs : undefined"
      />
      <ToolPart
        v-else-if="block.kind === 'tool'"
        :class="blockClass(block.index)"
        :part="block.part"
        :streaming="streaming"
        :superseded="!isLast"
        :hooks="toolHooks.get(block.part.toolCallId)"
        @approval="emit('approval', $event)"
      />
      <ImageGallery
        v-else-if="block.kind === 'gallery'"
        :class="blockClass(block.index)"
        :images="block.parts"
        :message-id="message.id"
      />
      <div v-else-if="block.kind === 'file'" :class="cn('flex', blockClass(block.index))">
        <FilePart :part="block.part" />
      </div>
      <SourcesPart v-else-if="block.kind === 'sources'" :class="blockClass(block.index)" :parts="block.parts" />
      <NoticePart v-else-if="block.kind === 'notice'" :class="blockClass(block.index)" :notice="block.notice" />
      <CompactionDivider
        v-else-if="block.kind === 'compaction'"
        :class="blockClass(block.index)"
        :data="block.data"
        :variant="compaction?.variants.get(block.index) ?? 'history'"
      />
      <SteerNote v-else-if="block.kind === 'steer'" :class="blockClass(block.index)" :steer="block.steer" />
      <TaskResultNote v-else-if="block.kind === 'task-result'" :class="blockClass(block.index)" :result="block.part" variant="inline" />
      <HookNote v-else-if="block.kind === 'hook'" :class="blockClass(block.index)" :data="block.data" variant="inline" />
      <template v-else-if="block.kind === 'task'">
        <TaskBlock
          :class="blockClass(block.index)"
          :part="block.part"
          :streaming="streaming"
          :superseded="!isLast"
          @approval="emit('approval', $event)"
        />
        <HookNote
          v-for="data in toolHooks.get(block.part.toolCallId) ?? []"
          :key="data.id"
          :class="blockClass(block.index)"
          :data="data"
          variant="inline"
        />
      </template>
    </template>
    <GeneratingImages
      v-if="generatingImages"
      :n="generatingImages.n"
      :aspect-ratio="generatingImages.aspectRatio"
      :started-at="generatingImages.startedAt"
    />
    <SubmittedPlaceholder v-else-if="showPlaceholder" :activity="activity" />
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
