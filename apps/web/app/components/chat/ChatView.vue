<script setup lang="ts">
// Transcript + composer of one chat (docs/UI.md 2.1, 2.2, 5.7-5.9, 7.6; contract in 10.4). The session comes from the
// registry (useChatSession), so leaving the page never stops a stream and coming back shows it still running. A new
// chat (`isNew`, the `/` page) shows the `empty` slot above an inline composer; its first send emits `created` so
// the page can move to /chat/<id> while the same session keeps streaming. Otherwise the transcript fills the pane and
// the composer is docked over its bottom (fade above it); `--hf-composer-h` feeds the transcript's bottom padding
// and the scroll pill position. A polite live region announces finished / stopped replies, approvals and errors.
import type { ReasoningEffort, ToolMode } from '@harness-forge/shared'
import type { ChatComposerExposed, ComposerSubmitInput } from '~/components/chat/composer/types'
import type { ToolApprovalDecision } from '~/composables/useChatSession'
import { useElementSize } from '@vueuse/core'
import { isToolUIPart } from 'ai'
import { computed, nextTick, onMounted, provide, ref, useTemplateRef, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import ChatComposer from '~/components/chat/composer/ChatComposer.vue'
import { toHarnessErrorView } from '~/components/common/harness-error'
import { useChatSession } from '~/composables/useChatSession'
import { useChatsStore } from '~/stores/chats'
import { useModelsStore } from '~/stores/models'
import { usePluginsStore } from '~/stores/plugins'
import { useProvidersStore } from '~/stores/providers'
import { useUiStore } from '~/stores/ui'
import { toHarnessError } from '~/utils/errors'
import { CHAT_VIEW_ACTIONS } from './chat-context'
import { messageText, toolNameOf } from './chat-format'
import ChatNotFound from './ChatNotFound.vue'
import ChatTranscript from './ChatTranscript.vue'

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
  /** Above the transcript (the chat header); `scrolled` = the transcript left its top. */
  header?: (props: { scrolled: boolean, title: string | null, loading: boolean }) => any
  /** Above the inline composer of an empty new chat (greeting, callouts). */
  empty?: () => any
}>()

const session = useChatSession(props.chatId, { isNew: props.isNew })
const chats = useChatsStore()
const models = useModelsStore()
const plugins = usePluginsStore()
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

const pendingApprovalTools = computed(() => {
  const last = messages.value.at(-1)
  if (last?.role !== 'assistant')
    return []
  return last.parts.flatMap(part => (isToolUIPart(part) && part.state === 'approval-requested' ? [toolNameOf(part)] : []))
})
watch(pendingApprovalTools, (names, previous) => {
  const added = names.find(name => !previous?.includes(name))
  if (added)
    void announce(`Approval needed: ${added}`)
})

// ---------- data the transcript needs ----------

onMounted(() => {
  if (!providers.loaded)
    providers.fetchAll().catch(() => {})
  if (!models.loaded)
    models.fetchAll().catch(() => {})
  if (!plugins.toolsLoaded)
    plugins.fetchTools().catch(() => {})
})

// A run that starts while the chat is shown (another tab, a continuation elsewhere) is followed live.
watch(() => chats.runState[props.chatId] === 'running', (running) => {
  if (running)
    void session.resumeIfRunning()
})

// `409 conflict`: a reply is already running here. Take the message back into the composer and show the live run.
watch(error, (value) => {
  if (!value || toHarnessError(value).code !== 'conflict')
    return
  const last = messages.value.at(-1)
  if (last?.role === 'user') {
    session.chat.messages.value = messages.value.slice(0, -1)
    composer.value?.setText(messageText(last))
  }
  session.chat.clearError()
  toast('A response is already running in this chat.')
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

function onEdit(messageId: string, text: string) {
  session.edit(messageId, text).catch(failure => reportFailure('Could not send the message', failure))
  transcript.value?.scrollToBottom('smooth')
}

function onRegenerate(messageId: string) {
  session.regenerate(messageId).catch(failure => reportFailure('Could not regenerate the response', failure))
}

function onRetry() {
  session.regenerate().catch(failure => reportFailure('Could not retry', failure))
}

function onApproval(decision: ToolApprovalDecision) {
  session.approve(decision).catch(failure => reportFailure('Could not save the tool preference', failure))
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
</script>

<template>
  <div data-slot="chat-view" :data-chat-id="chatId" class="relative flex h-dvh min-h-0 flex-col" :style="composerStyle">
    <slot v-if="!notFound" name="header" :scrolled="scrolled" :title="title" :loading="!loaded" />

    <ChatNotFound v-if="notFound" />

    <div
      v-else-if="showEmpty"
      class="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-4 pt-[max(2rem,calc(38dvh-5rem))] pb-8 md:px-6"
    >
      <div class="flex w-full max-w-3xl flex-col items-center gap-8">
        <slot name="empty" />
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
        @regenerate="onRegenerate"
        @edit="onEdit"
        @approval="onApproval"
        @retry="onRetry"
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

    <div class="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {{ announcement }}
    </div>
  </div>
</template>
