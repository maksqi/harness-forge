<script setup lang="ts">
// Chat composer (docs/UI.md 2.11, 5.8, 7.7-7.12, 7.17, 10.4), rendered by ChatView (W2.2). A 20px-rounded card on the
// AI Elements `PromptInput`: attachment chips, an autosizing textarea (1 line up to 40vh), and the toolbar
// [+ | model | effort | image options] ... [permission | context ring | mic | send/stop]. The composer never calls
// `useChat`: it emits `submit` with the trimmed text and the uploaded files, `stop`, `edit-last` (↑ in an empty
// composer) and the v-model updates of model, effort and permission mode. Client slash commands (`/new`, `/model`,
// `/effort`, `/mode`, `/help`) run here and never reach the server. The unsent text is kept per chat
// (useComposerDraft).
// Phase 6: image models (ADR-028) get the placeholder "Describe an image…", ImageOptionsMenu (useImageOptions; "Edit
// the previous image" when `previousImages` > 0), no context ring, and Send needs a prompt of at most 32,000
// characters. Dictation (ADR-029, useVoiceInput): MicButton before Send (click or Alt+V), RecordingIndicator instead of
// the left tools while recording or transcribing, the transcript inserted at the caret saved when the recording
// started (insertDictation), Esc cancels a recording or a transcription before it stops a response, starting a
// recording stops read-aloud, Send stays disabled while voice input runs, and a polite live region announces the
// dictation steps.
// Phase 7: `projectId` marks a project chat, where PermissionMenu offers Accept edits (also shown while it is the
// current value) and `/mode edits` selects it; elsewhere `/mode edits` explains "Accept edits works in project chats."
// Phase 9 (ADR-041, ADR-042; C25 wired it, W9.8 / W9.10 implement; frozen from Gate P9-0b): MentionMenu after SlashMenu
// (`useFileMentions`, project chats only; never for `a@b`): picking a file inserts its mention and a blank and attaches
// it as a project chip (`attachments.addProject`; the chip and the text are independent), picking a folder inserts
// `@folder/` and keeps the menu open, "Mention a file" in the `+` menu inserts `@` at the caret. The keydown chain is
// mention menu -> slash menu -> Shift+Tab mode cycle (`useModeCycle`, W9.10); the textarea's `aria-controls` /
// `aria-activedescendant` follow whichever menu is open. While a run is active the composer stays usable: the
// placeholder reads "Queue a message…", Send (the send key or "Queue message" left of Stop, `canQueue`) emits `submit`
// as usual and the session queues it (ChatView, W9.9); Esc still stops. `restoreQueued(items)` (exposed) puts queued
// messages back: their texts appended to the draft with blank lines between them, their files as done chips.
import type { ClientCommand, ImageOptions, MessageUsage, ProjectFileEntry, QueueItem, ReasoningEffort, ToolMode } from '@harness-forge/shared'
import type { ChatStatus } from 'ai'
import type { DictationRange } from './dictation'
import type { SlashItem } from './slash-commands'
import type { ChatComposerExposed, ComposerSubmitInput } from './types'
import { isClientCommand, LIMITS } from '@harness-forge/shared'
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
import { focusInOverlay, useComposerShortcuts } from '~/composables/useComposerShortcuts'
import { useFileMentions } from '~/composables/useFileMentions'
import { useImageOptions } from '~/composables/useImageOptions'
import { useShortcuts } from '~/composables/useShortcuts'
import { useSpeechPlayer } from '~/composables/useSpeechPlayer'
import { useVoiceInput } from '~/composables/useVoiceInput'
import { useModelsStore } from '~/stores/models'
import { usePluginsStore } from '~/stores/plugins'
import { useProjectsStore } from '~/stores/projects'
import { useProvidersStore } from '~/stores/providers'
import { useSettingsStore } from '~/stores/settings'
import { useUiStore } from '~/stores/ui'
import { testIds } from '~/utils/testids'
import { queueItemFiles, restoredDraft } from '../queue/queued-messages'
import { capabilityWarnings, COMPOSER_ACCEPT } from './attachments'
import ComposerAddMenu from './ComposerAddMenu.vue'
import ComposerAttachments from './ComposerAttachments.vue'
import ContextRing from './ContextRing.vue'
import { DICTATION_SHORTCUT, dictationErrorToast, insertDictation } from './dictation'
import DropOverlay from './DropOverlay.vue'
import EffortMenu from './EffortMenu.vue'
import ImageOptionsMenu from './ImageOptionsMenu.vue'
import { mentionErrorMessage, projectAttachErrorText } from './mention-menu'
import MentionMenu from './MentionMenu.vue'
import MicButton from './MicButton.vue'
import { useModeCycle } from './mode-cycle'
import { isPickerModel, resolveModelQuery } from './model-picker'
import ModelPicker from './ModelPicker.vue'
import { navigateTo } from './nuxt-imports'
import { offeredToolModes } from './permission'
import PermissionMenu from './PermissionMenu.vue'
import RecordingIndicator from './RecordingIndicator.vue'
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
  /** An image model always shows "Describe an image…" instead. */
  placeholder?: string
  /** Images of the last assistant message on the path; > 0 shows "Edit the previous image" (ImageOptionsMenu). */
  previousImages?: number
  /**
   * + Phase 7 (C15 declares it, W7.12 uses it): the chat's project; a project chat offers Accept edits in the
   * PermissionMenu. null = none.
   */
  projectId?: string | null
}>(), {
  usage: null,
  chatCostUsd: null,
  disabled: false,
  placeholder: 'Reply…',
  previousImages: 0,
  projectId: null,
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
const projects = useProjectsStore()
const providers = useProvidersStore()
const settings = useSettingsStore()
const ui = useUiStore()

const root = useTemplateRef<HTMLElement>('root')
const textareaComponent = useTemplateRef<InstanceType<typeof InputGroupTextarea>>('textarea')
const fileInput = useTemplateRef<HTMLInputElement>('fileInput')
const slashMenu = useTemplateRef<InstanceType<typeof SlashMenu>>('slashMenu')
const mentionMenu = useTemplateRef<InstanceType<typeof MentionMenu>>('mentionMenu')
const micButton = useTemplateRef<InstanceType<typeof MicButton>>('micButton')
const textarea = computed(() => (textareaComponent.value?.$el as HTMLTextAreaElement | undefined) ?? null)

const isTouch = useMediaQuery('(pointer: coarse)')
const draft = useComposerDraft(() => props.chatId)
const text = draft.text
const current = useComposerModel(() => props.modelRef)
const attachments = useComposerAttachments({
  onReject: ({ name, reason, message, source, path, error }) => {
    // A project file of an `@` mention (docs/UI.md 7.26).
    if (source === 'project') {
      const title = `${path ?? name} can't be attached`
      const description = error ? projectAttachErrorText(error) : message
      if (description)
        toast.error(title, { description })
      else
        toast.error(title)
      return
    }
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
const imageOptionsOpen = ref(false)
const pendingSubmit = ref(false)
const caret = ref(0)
/** First token at which the user closed the slash menu (Esc); it reopens once the token changes. */
const slashDismissed = ref<string | null>(null)

const running = computed(() => props.status === 'submitted' || props.status === 'streaming')
const sendKey = computed(() => settings.resolved.sendKey)
const focusTarget = computed(() => (isTouch.value ? null : textarea.value))

// ---------- image models (ADR-028) ----------

const imageOptions = useImageOptions()
const isImageModel = computed(() => current.model.value?.kind === 'image')
/** Phase 9: while a run is active, what is sent joins the chat's queue. */
const effectivePlaceholder = computed(() => {
  if (running.value)
    return 'Queue a message…'
  return isImageModel.value ? 'Describe an image…' : props.placeholder
})

function onImageOptionsChange(value: ImageOptions) {
  imageOptions.set({ n: value.n, aspectRatio: value.aspectRatio, editPrevious: value.editPrevious })
}

// ---------- dictation (ADR-029) ----------

const voice = useVoiceInput({ onTranscript: onDictation, onError: onDictationError })
const voiceState = voice.state
/** Voice input runs (asking for the microphone, recording or transcribing): Send is disabled, Esc cancels it. */
const voiceBusy = computed(() => voiceState.value !== 'idle')
/** The recording indicator replaces the left tools (and the permission menu and context ring step aside). */
const voiceIndicator = computed(() => voiceState.value === 'recording' || voiceState.value === 'transcribing')
/** A running dictation finishes even if the setting changes meanwhile. */
const dictationConfigured = computed(() => settings.resolved.transcriptionModelRef !== null || voiceBusy.value)

/** The caret (or selection) and the text when the recording started: where the transcript goes. */
let dictationStart: (DictationRange & { text: string }) | null = null
/** How the current dictation ended, for the live region: a transcript or an error (else it was canceled). */
let dictationOutcome: 'transcript' | 'error' | null = null

const announcement = ref('')
/** The polite live region (the same text twice is announced twice). */
function announce(message: string) {
  announcement.value = ''
  void nextTick(() => {
    announcement.value = message
  })
}

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

// ---------- file mentions (Phase 9, ADR-042; W9.8) ----------

const mentions = useFileMentions({ projectId: computed(() => props.projectId), text, caret })
const mentionOpen = mentions.open
const mentionProjectName = computed(() => (props.projectId ? projects.byId(props.projectId)?.name ?? null : null))
const mentionError = computed(() => (mentions.state.value === 'error' ? mentionErrorMessage(mentions.error.value) : null))

/** A picked file replaces the `@` token with its mention and is attached as a project chip; a folder opens it. */
function onMentionSelect(entry: ProjectFileEntry) {
  const projectId = props.projectId
  const next = mentions.apply(entry)
  setTextAndCaret(next.text, next.caret, { force: true })
  if (entry.kind === 'file' && projectId)
    attachments.addProject(projectId, entry.path)
}

/** `+` -> "Mention a file": `@` at the caret (a blank before it when needed) opens the menu. */
function startMention() {
  const value = text.value
  const element = textarea.value
  const start = Math.min(element?.selectionStart ?? caret.value, value.length)
  const end = Math.max(Math.min(element?.selectionEnd ?? start, value.length), start)
  const before = value.slice(0, start)
  const after = value.slice(end)
  const head = before === '' || /\s$/.test(before) ? '@' : ' @'
  // A word right after the caret would become the query: keep it apart.
  const tail = after === '' || /^\s/.test(after) ? after : ` ${after}`
  setTextAndCaret(`${before}${head}${tail}`, before.length + head.length, { force: true })
}

/** The open menu the textarea's `aria-controls` / `aria-activedescendant` point at. */
const openMenuRef = computed(() => {
  if (mentionOpen.value)
    return mentionMenu.value
  return slashOpen.value ? slashMenu.value : null
})

// ---------- send state ----------

const warnings = computed(() => capabilityWarnings(attachmentItems.value, current.model.value))
const typedClientCommand = computed(() => parseClientCommand(text.value) !== null)
const hasContent = computed(() => text.value.trim() !== '' || attachmentItems.value.length > 0)
/** + Phase 9: "Queue message" next to Stop while a run is active and there is something to send (W9.8). */
const canQueue = computed(() => running.value && hasContent.value)

/** Why Send is disabled (tooltip), or enabled. Client commands always run. */
const sendState = computed<{ disabled: boolean, reason: string | null }>(() => {
  if (voiceBusy.value)
    return { disabled: true, reason: 'Finish dictation first' }
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
  if (isImageModel.value) {
    // The text is the prompt of an image turn (docs/UI.md 7.7).
    const prompt = text.value.trim()
    if (!prompt)
      return { disabled: true, reason: null }
    if (prompt.length > LIMITS.imagePromptMaxChars)
      return { disabled: true, reason: `The prompt can be up to ${LIMITS.imagePromptMaxChars.toLocaleString('en-US')} characters` }
  }
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
  // The menus sit in the tools the recording indicator replaces.
  if (voiceIndicator.value)
    return
  if (menu === 'model')
    pickerOpen.value = true
  else if (menu === 'effort')
    effortOpen.value = true
  else
    permissionOpen.value = true
}

// ---------- permission mode (Accept edits: project chats, ADR-032) ----------

const projectChat = computed(() => props.projectId !== null)
const permissionModes = computed(() => offeredToolModes({ projectChat: projectChat.value, current: props.toolMode }))

// Shift+Tab cycles the permission mode (Phase 9, ADR-041; W9.10): only while the permission menu shows and no menu is
// open; otherwise the native reverse focus move happens.
const modeCycle = useModeCycle({
  enabled: () => settings.resolved.shiftTabModes && current.toolsAvailable.value && !voiceIndicator.value
    && !slashOpen.value && !mentionOpen.value,
  current: () => props.toolMode,
  projectChat: () => projectChat.value,
  set: mode => emit('update:toolMode', mode),
  announce: message => announce(message),
})

function runClientCommand(name: ClientCommand, args: string) {
  const action = resolveClientCommand(name, args, {
    resolveModel: query => resolveModelQuery(query, models.visible.filter(isPickerModel), modelRef => models.byRef(modelRef)),
    efforts: current.efforts.value,
    toolsAvailable: current.toolsAvailable.value,
    projectChat: projectChat.value,
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

// Phase 9: a running response no longer blocks sending (ChatView queues the message); dictation and uploads still do.
async function submit() {
  if (submitting || voiceBusy.value)
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
      // Uploads may have failed or been removed meanwhile.
      if (sendState.value.disabled)
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
  // The mention menu first, then the slash menu, then Shift+Tab (Phase 9).
  if (mentionMenu.value?.handleKeydown(event))
    return
  if (slashMenu.value?.handleKeydown(event))
    return
  if (modeCycle.handleKeydown(event))
    return
  const plain = !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey
  if (event.key === 'Escape') {
    if (plain && voiceBusy.value) {
      event.preventDefault()
      cancelDictation()
      return
    }
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
  openModelPicker: () => openMenu('model'),
  openEffortMenu: () => openMenu('effort'),
  openPermissionMenu: () => openMenu('mode'),
  stop: () => emit('stop'),
  canOpenEffort: () => !voiceIndicator.value && current.efforts.value.length > 0,
  canOpenPermission: () => !voiceIndicator.value && current.toolsAvailable.value,
  canStop: () => running.value,
  sendKey: () => sendKey.value,
})

// ---------- dictation ----------

function saveDictationStart() {
  const element = textarea.value
  const start = element?.selectionStart ?? caret.value
  dictationStart = { start, end: element?.selectionEnd ?? start, text: text.value }
}

/** The saved caret, unless the text changed during the recording (then the current caret). */
function dictationTarget(): DictationRange {
  if (dictationStart && dictationStart.text === text.value)
    return dictationStart
  const element = textarea.value
  const start = element?.selectionStart ?? text.value.length
  return { start, end: element?.selectionEnd ?? start }
}

/** The mic (click or Alt+V): idle -> record, recording -> transcribe, transcribing -> cancel. */
function onMicToggle() {
  if (voiceState.value === 'idle') {
    dictationOutcome = null
    saveDictationStart()
    useSpeechPlayer().stop()
  }
  void voice.toggle()
}

function cancelDictation() {
  if (voiceBusy.value)
    voice.cancel()
}

/** Cancel of the recording indicator: the button goes away with it, so the textarea takes the focus (desktop). */
function onRecordingCancel() {
  cancelDictation()
  focusTextarea()
}

function onDictation(transcript: string) {
  dictationOutcome = 'transcript'
  const target = dictationTarget()
  dictationStart = null
  if (!transcript) {
    toast('No speech detected')
    return
  }
  const result = insertDictation(text.value, transcript, target)
  setTextAndCaret(result.text, result.caret)
  announce('Transcript added')
}

function onDictationError(error: unknown) {
  dictationOutcome = 'error'
  dictationStart = null
  const { title, description } = dictationErrorToast(error, providerId => providers.byId(providerId)?.name)
  if (description)
    toast.error(title, { description })
  else
    toast.error(title)
}

watch(voiceState, (next, previous) => {
  if (next === 'recording')
    announce('Recording started')
  else if (next === 'transcribing')
    announce('Transcribing…')
  else if (next === 'idle' && (previous === 'recording' || previous === 'transcribing') && dictationOutcome === null)
    announce('Recording canceled')
})

// Registered after the composer shortcuts: for Esc the latest registration whose `when` passes wins, so a running
// dictation is canceled before a response is stopped (docs/UI.md 12).
useShortcuts().register([
  {
    id: 'composer-dictate',
    keys: DICTATION_SHORTCUT,
    description: 'Dictate',
    group: 'Composer',
    alt: true,
    allowInInputs: true,
    when: () => voice.supported && voice.secure && (!props.disabled || voiceBusy.value) && !focusInOverlay(),
    handler: () => micButton.value?.activate(),
  },
  {
    id: 'composer-dictation-cancel',
    keys: 'escape',
    description: 'Cancel dictation',
    group: 'Composer',
    when: () => voiceBusy.value && !focusInOverlay(),
    handler: () => cancelDictation(),
  },
])

// ---------- lifecycle ----------

watch(() => props.chatId, () => {
  attachments.clear()
  slashDismissed.value = null
  pendingSubmit.value = false
  cancelDictation()
  dictationStart = null
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

/** Queued messages back into the composer (after a Stop, or Edit of a queued message): texts and files. */
function restoreQueued(items: readonly QueueItem[]) {
  if (items.length === 0)
    return
  const value = restoredDraft(text.value, items)
  setTextAndCaret(value, value.length)
  attachments.addRefs(items.flatMap(queueItemFiles))
  toast('Queued messages moved back to the composer.')
}

const exposed: ChatComposerExposed = {
  focus: () => focusTextarea(),
  setText: (value: string) => setTextAndCaret(value, value.length),
  openModelPicker: () => openMenu('model'),
  restoreQueued,
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

    <MentionMenu
      ref="mentionMenu"
      :open="mentionOpen"
      :query="mentions.token.value?.query ?? ''"
      :items="mentions.items.value"
      :state="mentions.state.value"
      :error-message="mentionError"
      :truncated="mentions.truncated.value"
      :project-name="mentionProjectName"
      @select="onMentionSelect"
      @close="mentions.dismiss()"
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
        :placeholder="effectivePlaceholder"
        aria-label="Message"
        aria-autocomplete="list"
        :aria-controls="openMenuRef?.listId"
        :aria-activedescendant="openMenuRef?.activeId"
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
          <RecordingIndicator
            v-if="voiceIndicator"
            :elapsed-ms="voice.elapsedMs.value"
            :transcribing="voiceState === 'transcribing'"
            @cancel="onRecordingCancel"
          />
          <template v-else>
            <ComposerAddMenu
              :return-focus-to="focusTarget"
              :project-chat="projectChat"
              @attach="openFilePicker"
              @commands="startCommand"
              @mention="startMention"
            />
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
            <ImageOptionsMenu
              v-model:open="imageOptionsOpen"
              :model-value="imageOptions.options.value"
              :model-ref="modelRef"
              :previous-images="previousImages"
              :return-focus-to="focusTarget"
              @update:model-value="onImageOptionsChange"
            />
          </template>
        </AiPromptInputTools>
        <AiPromptInputTools class="shrink-0 gap-1">
          <PermissionMenu
            v-if="current.toolsAvailable.value && !voiceIndicator"
            v-model:open="permissionOpen"
            :model-value="toolMode"
            :modes="permissionModes"
            :return-focus-to="focusTarget"
            @update:model-value="value => emit('update:toolMode', value)"
          />
          <ContextRing
            v-if="!isImageModel && !voiceIndicator"
            :usage="usage"
            :context-window="current.contextWindow.value"
            :chat-cost-usd="chatCostUsd"
          />
          <MicButton
            v-if="voice.supported"
            ref="micButton"
            :state="voiceState"
            :configured="dictationConfigured"
            :secure="voice.secure"
            :level="voice.level.value"
            :disabled="disabled && !voiceBusy"
            @toggle="onMicToggle"
          />
          <SendStopButton
            :running="running"
            :disabled="sendState.disabled"
            :pending="pendingSubmit"
            :reason="sendState.reason"
            :send-key="sendKey"
            :can-queue="canQueue"
            @send="submit"
            @stop="emit('stop')"
            @queue="submit"
          />
        </AiPromptInputTools>
      </AiPromptInputFooter>
    </AiPromptInput>

    <DropOverlay :active="drop.active.value" :rect="drop.rect.value" />

    <p class="sr-only" aria-live="polite" aria-atomic="true" data-slot="composer-announcer">
      {{ announcement }}
    </p>
  </div>
</template>
