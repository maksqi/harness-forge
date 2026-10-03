<script setup lang="ts">
// Transcript + composer of one chat (docs/UI.md 2.1, 2.2, 5.7-5.9, 7.6; contract in 10.4). The session comes from the
// registry (useChatSession), so leaving the page never stops a stream and coming back shows it still running. A new
// chat (`isNew`, the `/` page) shows the `empty` slot above an inline composer; its first send emits `created` so
// the page can move to /chat/<id> while the same session keeps streaming. Otherwise the transcript fills the pane and
// the composer is docked over its bottom (fade above it); `--hf-composer-h` feeds the transcript's bottom padding
// and the scroll pill position. A polite live region announces finished / stopped replies, approvals, errors, the
// version shown after a switch (ADR-023) and a deleted version. "Delete this version" (ADR-030) is confirmed here, in
// one ConfirmDialog; afterwards focus moves to the version now shown (or back to the button when nothing changed).
// The composer learns how many images the last reply holds ("Edit the previous image", ADR-028).
// Phase 7 (ADR-031): the session's project goes to the header slot (chip, "Move to project"), the empty slot (the
// new-chat picker) and the composer (Accept edits is offered in project chats); a chat request held off by a master-key
// rotation (`409 busy`, ADR-034) puts the message back into the composer with a toast. Approval cards learn the chat's
// permission mode and project name (TOOL_APPROVAL_CONTEXT: no "Accept all edits" in a chat that already accepts edits,
// "In {project}" on a shell approval).
// Phase 8 (C20 wires it, W8.9 / W8.10 finish it): the context also gives the cards the chat's project (the scope of a
// shell rule) and its sticky shell folder (session.cwd); "Rewind files to here" opens the RewindDialog owned here
// (closed: focus back on the button; "Restore files and edit": the editor opens on the message); a shell approval
// whose rules could not be saved shows "Could not save the rule".
import type { MessageBranch, ReasoningEffort, RestoreResult, ToolMode } from '@harness-forge/shared'
import type { FileUIPart } from 'ai'
import type { ChatComposerExposed, ComposerSubmitInput } from '~/components/chat/composer/types'
import type { ToolApprovalDecision } from '~/composables/useChatSession'
import { useElementSize } from '@vueuse/core'
import { isToolUIPart } from 'ai'
import { computed, nextTick, onMounted, provide, ref, useTemplateRef, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import ChatComposer from '~/components/chat/composer/ChatComposer.vue'
import ConfirmDialog from '~/components/common/ConfirmDialog.vue'
import { toHarnessErrorView } from '~/components/common/harness-error'
import RewindDialog from '~/components/workspace/rewind/RewindDialog.vue'
import { isBusyConflict, isRunActiveConflict, useChatSession } from '~/composables/useChatSession'
import { useChatsStore } from '~/stores/chats'
import { useModelsStore } from '~/stores/models'
import { usePluginsStore } from '~/stores/plugins'
import { useProjectsStore } from '~/stores/projects'
import { useProvidersStore } from '~/stores/providers'
import { useUiStore } from '~/stores/ui'
import { toHarnessError } from '~/utils/errors'
import { testIds } from '~/utils/testids'
import { CHAT_VIEW_ACTIONS } from './chat-context'
import { imageFileParts, messageText, toolNameOf } from './chat-format'
import ChatNotFound from './ChatNotFound.vue'
import ChatTranscript from './ChatTranscript.vue'
import { TOOL_APPROVAL_CONTEXT } from './parts/tool-approval-context'
import { toolApprovalLabel } from './parts/tool-row'

const props = withDefaults(defineProps<{
  chatId: string
  /** The `/` page: no history to load; the first send emits `created`. */
  isNew?: boolean
}>(), {
  isNew: false,
})

const emit = defineEmits<{
  /** After the first send of a new chat. */
  created: [chatId: string]
}>()

defineSlots<{
  /**
   * Above the transcript (the chat header); `scrolled` = the transcript left its top; `projectId` = the chat's project
   * (null = none).
   */
  header?: (props: { scrolled: boolean, title: string | null, loading: boolean, projectId: string | null }) => any
  /**
   * Above the inline composer of an empty new chat (greeting, the project picker, callouts): the project the first send
   * carries and its setter.
   */
  empty?: (props: { projectId: string | null, setProject: (projectId: string | null) => void }) => any
}>()

const session = useChatSession(props.chatId, { isNew: props.isNew })
const chats = useChatsStore()
const models = useModelsStore()
const plugins = usePluginsStore()
const projects = useProjectsStore()
const providers = useProvidersStore()
const ui = useUiStore()

const composer = useTemplateRef<ChatComposerExposed>('composer')
const transcript = useTemplateRef<InstanceType<typeof ChatTranscript>>('transcript')
const dock = useTemplateRef<HTMLElement>('dock')
const { height: dockHeight } = useElementSize(dock, undefined, { box: 'border-box' })

const messages = computed(() => session.chat.messages.value)
const status = computed(() => session.chat.status.value)
const error = computed(() => session.chat.error.value ?? null)
const modelRef = session.modelRef
const reasoningEffort = session.reasoningEffort
const toolMode = session.toolMode
const loaded = session.loaded
const notFound = session.notFound
const loadError = session.loadError
const branches = session.branches
const switching = session.switching
const projectId = session.projectId

/** docs/UI.md 7.4: a run holds the chat (`409 conflict`, reason `run-active`). */
const RUN_ACTIVE_MESSAGE = 'A response is already running in this chat.'
/** A `404` to a chat request or a switch: the shown path was stale and the session reloaded it. */
const STALE_CHAT_MESSAGE = 'This chat changed elsewhere and was reloaded.'
/** docs/UI.md 7.4: a chat request answered `409 conflict` (`busy`): a master-key rotation holds off new runs. */
const KEY_ROTATION_BUSY_MESSAGE = 'The server is rotating its encryption key. Try again in a moment.'

const scrolled = ref(false)
const showEmpty = computed(() => props.isNew && messages.value.length === 0 && !session.busy.value)
const noProvider = computed(() => providers.loaded && !providers.hasUsableProvider)
const title = computed(() => chats.byId(props.chatId)?.title ?? session.summary.value?.title ?? null)
const composerStyle = computed(() => (dockHeight.value > 0 ? { '--hf-composer-h': `${Math.round(dockHeight.value)}px` } : {}))

const lastUsage = computed(() => {
  for (let index = messages.value.length - 1; index >= 0; index--) {
    const message = messages.value[index]!
    if (message.role === 'assistant' && message.metadata?.usage)
      return message.metadata.usage
  }
  return null
})
/** Images of the last reply on the path: the composer offers "Edit the previous image" when there are any. */
const previousImages = computed(() => {
  for (let index = messages.value.length - 1; index >= 0; index--) {
    const message = messages.value[index]!
    if (message.role === 'assistant')
      return imageFileParts(message).length
  }
  return 0
})
const chatCostUsd = computed(() => {
  let total = 0
  let known = false
  for (const message of messages.value) {
    const cost = message.metadata?.costUsd
    if (message.role === 'assistant' && typeof cost === 'number') {
      total += cost
      known = true
    }
  }
  return known ? total : null
})

provide(CHAT_VIEW_ACTIONS, {
  openModelPicker: () => composer.value?.openModelPicker(),
})

/** The name of the chat's project, once the projects store knows it. */
const projectName = computed(() => (projectId.value ? projects.byId(projectId.value)?.name ?? null : null))
provide(TOOL_APPROVAL_CONTEXT, {
  toolMode: () => toolMode.value,
  projectName: () => projectName.value,
  projectId: () => projectId.value,
  shellCwd: () => session.cwd.value,
})

// ---------- announcements (polite live region) ----------

const announcement = ref('')
async function announce(text: string) {
  announcement.value = ''
  await nextTick()
  announcement.value = text
}

let stopRequested = false
watch(status, (next, previous) => {
  const wasBusy = previous === 'submitted' || previous === 'streaming'
  if (wasBusy && next === 'ready') {
    void announce(stopRequested ? 'Response stopped' : 'Response finished')
    stopRequested = false
  }
  else if (next === 'error' && error.value) {
    void announce(`Error: ${toHarnessErrorView(error.value).message}`)
  }
})

/** Tool calls of the last reply waiting for a decision, with the card's label ("Approval needed: run {cmd}" for shell). */
const pendingApprovals = computed(() => {
  const last = messages.value.at(-1)
  if (last?.role !== 'assistant')
    return []
  return last.parts.flatMap(part => (isToolUIPart(part) && part.state === 'approval-requested'
    ? [{ id: part.toolCallId, label: toolApprovalLabel(toolNameOf(part), part.input) }]
    : []))
})
watch(pendingApprovals, (pending, previous) => {
  const added = pending.find(item => !previous?.some(known => known.id === item.id))
  if (added)
    void announce(added.label)
})

// ---------- data the transcript needs ----------

onMounted(() => {
  if (!providers.loaded)
    providers.fetchAll().catch(() => {})
  if (!models.loaded)
    models.fetchAll().catch(() => {})
  if (!plugins.toolsLoaded)
    plugins.fetchTools().catch(() => {})
  // The project chip, the new-chat picker and "Move to project" (the sidebar may not be mounted, e.g. on mobile).
  if (!projects.loaded && !projects.loading)
    projects.fetchAll().catch(() => {})
})

// A run that starts while the chat is shown (another tab, a continuation elsewhere) is followed live.
watch(() => chats.runState[props.chatId] === 'running', (running) => {
  if (running)
    void session.resumeIfRunning()
})

// `409 conflict` (`run-active`): a reply is already running here; show the live run. `404 not_found`: the shown path
// is stale (the chat changed elsewhere) and the session reloads it. `409 conflict` (`busy`): a master-key rotation
// holds off new runs. In every case a message the server never stored goes back into the composer.
watch(error, (value) => {
  if (!value)
    return
  const stale = toHarnessError(value).code === 'not_found'
  const busy = isBusyConflict(value)
  if (!stale && !busy && !isRunActiveConflict(value))
    return
  const unsent = session.takeBackUnstored()
  if (unsent)
    composer.value?.setText(messageText(unsent))
  session.chat.clearError()
  if (stale) {
    toast(STALE_CHAT_MESSAGE)
    return
  }
  if (busy) {
    toast(KEY_ROTATION_BUSY_MESSAGE)
    return
  }
  toast(RUN_ACTIVE_MESSAGE)
  chats.setRunState(props.chatId, 'running')
  void session.resumeIfRunning()
})

// ---------- actions ----------

function reportFailure(title: string, failure: unknown) {
  toast.error(title, { description: toHarnessError(failure).message })
}

function onSubmit(input: ComposerSubmitInput) {
  if (session.busy.value)
    return
  if (!session.modelRef.value) {
    toast.error('Choose a model first')
    composer.value?.openModelPicker()
    return
  }
  const first = props.isNew && messages.value.length === 0
  const sending = session.send(input)
  transcript.value?.scrollToBottom('smooth')
  if (first)
    emit('created', props.chatId)
  sending.catch(failure => reportFailure('Could not send the message', failure))
}

function onStop() {
  stopRequested = true
  session.stop().catch(failure => reportFailure('Could not stop the response', failure))
}

function onEditLast() {
  if (session.busy.value)
    return
  transcript.value?.editLastUserMessage()
}

function onEdit(messageId: string, text: string, files: FileUIPart[]) {
  session.edit(messageId, text, files).catch(failure => reportFailure('Could not send the message', failure))
  transcript.value?.scrollToBottom('smooth')
}

function onRegenerate(messageId: string) {
  session.regenerate(messageId).catch(failure => reportFailure('Could not regenerate the response', failure))
}

function onRetry() {
  session.regenerate().catch(failure => reportFailure('Could not retry', failure))
}

function onApproval(decision: ToolApprovalDecision) {
  // A shell approval with "Always allow commands starting with" rethrows a rule that could not be saved (the approval
  // itself was still sent).
  const title = decision.approved && decision.allowRules ? 'Could not save the rule' : 'Could not save the tool preference'
  session.approve(decision).catch(failure => reportFailure(title, failure))
}

function onSelectVersion(messageId: string) {
  session.switchBranch(messageId)
    .then(() => {
      // Listed only when the switch showed it (a request in flight makes the switch do nothing).
      const branch = session.branches.value[messageId]
      if (branch)
        void announce(`Version ${branch.index + 1} of ${branch.siblings.length}`)
    })
    .catch((failure) => {
      if (isRunActiveConflict(failure))
        toast(RUN_ACTIVE_MESSAGE)
      else if (toHarnessError(failure).code === 'not_found')
        toast(STALE_CHAT_MESSAGE)
      else
        reportFailure('Could not switch versions', failure)
    })
}

// ---------- delete a version (ADR-030) ----------

/** The version waiting for confirmation, with its versions when the dialog opened. */
const deleteTarget = ref<{ messageId: string, branch: MessageBranch } | null>(null)
const deleting = ref(false)

function onDeleteVersion(messageId: string) {
  const branch = session.branches.value[messageId]
  if (!branch || session.busy.value || session.switching.value)
    return
  deleteTarget.value = { messageId, branch }
}

function onDeleteOpenChange(open: boolean) {
  if (open || deleting.value)
    return
  const target = deleteTarget.value
  deleteTarget.value = null
  // Canceled: back on the button (the dialog has no trigger of its own).
  if (target)
    void nextTick(() => transcript.value?.focusDeleteVersion(target.messageId))
}

async function confirmDeleteVersion() {
  const target = deleteTarget.value
  if (!target || deleting.value)
    return
  deleting.value = true
  let answered = false
  try {
    await session.deleteVersion(target.messageId)
    answered = true
  }
  catch (failure) {
    if (isRunActiveConflict(failure))
      toast(RUN_ACTIVE_MESSAGE)
    else if (toHarnessError(failure).code === 'not_found')
      toast(STALE_CHAT_MESSAGE)
    else
      reportFailure('Could not delete the version', failure)
  }
  deleting.value = false
  deleteTarget.value = null
  const onPath = (messageId: string) => messages.value.some(message => message.id === messageId)
  // Still shown after an answer: nothing was done (a request started meanwhile).
  const deleted = answered && !onPath(target.messageId)
  const shown = deleted ? target.branch.siblings.find(sibling => sibling !== target.messageId && onPath(sibling)) : undefined
  await nextTick()
  if (deleted)
    void announce('Version deleted')
  if (shown)
    transcript.value?.focusShownVersion(shown)
  else if (!deleted)
    transcript.value?.focusDeleteVersion(target.messageId)
}

// ---------- rewind files (Phase 8, ADR-036) ----------

/** The user message whose "Rewind files to here" opened the dialog; null while it is closed. */
const rewindTarget = ref<string | null>(null)
/** The dialog finished with "Restore files and edit": the editor opens on the message once it closed. */
let editAfterRewind = false

function onRewind(messageId: string) {
  if (session.busy.value)
    return
  editAfterRewind = false
  rewindTarget.value = messageId
}

function onRewindOpenChange(open: boolean) {
  if (open)
    return
  const target = rewindTarget.value
  rewindTarget.value = null
  if (!target)
    return
  void nextTick(() => {
    if (editAfterRewind)
      transcript.value?.startEdit(target)
    else
      transcript.value?.focusRewind(target)
    editAfterRewind = false
  })
}

function onRewindRestored(_result: RestoreResult, then: 'none' | 'edit') {
  editAfterRewind = then === 'edit'
}

function onModelChange(value: string) {
  modelRef.value = value
}

function onEffortChange(value: ReasoningEffort) {
  reasoningEffort.value = value
}

function onToolModeChange(value: ToolMode) {
  toolMode.value = value
}

/** The new-chat picker: local until the first send (a saved chat moves through `PATCH`, which can fail). */
function setProject(value: string | null) {
  session.setProject(value).catch(failure => reportFailure('Could not move the chat', failure))
}
</script>

<template>
  <div data-slot="chat-view" :data-chat-id="chatId" class="relative flex h-dvh min-h-0 flex-col" :style="composerStyle">
    <slot v-if="!notFound" name="header" :scrolled="scrolled" :title="title" :loading="!loaded" :project-id="projectId" />

    <ChatNotFound v-if="notFound" />

    <div
      v-else-if="showEmpty"
      class="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-4 pt-[max(2rem,calc(38dvh-5rem))] pb-8 md:px-6"
    >
      <div class="flex w-full max-w-3xl flex-col items-center gap-8">
        <slot name="empty" :project-id="projectId" :set-project="setProject" />
        <div class="w-full">
          <ChatComposer
            ref="composer"
            :chat-id="chatId"
            :status="status"
            :model-ref="modelRef"
            :reasoning-effort="reasoningEffort"
            :tool-mode="toolMode"
            :usage="lastUsage"
            :chat-cost-usd="chatCostUsd"
            :previous-images="previousImages"
            :project-id="projectId"
            :disabled="noProvider"
            placeholder="Ask anything…"
            @update:model-ref="onModelChange"
            @update:reasoning-effort="onEffortChange"
            @update:tool-mode="onToolModeChange"
            @submit="onSubmit"
            @stop="onStop"
            @edit-last="onEditLast"
          />
        </div>
      </div>
    </div>

    <div v-else class="relative flex min-h-0 flex-1 flex-col">
      <ChatTranscript
        ref="transcript"
        v-model:scrolled="scrolled"
        :messages="messages"
        :status="status"
        :error="error"
        :show-thinking="ui.showThinking"
        :loading="!loaded && !loadError"
        :branches="branches"
        :switching="switching"
        @regenerate="onRegenerate"
        @edit="onEdit"
        @approval="onApproval"
        @retry="onRetry"
        @select-version="onSelectVersion"
        @delete-version="onDeleteVersion"
        @rewind="onRewind"
      />
      <div
        v-if="loadError && !loaded"
        class="pointer-events-none absolute inset-x-0 top-6 z-10 mx-auto w-full max-w-3xl px-4 md:px-6"
      >
        <Alert variant="destructive" class="pointer-events-auto border-destructive/35 bg-destructive/5">
          <AlertTitle>Could not load this chat</AlertTitle>
          <AlertDescription class="text-foreground/80">
            {{ loadError.message }}
          </AlertDescription>
          <div class="col-start-2 mt-2">
            <Button type="button" size="sm" variant="outline" class="text-foreground" @click="session.load()">
              Retry
            </Button>
          </div>
        </Alert>
      </div>
      <div class="pointer-events-none absolute inset-x-0 bottom-0 z-20">
        <div aria-hidden="true" class="h-6 bg-linear-to-t from-background to-transparent" />
        <div ref="dock" class="pointer-events-auto bg-background px-3 pb-[max(12px,env(safe-area-inset-bottom))] md:px-6">
          <div class="mx-auto w-full max-w-3xl">
            <ChatComposer
              ref="composer"
              :chat-id="chatId"
              :status="status"
              :model-ref="modelRef"
              :reasoning-effort="reasoningEffort"
              :tool-mode="toolMode"
              :usage="lastUsage"
              :chat-cost-usd="chatCostUsd"
              :previous-images="previousImages"
              :project-id="projectId"
              :disabled="noProvider"
              placeholder="Reply…"
              @update:model-ref="onModelChange"
              @update:reasoning-effort="onEffortChange"
              @update:tool-mode="onToolModeChange"
              @submit="onSubmit"
              @stop="onStop"
              @edit-last="onEditLast"
            />
          </div>
        </div>
      </div>
    </div>

    <ConfirmDialog
      :open="deleteTarget !== null"
      title="Delete this version?"
      description="This version and every message after it are deleted. Other versions stay."
      confirm-label="Delete version"
      :pending="deleting"
      :data-testid="testIds.messageDeleteVersionConfirm"
      @update:open="onDeleteOpenChange"
      @confirm="confirmDeleteVersion"
    />

    <RewindDialog
      :open="rewindTarget !== null"
      :chat-id="chatId"
      :message-id="rewindTarget"
      @update:open="onRewindOpenChange"
      @restored="onRewindRestored"
    />

    <div class="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {{ announcement }}
    </div>
  </div>
</template>
