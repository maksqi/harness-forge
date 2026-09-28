<script setup lang="ts">
// Chat composer (docs/UI.md 5.8, 7.7-7.12, 10.4), rendered by ChatView (W2.2). A 20px-rounded card on the AI
// Elements `PromptInput`: attachment chips, an autosizing textarea (1 line up to 40vh), and the toolbar
// [+ | model | effort] ... [permission | context ring | send/stop]. The composer never calls `useChat`: it emits
// `submit` with the trimmed text and the uploaded files, `stop`, `edit-last` (↑ in an empty composer) and the
// v-model updates of model, effort and permission mode. Client slash commands (`/new`, `/model`, `/effort`, `/mode`,
// `/help`) run here and never reach the server. The unsent text is kept per chat (useComposerDraft).
import type { ClientCommand, MessageUsage, ReasoningEffort, ToolMode } from '@harness-forge/shared'
import type { ChatStatus } from 'ai'
import type { SlashItem } from './slash-commands'
import type { ChatComposerExposed, ComposerSubmitInput } from './types'
import { isClientCommand } from '@harness-forge/shared'
import { useMediaQuery } from '@vueuse/core'
import { computed, nextTick, onMounted, ref, useTemplateRef, watch } from 'vue'
import { toast } from 'vue-sonner'
import {
  PromptInput as AiPromptInput,
  PromptInputFooter as AiPromptInputFooter,
  PromptInputHeader as AiPromptInputHeader,
  PromptInputTools as AiPromptInputTools,
} from '@/components/ai-elements/prompt-input'
import { InputGroupTextarea } from '@/components/ui/input-group'
import { useComposerAttachments } from '~/composables/useComposerAttachments'
import { useComposerDraft } from '~/composables/useComposerDraft'
import { useComposerDropZone } from '~/composables/useComposerDropZone'
import { loadComposerCatalog, useComposerModel } from '~/composables/useComposerModel'
import { useComposerShortcuts } from '~/composables/useComposerShortcuts'
import { useModelsStore } from '~/stores/models'
import { usePluginsStore } from '~/stores/plugins'
import { useProvidersStore } from '~/stores/providers'
import { useSettingsStore } from '~/stores/settings'
import { useUiStore } from '~/stores/ui'
import { testIds } from '~/utils/testids'
import { capabilityWarnings, COMPOSER_ACCEPT } from './attachments'
import ComposerAddMenu from './ComposerAddMenu.vue'
import ComposerAttachments from './ComposerAttachments.vue'
import ContextRing from './ContextRing.vue'
import DropOverlay from './DropOverlay.vue'
import EffortMenu from './EffortMenu.vue'
import { resolveModelQuery } from './model-picker'
import ModelPicker from './ModelPicker.vue'
import { navigateTo } from './nuxt-imports'
import PermissionMenu from './PermissionMenu.vue'
import { enterKeyAction, isComposingEvent } from './send-key'
import SendStopButton from './SendStopButton.vue'
import { clientSlashItems, filterSlashItems, parseClientCommand, resolveClientCommand, serverSlashItems, slashQueryAt } from './slash-commands'
import SlashMenu from './SlashMenu.vue'

const props = withDefaults(defineProps<{
  chatId: string
  status: ChatStatus
  modelRef: string | null
  reasoningEffort: ReasoningEffort
  toolMode: ToolMode
  /** Last assistant `metadata.usage` (context ring). */
  usage?: MessageUsage | null
  chatCostUsd?: number | null
  /** E.g. no usable provider: Send stays disabled. */
  disabled?: boolean
  placeholder?: string
}>(), {
  usage: null,
  chatCostUsd: null,
  disabled: false,
  placeholder: 'Reply…',
})

const emit = defineEmits<{
  'update:modelRef': [value: string]
  'update:reasoningEffort': [value: ReasoningEffort]
  'update:toolMode': [value: ToolMode]
  'submit': [input: ComposerSubmitInput]
  'stop': []
  /** ↑ in an empty composer (the documented contract name, docs/UI.md 10.4). */
  'edit-last': []
}>()

const models = useModelsStore()
const plugins = usePluginsStore()
const providers = useProvidersStore()
const settings = useSettingsStore()
const ui = useUiStore()

const root = useTemplateRef<HTMLElement>('root')
const textareaComponent = useTemplateRef<InstanceType<typeof InputGroupTextarea>>('textarea')
const fileInput = useTemplateRef<HTMLInputElement>('fileInput')
const slashMenu = useTemplateRef<InstanceType<typeof SlashMenu>>('slashMenu')
const textarea = computed(() => (textareaComponent.value?.$el as HTMLTextAreaElement | undefined) ?? null)

const isTouch = useMediaQuery('(pointer: coarse)')
const draft = useComposerDraft(() => props.chatId)
const text = draft.text
const current = useComposerModel(() => props.modelRef)
const attachments = useComposerAttachments({
  onReject: ({ name, reason, message }) => {
    if (reason === 'size')
      toast.error(`${name} is too large`, { description: 'Files can be up to 20 MB.' })
    else if (reason === 'type')
      toast.error(`${name} can't be attached`, { description: 'Attach images, PDFs or text files.' })
    else
      toast.error(`${name} can't be attached`, { description: message })
  },
})
const attachmentItems = attachments.items

const pickerOpen = ref(false)
const effortOpen = ref(false)
const permissionOpen = ref(false)
const pendingSubmit = ref(false)
const caret = ref(0)
/** First token at which the user closed the slash menu (Esc); it reopens once the token changes. */
const slashDismissed = ref<string | null>(null)

const running = computed(() => props.status === 'submitted' || props.status === 'streaming')
const sendKey = computed(() => settings.resolved.sendKey)
const focusTarget = computed(() => (isTouch.value ? null : textarea.value))

// ---------- slash menu ----------

function firstToken(value: string): string {
  const end = value.search(/\s/)
  return end === -1 ? value : value.slice(0, end)
}

const slashItems = computed<SlashItem[]>(() => [
  ...clientSlashItems(),
  ...serverSlashItems(plugins.commands, pluginId => plugins.byId(pluginId)?.name),
])
const slashQuery = computed(() => slashQueryAt(text.value, caret.value))
const slashOpen = computed(() => slashQuery.value !== null
  && firstToken(text.value) !== slashDismissed.value
  && filterSlashItems(slashItems.value, slashQuery.value).length > 0)

// ---------- send state ----------

const warnings = computed(() => capabilityWarnings(attachmentItems.value, current.model.value))
const typedClientCommand = computed(() => parseClientCommand(text.value) !== null)
const hasContent = computed(() => text.value.trim() !== '' || attachmentItems.value.length > 0)

/** Why Send is disabled (tooltip), or enabled. Client commands always run. */
const sendState = computed<{ disabled: boolean, reason: string | null }>(() => {
  if (typedClientCommand.value)
    return { disabled: false, reason: null }
  if (props.disabled)
    return { disabled: true, reason: providers.hasUsableProvider ? 'Sending is unavailable right now' : 'Connect a provider first' }
  if (!props.modelRef)
    return { disabled: true, reason: 'Choose a model' }
  if (!current.available.value)
    return { disabled: true, reason: 'This model is unavailable' }
  if (attachments.failed.value)
    return { disabled: true, reason: 'Remove or retry the failed uploads' }
  if (warnings.value.length > 0)
    return { disabled: true, reason: warnings.value[0] ?? null }
  if (!hasContent.value)
    return { disabled: true, reason: null }
  return { disabled: false, reason: null }
})

// ---------- focus and text ----------

/** Focuses the textarea; automatic focus (`force` false) never happens on touch devices (it opens the keyboard). */
function focusTextarea(options: { force?: boolean } = {}) {
  if (isTouch.value && !options.force)
    return
  textarea.value?.focus({ preventScroll: true })
}

function syncCaret() {
  caret.value = textarea.value?.selectionStart ?? text.value.length
}

function setTextAndCaret(value: string, position = value.length, options: { force?: boolean } = {}) {
  text.value = value
  caret.value = position
  void nextTick(() => {
    textarea.value?.setSelectionRange(position, position)
    focusTextarea(options)
    autosize()
  })
}

function clearText() {
  draft.clear()
  caret.value = 0
  slashDismissed.value = null
}

// `field-sizing: content` grows the textarea natively; elsewhere its height follows the content (max 40vh in CSS).
const nativeAutosize = typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('field-sizing', 'content')
function autosize() {
  const element = textarea.value
  if (nativeAutosize || !element)
    return
  element.style.height = 'auto'
  element.style.height = `${element.scrollHeight}px`
}
watch(text, () => void nextTick(autosize))

// ---------- client commands ----------

function selectModel(modelRef: string) {
  if (modelRef !== props.modelRef)
    emit('update:modelRef', modelRef)
  models.touchRecent(modelRef)
}

/** From the picker, which already recorded the model as recent. */
function onModelPicked(modelRef: string | null) {
  if (modelRef && modelRef !== props.modelRef)
    emit('update:modelRef', modelRef)
}

function openMenu(menu: 'model' | 'effort' | 'mode') {
  if (menu === 'model')
    pickerOpen.value = true
  else if (menu === 'effort')
    effortOpen.value = true
  else
    permissionOpen.value = true
}

function runClientCommand(name: ClientCommand, args: string) {
  const action = resolveClientCommand(name, args, {
    resolveModel: query => resolveModelQuery(query, models.visible, modelRef => models.byRef(modelRef)),
    efforts: current.efforts.value,
    toolsAvailable: current.toolsAvailable.value,
  })
  if (action.type === 'error') {
    toast.error(action.message)
    return
  }
  clearText()
  switch (action.type) {
    case 'new':
      void navigateTo('/')
      ui.requestComposerFocus()
      break
    case 'help':
      ui.openShortcuts()
      break
    case 'open':
      openMenu(action.menu)
      break
    case 'set-model':
      selectModel(action.modelRef)
      break
    case 'set-effort':
      emit('update:reasoningEffort', action.effort)
      break
    case 'set-mode':
      emit('update:toolMode', action.mode)
      break
  }
}

function onSlashSelect(item: SlashItem) {
  const token = firstToken(text.value)
  const rest = text.value.slice(token.length)
  if (item.kind === 'server') {
    const head = `/${item.name} `
    setTextAndCaret(`${head}${rest.replace(/^\s+/, '')}`, head.length, { force: true })
    return
  }
  if (isClientCommand(item.name))
    runClientCommand(item.name, rest.trim())
}

function dismissSlash() {
  slashDismissed.value = firstToken(text.value)
}

/** `+` -> Commands: a `/` at the start opens the slash menu (existing text becomes the argument). */
function startCommand() {
  slashDismissed.value = null
  const value = text.value
  if (value.startsWith('/')) {
    setTextAndCaret(value, firstToken(value).length, { force: true })
    return
  }
  setTextAndCaret(value.trim() ? `/ ${value}` : '/', 1, { force: true })
}

// ---------- attachments ----------

function addFiles(files: File[]) {
  if (files.length > 0)
    attachments.add(files)
}

function openFilePicker() {
  fileInput.value?.click()
}

function onFilesPicked(event: Event) {
  const input = event.target as HTMLInputElement
  addFiles(Array.from(input.files ?? []))
  input.value = ''
}

/**
 * Pasted files are attached. Rich text from office apps also carries a rendered image of the selection: when the
 * clipboard holds both plain text and HTML, the text is pasted as usual.
 */
function onPaste(event: ClipboardEvent) {
  const types = Array.from(event.clipboardData?.types ?? [])
  if (types.includes('text/plain') && types.includes('text/html'))
    return
  const files = Array.from(event.clipboardData?.items ?? [])
    .filter(item => item.kind === 'file')
    .map(item => item.getAsFile())
    .filter((file): file is File => file !== null)
  if (files.length === 0)
    return
  event.preventDefault()
  addFiles(files)
}

const drop = useComposerDropZone({
  onFiles: addFiles,
  pane: () => root.value?.closest('[data-slot="sidebar-inset"]') ?? root.value?.closest('main') ?? null,
})

// ---------- submit ----------

let submitting = false

async function submit() {
  if (submitting || running.value)
    return
  const command = parseClientCommand(text.value)
  if (command) {
    runClientCommand(command.name, command.args)
    return
  }
  if (sendState.value.disabled)
    return
  submitting = true
  try {
    if (attachments.uploading.value) {
      pendingSubmit.value = true
      await attachments.settled()
      pendingSubmit.value = false
      // Uploads may have failed or been removed meanwhile, or a response may have started.
      if (running.value || sendState.value.disabled)
        return
    }
    const input: ComposerSubmitInput = { text: text.value.trim(), files: attachments.fileRefs.value }
    if (props.modelRef)
      models.touchRecent(props.modelRef)
    emit('submit', input)
    clearText()
    attachments.clear()
    focusTextarea()
  }
  finally {
    submitting = false
    pendingSubmit.value = false
  }
}

// ---------- keyboard ----------

function onKeydown(event: KeyboardEvent) {
  if (isComposingEvent(event))
    return
  if (slashMenu.value?.handleKeydown(event))
    return
  const plain = !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey
  if (event.key === 'Escape') {
    if (plain && running.value) {
      event.preventDefault()
      emit('stop')
    }
    return
  }
  if (event.key === 'ArrowUp') {
    if (plain && text.value === '' && !running.value) {
      event.preventDefault()
      // eslint-disable-next-line vue/custom-event-name-casing -- contract name from docs/UI.md 10.4
      emit('edit-last')
    }
    return
  }
  if (enterKeyAction(event, sendKey.value) === 'send') {
    event.preventDefault()
    void submit()
  }
}

useComposerShortcuts({
  openModelPicker: () => {
    pickerOpen.value = true
  },
  openEffortMenu: () => {
    effortOpen.value = true
  },
  openPermissionMenu: () => {
    permissionOpen.value = true
  },
  stop: () => emit('stop'),
  canOpenEffort: () => current.efforts.value.length > 0,
  canOpenPermission: () => current.toolsAvailable.value,
  canStop: () => running.value,
  sendKey: () => sendKey.value,
})

// ---------- lifecycle ----------

watch(() => props.chatId, () => {
  attachments.clear()
  slashDismissed.value = null
  pendingSubmit.value = false
  void nextTick(() => {
    syncCaret()
    autosize()
  })
})

watch(() => ui.composerFocusRequest, () => focusTextarea())

onMounted(() => {
  loadComposerCatalog()
  syncCaret()
  autosize()
  focusTextarea()
})

const exposed: ChatComposerExposed = {
  focus: () => focusTextarea(),
  setText: (value: string) => setTextAndCaret(value, value.length),
  openModelPicker: () => {
    pickerOpen.value = true
  },
}
defineExpose(exposed)

// The AI Elements card (an InputGroup inside the prompt input form) restyled as the composer: 20px radius,
// card surface, subtle shadow, focus shown on the border only (docs/UI.md 3.7).
const CARD_CLASS = [
  '*:data-[slot=input-group]:h-auto *:data-[slot=input-group]:rounded-[20px]',
  '*:data-[slot=input-group]:border-border! *:data-[slot=input-group]:bg-card! *:data-[slot=input-group]:shadow-sm!',
  '*:data-[slot=input-group]:ring-0! *:data-[slot=input-group]:focus-within:border-ring/60!',
  '*:data-[slot=input-group]:transition-[border-color] *:data-[slot=input-group]:duration-(--duration-fast)',
].join(' ')

const TEXTAREA_CLASS = [
  'min-h-11 max-h-[40vh] overflow-y-auto px-4 pt-3 pb-1',
  'text-base leading-6 md:text-[15px]',
  'placeholder:text-muted-foreground',
].join(' ')
</script>

<template>
  <div
    ref="root"
    :data-testid="testIds.composer"
    :data-status="status"
    class="relative w-full"
  >
    <SlashMenu
      ref="slashMenu"
      :open="slashOpen"
      :query="slashQuery ?? ''"
      :items="slashItems"
      @select="onSlashSelect"
      @close="dismissSlash"
    />

    <input
      ref="fileInput"
      type="file"
      multiple
      class="hidden"
      tabindex="-1"
      aria-hidden="true"
      :accept="COMPOSER_ACCEPT"
      :data-testid="testIds.composerFileInput"
      @change="onFilesPicked"
    >

    <AiPromptInput role="form" aria-label="Message composer" :class="CARD_CLASS" @submit="submit">
      <AiPromptInputHeader v-if="attachmentItems.length > 0 || warnings.length > 0" class="cursor-default px-3 pt-3 pb-0">
        <ComposerAttachments
          :items="attachmentItems"
          :warnings="warnings"
          @remove="attachments.remove"
          @retry="attachments.retry"
        />
      </AiPromptInputHeader>

      <InputGroupTextarea
        ref="textarea"
        v-model="text"
        name="message"
        rows="1"
        :placeholder="placeholder"
        aria-label="Message"
        aria-autocomplete="list"
        :aria-controls="slashOpen ? slashMenu?.listId : undefined"
        :aria-activedescendant="slashOpen ? slashMenu?.activeId : undefined"
        :enterkeyhint="sendKey === 'enter' ? 'send' : 'enter'"
        :data-testid="testIds.composerInput"
        :class="TEXTAREA_CLASS"
        @keydown="onKeydown"
        @paste="onPaste"
        @input="syncCaret"
        @keyup="syncCaret"
        @click="syncCaret"
        @select="syncCaret"
        @focus="syncCaret"
      />

      <AiPromptInputFooter class="cursor-default gap-2 px-2 pt-1 pb-2">
        <AiPromptInputTools class="min-w-0 flex-1 gap-0.5">
          <ComposerAddMenu :return-focus-to="focusTarget" @attach="openFilePicker" @commands="startCommand" />
          <ModelPicker
            v-model:open="pickerOpen"
            :model-value="modelRef"
            :return-focus-to="focusTarget"
            class="min-w-0"
            @update:model-value="onModelPicked"
          />
          <EffortMenu
            v-model:open="effortOpen"
            :model-value="reasoningEffort"
            :model-ref="modelRef"
            :return-focus-to="focusTarget"
            @update:model-value="value => emit('update:reasoningEffort', value)"
          />
        </AiPromptInputTools>
        <AiPromptInputTools class="shrink-0 gap-1">
          <PermissionMenu
            v-if="current.toolsAvailable.value"
            v-model:open="permissionOpen"
            :model-value="toolMode"
            :return-focus-to="focusTarget"
            @update:model-value="value => emit('update:toolMode', value)"
          />
          <ContextRing :usage="usage" :context-window="current.contextWindow.value" :chat-cost-usd="chatCostUsd" />
          <SendStopButton
            :running="running"
            :disabled="sendState.disabled"
            :pending="pendingSubmit"
            :reason="sendState.reason"
            :send-key="sendKey"
            @send="submit"
            @stop="emit('stop')"
          />
        </AiPromptInputTools>
      </AiPromptInputFooter>
    </AiPromptInput>

    <DropOverlay :active="drop.active.value" :rect="drop.rect.value" />
  </div>
</template>
