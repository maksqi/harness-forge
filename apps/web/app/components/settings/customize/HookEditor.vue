<script setup lang="ts">
// The hook editor of the Customize Hooks tab (Phase 11, ADR-048; docs/UI.md 2.18, 2.19, 9.13, 9.14, 10.8, 10.9, 14): a
// right Sheet (`w-full sm:max-w-2xl`, full width on phones) whose body scrolls under a sticky footer, titled "New hook" /
// "Edit hook" / "Copy hook" / "Edit project hook" / "New project hook". The warning (`hook-warning`; the prompt hook's
// own text for the Prompt type), Where (new hooks while a project is selected: Personal or one of the project's four
// settings files, `data-field="hook-where"`), Type (`hook-type`, Command | Prompt), Event (`hook-event`, a Select of the
// 13 events with their descriptions from `HOOK_EVENT_INFO`; a prompt hook on an event that takes none shows "Prompt hooks
// work only for {events}." and cannot be saved), Tools (`hook-matcher`, tool events only, mono, checked with the shared
// `compileMatcher`; the preview `hook-matcher-preview` "Matches {list}" / "No tool is named {name} now." through
// `matcherPreview` over the tools store, debounced 300 ms, `aria-live="polite"`) or Agent types (`hook-matcher` on
// SubagentStart / SubagentStop); a command hook's Command (`hook-command`, a mono textarea), Arguments (one per line,
// `data-field="hook-args"`) and Run in the background (`data-field="hook-async"`); a prompt hook's Prompt (`hook-prompt`,
// mono), Model (SettingsModelSelect, none = "Hook model", `data-field="hook-model"`) with the line "Runs with {model}
// (Settings → General → Hook model). It answers ok, or not ok with a reason." and Continue on block (PreToolUse and
// PostToolUse, `data-field="hook-continue-on-block"`); Only when (`if`, tool events, `data-field="hook-if"`), Status
// message (`data-field="hook-status-message"`), Timeout (`hook-timeout`, 1 – 600 seconds, empty = 60, 30 for a prompt
// hook) and On (`hook-editor-enabled`; personal hooks only: settings files have no on / off). TanStack Form holds the
// fields; the inline errors show once a field was left or a save was tried.
// Save hook (`hook-save`, also Mod+Enter in any field): a personal hook → `useFreshAuth().run(() => hooks.create(body) |
// hooks.update(id, patch), { required })` ("Saving a hook needs your password."; an edit that only turns the hook off
// needs none; the bodies from `hookCreateBody` / `hookPatch`) → toast "Hook saved", `saved`, close. A project hook
// (mode `project` with `target`, or Where = a settings file) → `hooks.saveProjectHook(projectId, target, draft)` (no
// password: saving never approves) → toast "Saved {path}." or "Saved {path}. {n} items need your approval." with Review
// (opens ProjectTrustDialog for the project) → close, without `saved` (no personal hook). A 409 `stale` (the file
// changed after the editor opened: the server's answer, the store's check, or the listing refetched meanwhile shows
// another handler at the target) shows "{file} changed on disk after you opened it." (`data-field="hook-stale"`,
// `role="alert"`) with Load from disk (`data-action="reload"`: the listed handler replaces the edits) and Overwrite
// (`data-action="overwrite"`: refetches the listing and saves again). A 400 on the matcher shows on the field; any other
// error shows in the form-level alert (`hook-error`, `data-code`). Closing with changes (Esc, ×, Cancel, a click
// outside) asks "Discard changes?" (`hook-discard-confirm`). Opens with focus on Event (new, copy) or Command / Prompt
// (edit, project); reka returns focus to the element that had it when the sheet opened. Tab is never captured.
// Props, emits and the root test id are frozen from Gate P11-0b (C39 stub, + the Phase 12 `mode: 'project'` / `target`
// of C46); implementation W11.8, Phase 12 W12.12.
import type { HookEvent, ModelAliasName, PersonalHook } from '@harness-forge/shared'
import type { AcceptableValue } from 'reka-ui'
import type { HookDraft, ProjectHookTarget } from './hooks'
import { HOOK_EVENTS, HOOK_LIMITS, isHookTurnOff, MODEL_ALIAS_NAMES } from '@harness-forge/shared'
import { CircleAlertIcon, MessageSquareTextIcon, SquareTerminalIcon, TriangleAlertIcon } from '@lucide/vue'
import { useForm } from '@tanstack/vue-form'
import { refDebounced } from '@vueuse/core'
import { computed, nextTick, ref, shallowRef, useId, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import ConfirmDialog from '~/components/common/ConfirmDialog.vue'
import ConfirmPasswordDialog from '~/components/common/ConfirmPasswordDialog.vue'
import ProjectTrustDialog from '~/components/projects/trust/ProjectTrustDialog.vue'
import { loadModelCatalog } from '~/composables/useComposerModel'
import { isFreshAuthCancelled, useFreshAuth } from '~/composables/useFreshAuth'
import { useHooksStore } from '~/stores/hooks'
import { useModelsStore } from '~/stores/models'
import { usePluginsStore } from '~/stores/plugins'
import { useSettingsStore } from '~/stores/settings'
import { toHarnessError } from '~/utils/errors'
import { testIds } from '~/utils/testids'
import SettingsModelSelect from '../SettingsModelSelect.vue'
import {
  argsError,
  commandError,
  draftFromHook,
  draftFromPersonal,
  fullDraft,
  HOOK_COPY,
  HOOK_EVENT_INFO,
  hookCreateBody,
  hookPatch,
  ifError,
  matcherError,
  matcherPreview,
  parseHookArgs,
  parseHookTimeout,
  PROJECT_HOOK_FILES,
  projectEntryAt,
  projectSavedText,
  promptError,
  promptEventError,
  promptModelLine,
  sameHandler,
  staleFileText,
  statusMessageError,
} from './hooks'

const props = defineProps<{
  open: boolean
  /** + Phase 12: `project` edits a hook of a project's settings file (`target`). */
  mode: 'new' | 'edit' | 'copy' | 'project'
  /** Edit mode: the personal hook. */
  hook: PersonalHook | null
  /** New (Duplicate, Copy to personal), copy and project mode: the prefilled fields. */
  draft?: HookDraft | null
  /**
   * + Phase 12, project mode: where the hook is written (null indexes = a new handler). New mode: the selected project,
   * whose settings files the Where select offers (its path and indexes are not used).
   */
  target?: ProjectHookTarget | null
}>()

const emit = defineEmits<{ 'update:open': [open: boolean], 'saved': [hook: PersonalHook] }>()

type HookType = 'command' | 'prompt'

interface FormValues {
  /** 'personal' or a project settings file (new mode with a project). */
  where: string
  type: HookType
  event: HookEvent
  matcher: string
  command: string
  /** One argument per line. */
  args: string
  async: boolean
  prompt: string
  model: string | null
  continueOnBlock: boolean
  if: string
  statusMessage: string
  timeout: string
  enabled: boolean
}

type Field = 'event' | 'matcher' | 'command' | 'args' | 'prompt' | 'if' | 'statusMessage' | 'timeout'

/** How long the matcher preview waits after the last keystroke. */
const PREVIEW_DELAY_MS = 300
const PERSONAL = 'personal'
/** Events whose prompt hooks read Continue on block. */
const CONTINUE_EVENTS: ReadonlySet<HookEvent> = new Set(['PreToolUse', 'PostToolUse'])

const hooks = useHooksStore()
const plugins = usePluginsStore()
const models = useModelsStore()
const settings = useSettingsStore()
const freshAuth = useFreshAuth()
const ids = {
  where: useId(),
  type: useId(),
  event: useId(),
  eventHelp: useId(),
  matcher: useId(),
  matcherHelp: useId(),
  matcherPreview: useId(),
  command: useId(),
  commandHelp: useId(),
  args: useId(),
  argsHelp: useId(),
  async: useId(),
  asyncHelp: useId(),
  prompt: useId(),
  promptHelp: useId(),
  model: useId(),
  modelLine: useId(),
  continueOnBlock: useId(),
  continueOnBlockHelp: useId(),
  if: useId(),
  ifHelp: useId(),
  statusMessage: useId(),
  statusMessageHelp: useId(),
  timeout: useId(),
  timeoutHelp: useId(),
  enabled: useId(),
  stale: useId(),
}

const EMPTY_DRAFT: HookDraft = { event: 'PreToolUse', matcher: '', command: '', timeout: null, enabled: true }

/** The draft the sheet opened with (its values decide "changed"; Load from disk replaces it). */
const initial = shallowRef<HookDraft>(EMPTY_DRAFT)
/** Project mode: where the save writes (Overwrite and Load from disk may turn it into a new handler). */
const projectTarget = shallowRef<ProjectHookTarget | null>(null)
const submitError = ref<{ code: string, message: string } | null>(null)
/** A matcher the server refused (400 on `matcher`), until the matcher changes. */
const serverMatcher = ref<{ value: string, message: string } | null>(null)
/** The settings file changed after the editor opened (409 `stale`). */
const stale = ref(false)
const discardOpen = ref(false)
const saving = ref(false)
/** The project whose trust review the toast's Review opens. */
const reviewProjectId = ref<string | null>(null)
const reviewOpen = ref(false)

function valuesOf(draft: HookDraft): FormValues {
  const full = fullDraft(draft)
  return {
    where: PERSONAL,
    type: full.type,
    event: full.event,
    matcher: full.matcher,
    command: full.command,
    args: full.args.join('\n'),
    async: full.async,
    prompt: full.prompt,
    model: full.model,
    continueOnBlock: full.continueOnBlock,
    if: full.if,
    statusMessage: full.statusMessage,
    timeout: full.timeout === null ? '' : String(full.timeout),
    enabled: full.enabled,
  }
}

const form = useForm({
  defaultValues: valuesOf(initial.value),
  onSubmit: async () => {
    await save()
  },
})

const values = form.useSelector(state => state.values)
const attempted = form.useSelector(state => state.submissionAttempts > 0)

const whereOffered = computed(() => props.mode === 'new' && !!props.target)
/** Where the shown hook is written: a project target (project mode, or Where = a settings file), else null (personal). */
const writeTarget = computed<ProjectHookTarget | null>(() => {
  if (props.mode === 'project')
    return projectTarget.value
  if (whereOffered.value && values.value.where !== PERSONAL && props.target)
    return { projectId: props.target.projectId, path: values.value.where, event: values.value.event, groupIndex: null, handlerIndex: null }
  return null
})
const isProject = computed(() => writeTarget.value !== null)

const title = computed(() => {
  if (props.mode === 'project')
    return projectTarget.value?.groupIndex === null ? 'New project hook' : 'Edit project hook'
  return ({ new: 'New hook', edit: 'Edit hook', copy: 'Copy hook' } as const)[props.mode]
})

const isPrompt = computed(() => values.value.type === 'prompt')
const eventInfo = computed(() => HOOK_EVENT_INFO[values.value.event])
const toolEvent = computed(() => eventInfo.value.toolMatcher)
const agentEvent = computed(() => eventInfo.value.matcher === 'agent')
const continueShown = computed(() => isPrompt.value && CONTINUE_EVENTS.has(values.value.event))
const dirty = computed(() => JSON.stringify(values.value) !== JSON.stringify(valuesOf(initial.value)))

const errors = computed<Partial<Record<Field, string>>>(() => {
  const found: Partial<Record<Field, string>> = {}
  const current = values.value
  if (toolEvent.value || agentEvent.value) {
    const matcher = matcherError(current.matcher)
      ?? (serverMatcher.value && serverMatcher.value.value === current.matcher ? serverMatcher.value.message : null)
    if (matcher)
      found.matcher = matcher
  }
  if (current.type === 'prompt') {
    const event = promptEventError(current.type, current.event)
    if (event)
      found.event = event
    const prompt = promptError(current.prompt)
    if (prompt)
      found.prompt = prompt
  }
  else {
    const command = commandError(current.command)
    if (command)
      found.command = command
    const args = argsError(parseHookArgs(current.args), current.command)
    if (args)
      found.args = args
  }
  if (toolEvent.value) {
    const rule = ifError(current.if)
    if (rule)
      found.if = rule
  }
  const status = statusMessageError(current.statusMessage)
  if (status)
    found.statusMessage = status
  const timeout = parseHookTimeout(current.timeout)
  if ('error' in timeout)
    found.timeout = timeout.error
  return found
})
const invalid = computed(() => Object.keys(errors.value).length > 0)

// ---------- the matcher preview ----------

const matcherText = computed(() => values.value.matcher)
const debouncedMatcher = refDebounced(matcherText, PREVIEW_DELAY_MS)
const toolNames = computed(() => plugins.tools.map(tool => tool.name))
const preview = computed(() => matcherPreview(debouncedMatcher.value, toolNames.value))

/** The inline error of a field once it was left or a save was tried; a server refusal and the event rule show at once. */
function shownError(field: Field, meta?: { isBlurred: boolean }): string | null {
  const error = errors.value[field]
  if (!error)
    return null
  if ((field === 'matcher' && serverMatcher.value) || field === 'event')
    return error
  return attempted.value || meta?.isBlurred ? error : null
}

// ---------- the prompt's model ----------

function modelName(ref: string): string {
  if (!ref.includes(':')) {
    const alias = (MODEL_ALIAS_NAMES as readonly string[]).includes(ref) ? settings.resolved.modelAliases[ref as ModelAliasName] : null
    return alias ? models.byRef(alias)?.name ?? alias : ref
  }
  return models.byRef(ref)?.name ?? ref
}

const modelLine = computed(() => {
  const own = values.value.model
  if (own)
    return promptModelLine(modelName(own), false)
  const setting = settings.resolved.hookModelRef
  return promptModelLine(setting ? modelName(setting) : HOOK_COPY.automaticModel!, true)
})

/** The model selects and the line read the catalog and the settings: load them once the Prompt type shows. */
function loadPromptData(): void {
  loadModelCatalog()
  if (!settings.loaded)
    settings.fetch().catch(() => {})
}

watch(isPrompt, (prompt) => {
  if (prompt && props.open)
    loadPromptData()
})

// ---------- opening ----------

function openingDraft(): HookDraft {
  if (props.mode === 'edit' && props.hook)
    return draftFromPersonal(props.hook)
  return props.draft ? { ...props.draft } : { ...EMPTY_DRAFT }
}

watch(() => props.open, (open) => {
  if (!open)
    return
  initial.value = openingDraft()
  projectTarget.value = props.mode === 'project' && props.target ? { ...props.target } : null
  form.reset(valuesOf(initial.value))
  submitError.value = null
  serverMatcher.value = null
  stale.value = false
  discardOpen.value = false
  saving.value = false
  if (!plugins.toolsLoaded)
    plugins.fetchTools().catch(() => {})
  if (isPrompt.value)
    loadPromptData()
}, { immediate: true })

function focusField(id: string): void {
  void nextTick(() => document.getElementById(id)?.focus())
}

function onOpenAutoFocus(event: Event): void {
  event.preventDefault()
  if (props.mode === 'edit' || props.mode === 'project')
    focusField(isPrompt.value ? ids.prompt : ids.command)
  else
    focusField(ids.event)
}

// ---------- closing ----------

function requestClose(): void {
  if (saving.value)
    return
  if (dirty.value) {
    discardOpen.value = true
    return
  }
  emit('update:open', false)
}

function onSheetOpenChange(value: boolean): void {
  if (value)
    emit('update:open', true)
  else
    requestClose()
}

function discard(): void {
  discardOpen.value = false
  emit('update:open', false)
}

// ---------- saving ----------

/** The matcher to save: tool and agent events send theirs ('' = every target); other events keep only an unchanged one. */
function matcherOf(current: FormValues): string {
  const subject = HOOK_EVENT_INFO[current.event].matcher
  if (subject === 'tool' || subject === 'agent')
    return current.matcher.trim()
  return current.event === initial.value.event ? initial.value.matcher.trim() : ''
}

function draftOf(current: FormValues): HookDraft {
  const timeout = parseHookTimeout(current.timeout)
  return {
    event: current.event,
    matcher: matcherOf(current),
    command: current.command.trim(),
    timeout: 'value' in timeout ? timeout.value : null,
    enabled: current.enabled,
    type: current.type,
    prompt: current.prompt,
    model: current.model,
    continueOnBlock: current.continueOnBlock,
    args: parseHookArgs(current.args),
    async: current.async,
    if: current.if,
    statusMessage: current.statusMessage,
  }
}

function submit(): void {
  void form.handleSubmit()
}

function onKeydown(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.isComposing || event.key !== 'Enter' || !(event.metaKey || event.ctrlKey))
    return
  event.preventDefault()
  submit()
}

function firstInvalidField(): string | null {
  const order: [Field, string][] = [
    ['event', ids.event],
    ['matcher', ids.matcher],
    ['command', ids.command],
    ['args', ids.args],
    ['prompt', ids.prompt],
    ['if', ids.if],
    ['statusMessage', ids.statusMessage],
    ['timeout', ids.timeout],
  ]
  return order.find(([field]) => errors.value[field])?.[1] ?? null
}

/** The message of a 400 on `matcher`, else null. */
function matcherIssue(error: ReturnType<typeof toHarnessError>): string | null {
  if (error.code !== 'validation_error')
    return null
  const issues = (error.details as { issues?: unknown } | undefined)?.issues
  if (!Array.isArray(issues))
    return null
  const issue = issues.find(item => Array.isArray((item as { path?: unknown })?.path) && (item as { path: unknown[] }).path[0] === 'matcher')
  return issue ? HOOK_COPY.matcherInvalid! : null
}

/** The first error diagnostic of a refused settings file (400 with `details.diagnostics`), else the message. */
function projectErrorMessage(error: ReturnType<typeof toHarnessError>): string {
  const diagnostics = (error.details as { diagnostics?: unknown } | undefined)?.diagnostics
  if (Array.isArray(diagnostics)) {
    const first = diagnostics.find(item => (item as { level?: unknown })?.level === 'error') as { message?: unknown } | undefined
    if (typeof first?.message === 'string' && first.message.trim() !== '')
      return first.message
  }
  return error.message
}

function isStale(error: ReturnType<typeof toHarnessError>): boolean {
  return error.code === 'conflict' && (error.details as { reason?: unknown } | undefined)?.reason === 'stale'
}

function showStale(): void {
  stale.value = true
  void nextTick(() => document.getElementById(ids.stale)?.focus())
}

/** The listing refetched meanwhile shows another handler at the target than the one the editor opened. */
function listingChanged(target: ProjectHookTarget): boolean {
  if (target.groupIndex === null || target.handlerIndex === null)
    return false
  const list = hooks.list(target.projectId)
  if (!list)
    return false
  const entry = projectEntryAt(list.items, target)
  return entry === null || !sameHandler(draftFromHook(entry), initial.value)
}

function closeSaved(current: FormValues, draft: HookDraft): void {
  form.reset({ ...current })
  initial.value = { ...draft, matcher: current.matcher }
  emit('update:open', false)
}

async function saveProject(target: ProjectHookTarget, current: FormValues, draft: HookDraft, overwrite: boolean): Promise<void> {
  if (!overwrite && listingChanged(target)) {
    showStale()
    return
  }
  const result = await hooks.saveProjectHook(target.projectId, target, draft)
  const pending = result.trust.pending
  const message = projectSavedText(target.path, pending)
  if (pending > 0) {
    const projectId = target.projectId
    toast.success(message, { action: { label: 'Review', onClick: () => openReview(projectId) } })
  }
  else {
    toast.success(message)
  }
  closeSaved(current, draft)
}

async function savePersonal(current: FormValues, draft: HookDraft): Promise<void> {
  let saved: PersonalHook
  if (props.mode === 'edit' && props.hook) {
    const hook = props.hook
    const patch = hookPatch(hook, draft)
    if (Object.keys(patch).length === 0) {
      initial.value = openingDraft()
      emit('update:open', false)
      return
    }
    saved = await freshAuth.run(() => hooks.update(hook.id, patch), { required: !isHookTurnOff(patch) })
  }
  else {
    const body = hookCreateBody(draft)
    saved = await freshAuth.run(() => hooks.create(body), { required: true })
  }
  toast.success(HOOK_COPY.saved!)
  closeSaved(current, draft)
  emit('saved', saved)
}

async function save(options: { overwrite?: boolean } = {}): Promise<void> {
  if (saving.value)
    return
  if (invalid.value) {
    const field = firstInvalidField()
    if (field)
      focusField(field)
    return
  }
  const current = values.value
  const draft = draftOf(current)
  const target = writeTarget.value
  saving.value = true
  submitError.value = null
  try {
    if (target) {
      stale.value = false
      await saveProject(target, current, draft, options.overwrite === true)
    }
    else {
      await savePersonal(current, draft)
    }
  }
  catch (error) {
    if (isFreshAuthCancelled(error))
      return
    const failure = toHarnessError(error)
    const matcher = matcherIssue(failure)
    if (target && isStale(failure)) {
      showStale()
    }
    else if (matcher) {
      serverMatcher.value = { value: current.matcher, message: matcher }
      focusField(ids.matcher)
    }
    else {
      submitError.value = { code: failure.code, message: target ? projectErrorMessage(failure) : failure.message }
    }
  }
  finally {
    saving.value = false
  }
}

// ---------- a changed settings file ----------

/** Turns the target into a new handler (the one it pointed at is gone). */
function detachTarget(): void {
  const target = projectTarget.value
  if (target)
    projectTarget.value = { ...target, groupIndex: null, handlerIndex: null }
}

/** Load from disk: the listing's handler at the target replaces the edits (gone: "This hook no longer exists."). */
async function reload(): Promise<void> {
  const target = writeTarget.value
  if (!target || saving.value)
    return
  saving.value = true
  try {
    await hooks.fetch(target.projectId).catch(() => {})
  }
  finally {
    saving.value = false
  }
  stale.value = false
  if (target.groupIndex === null)
    return
  const entry = projectEntryAt(hooks.list(target.projectId)?.items ?? [], target)
  if (!entry) {
    detachTarget()
    submitError.value = { code: 'not_found', message: HOOK_COPY.noLongerExists! }
    return
  }
  initial.value = draftFromHook(entry)
  form.reset(valuesOf(initial.value))
  submitError.value = null
}

/** Overwrite: the listing is refetched (so the store's check sees the file as it is now) and the edits are saved again. */
async function overwrite(): Promise<void> {
  const target = writeTarget.value
  if (!target || saving.value)
    return
  saving.value = true
  try {
    await hooks.fetch(target.projectId).catch(() => {})
  }
  finally {
    saving.value = false
  }
  if (target.groupIndex !== null && !projectEntryAt(hooks.list(target.projectId)?.items ?? [], target))
    detachTarget()
  stale.value = false
  await save({ overwrite: true })
}

function openReview(projectId: string): void {
  reviewProjectId.value = projectId
  reviewOpen.value = true
}

function onReviewOpenChange(value: boolean): void {
  reviewOpen.value = value
  if (!value && reviewProjectId.value)
    hooks.fetch(reviewProjectId.value).catch(() => {})
}

// ---------- field changes ----------

function onEvent(value: AcceptableValue, handleChange: (value: HookEvent) => void): void {
  if (typeof value === 'string' && (HOOK_EVENTS as readonly string[]).includes(value))
    handleChange(value as HookEvent)
}

function onType(value: AcceptableValue, handleChange: (value: HookType) => void): void {
  // A single ToggleGroup emits an empty value when the active item is clicked again: keep the type.
  if (value === 'command' || value === 'prompt')
    handleChange(value)
}

function onWhere(value: AcceptableValue, handleChange: (value: string) => void): void {
  if (value === PERSONAL || (typeof value === 'string' && (PROJECT_HOOK_FILES as readonly string[]).includes(value)))
    handleChange(value)
}
</script>

<template>
  <Sheet :open="open" @update:open="onSheetOpenChange">
    <SheetContent
      side="right"
      :data-testid="testIds.hookEditor"
      :data-mode="mode"
      class="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-2xl"
      @open-auto-focus="onOpenAutoFocus"
    >
      <SheetHeader class="border-b pr-14">
        <SheetTitle class="truncate">
          {{ title }}
        </SheetTitle>
        <p v-if="writeTarget" data-field="hook-path" class="font-mono text-xs break-all text-muted-foreground">
          {{ writeTarget.path }}
        </p>
        <SheetDescription class="sr-only">
          {{ isPrompt ? HOOK_COPY.promptWarning : HOOK_COPY.warning }}
        </SheetDescription>
      </SheetHeader>

      <form
        class="flex min-h-0 flex-1 flex-col"
        novalidate
        @submit.prevent.stop="submit"
        @keydown="onKeydown"
      >
        <div class="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-contain p-4">
          <Alert
            v-if="stale && writeTarget"
            :id="ids.stale"
            role="alert"
            tabindex="-1"
            data-field="hook-stale"
            class="border-warning/40 bg-warning/5 outline-none dark:bg-warning/10 *:[svg]:text-warning"
          >
            <TriangleAlertIcon aria-hidden="true" />
            <AlertTitle>{{ staleFileText(writeTarget.path) }}</AlertTitle>
            <AlertDescription class="flex flex-wrap gap-2 pt-1">
              <Button type="button" size="sm" variant="outline" data-action="reload" :disabled="saving" class="pointer-coarse:h-10" @click="reload">
                {{ HOOK_COPY.reload }}
              </Button>
              <Button type="button" size="sm" variant="outline" data-action="overwrite" :disabled="saving" class="pointer-coarse:h-10" @click="overwrite">
                {{ HOOK_COPY.overwrite }}
              </Button>
            </AlertDescription>
          </Alert>

          <Alert :data-testid="testIds.hookWarning" class="border-warning/40 bg-warning/5 dark:bg-warning/10 *:[svg]:text-warning">
            <TriangleAlertIcon aria-hidden="true" />
            <AlertDescription class="text-foreground">
              {{ isPrompt ? HOOK_COPY.promptWarning : HOOK_COPY.warning }}
            </AlertDescription>
          </Alert>

          <form.Field v-if="whereOffered" name="where">
            <template #default="{ field, state }">
              <div class="grid gap-2">
                <Label :for="ids.where">{{ HOOK_COPY.where }}</Label>
                <Select :model-value="state.value" @update:model-value="value => onWhere(value, field.handleChange)">
                  <SelectTrigger
                    :id="ids.where"
                    data-field="hook-where"
                    :data-value="state.value"
                    class="w-full sm:w-80 pointer-coarse:h-10"
                  >
                    <span :class="state.value === 'personal' ? undefined : 'font-mono text-[13px]'">{{ state.value === 'personal' ? HOOK_COPY.personal : state.value }}</span>
                  </SelectTrigger>
                  <SelectContent position="popper" align="start" class="w-(--reka-select-trigger-width) min-w-64">
                    <SelectItem value="personal" data-value="personal" class="pointer-coarse:min-h-10">
                      {{ HOOK_COPY.personal }}
                    </SelectItem>
                    <SelectItem
                      v-for="path in PROJECT_HOOK_FILES"
                      :key="path"
                      :value="path"
                      :data-value="path"
                      class="font-mono text-[13px] pointer-coarse:min-h-10"
                    >
                      {{ path }}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </template>
          </form.Field>

          <form.Field name="type">
            <template #default="{ field, state }">
              <div class="grid gap-2">
                <Label :id="ids.type">Type</Label>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  :model-value="state.value"
                  :aria-labelledby="ids.type"
                  :data-testid="testIds.hookType"
                  :data-value="state.value"
                  class="w-fit"
                  @update:model-value="value => onType(value, field.handleChange)"
                >
                  <ToggleGroupItem value="command" data-value="command" class="gap-1.5 px-3 pointer-coarse:h-10">
                    <SquareTerminalIcon aria-hidden="true" />
                    {{ HOOK_COPY.typeCommand }}
                  </ToggleGroupItem>
                  <ToggleGroupItem value="prompt" data-value="prompt" class="gap-1.5 px-3 pointer-coarse:h-10">
                    <MessageSquareTextIcon aria-hidden="true" />
                    {{ HOOK_COPY.typePrompt }}
                  </ToggleGroupItem>
                </ToggleGroup>
              </div>
            </template>
          </form.Field>

          <form.Field name="event">
            <template #default="{ field, state }">
              <div class="grid gap-2">
                <Label :for="ids.event">Event</Label>
                <Select :model-value="state.value" @update:model-value="value => onEvent(value, field.handleChange)">
                  <SelectTrigger
                    :id="ids.event"
                    :data-testid="testIds.hookEvent"
                    :data-value="state.value"
                    :aria-describedby="ids.eventHelp"
                    :aria-invalid="shownError('event') ? true : undefined"
                    class="w-full sm:w-64 pointer-coarse:h-10"
                  >
                    <span>{{ HOOK_EVENT_INFO[state.value].label }}</span>
                  </SelectTrigger>
                  <SelectContent position="popper" align="start" class="w-(--reka-select-trigger-width) min-w-72 sm:min-w-96">
                    <SelectItem
                      v-for="event in HOOK_EVENTS"
                      :key="event"
                      :value="event"
                      :data-value="event"
                      class="pointer-coarse:min-h-10"
                    >
                      <span class="flex min-w-0 flex-col gap-0.5">
                        <span>{{ HOOK_EVENT_INFO[event].label }}</span>
                        <span class="text-xs whitespace-normal text-muted-foreground">{{ HOOK_EVENT_INFO[event].description }}</span>
                      </span>
                    </SelectItem>
                  </SelectContent>
                </Select>
                <p :id="ids.eventHelp" class="text-xs text-muted-foreground">
                  {{ HOOK_EVENT_INFO[state.value].description }}
                </p>
                <p v-if="shownError('event')" data-field="hook-event-error" class="text-xs text-destructive">
                  {{ shownError('event') }}
                </p>
              </div>
            </template>
          </form.Field>

          <form.Field v-if="toolEvent || agentEvent" name="matcher">
            <template #default="{ field, state }">
              <div class="grid gap-2">
                <Label :for="ids.matcher">{{ toolEvent ? 'Tools' : HOOK_COPY.agentMatcher }}</Label>
                <Input
                  :id="ids.matcher"
                  :model-value="state.value"
                  :data-testid="testIds.hookMatcher"
                  :aria-invalid="shownError('matcher', state.meta) ? true : undefined"
                  :aria-describedby="toolEvent ? `${ids.matcherHelp} ${ids.matcherPreview}` : ids.matcherHelp"
                  :maxlength="HOOK_LIMITS.matcherMaxChars + 8"
                  :placeholder="toolEvent ? 'Bash|Edit' : 'explore|general'"
                  autocomplete="off"
                  autocapitalize="off"
                  spellcheck="false"
                  class="font-mono text-[13px] placeholder:font-mono pointer-coarse:h-10"
                  @update:model-value="value => field.handleChange(String(value))"
                  @blur="field.handleBlur"
                />
                <p :id="ids.matcherHelp" class="text-xs text-muted-foreground">
                  {{ toolEvent ? HOOK_COPY.matcherHelp : HOOK_COPY.agentMatcherHelp }}
                </p>
                <p
                  v-if="toolEvent"
                  :id="ids.matcherPreview"
                  :data-testid="testIds.hookMatcherPreview"
                  :data-count="preview.matches.length"
                  aria-live="polite"
                  class="min-h-4 text-xs break-words"
                  :class="shownError('matcher', state.meta) || !preview.ok ? 'text-destructive' : 'text-muted-foreground'"
                >
                  {{ shownError('matcher', state.meta) ?? preview.text }}
                </p>
                <p v-else-if="shownError('matcher', state.meta)" class="text-xs text-destructive">
                  {{ shownError('matcher', state.meta) }}
                </p>
              </div>
            </template>
          </form.Field>

          <template v-if="isPrompt">
            <form.Field name="prompt">
              <template #default="{ field, state }">
                <div class="grid gap-2">
                  <Label :for="ids.prompt">{{ HOOK_COPY.typePrompt }}</Label>
                  <Textarea
                    :id="ids.prompt"
                    :model-value="state.value"
                    :data-testid="testIds.hookPrompt"
                    :aria-invalid="shownError('prompt', state.meta) ? true : undefined"
                    :aria-describedby="`${ids.promptHelp} ${ids.modelLine}`"
                    :maxlength="HOOK_LIMITS.promptMaxChars"
                    rows="2"
                    autocomplete="off"
                    spellcheck="false"
                    class="field-sizing-content max-h-[12.5rem] min-h-14 resize-none font-mono text-[13px]"
                    @update:model-value="value => field.handleChange(String(value))"
                    @blur="field.handleBlur"
                  />
                  <p :id="ids.promptHelp" class="text-xs" :class="shownError('prompt', state.meta) ? 'text-destructive' : 'text-muted-foreground'">
                    {{ shownError('prompt', state.meta) ?? HOOK_COPY.promptHelp }}
                  </p>
                </div>
              </template>
            </form.Field>

            <form.Field name="model">
              <template #default="{ field, state }">
                <div class="grid gap-2">
                  <Label :for="ids.model">Model</Label>
                  <SettingsModelSelect
                    :id="ids.model"
                    :model-value="state.value"
                    kind="chat"
                    allow-none
                    :none-label="HOOK_COPY.hookModel"
                    label="Model"
                    data-field="hook-model"
                    class="sm:w-96"
                    @update:model-value="value => field.handleChange(value)"
                  />
                  <p :id="ids.modelLine" data-field="hook-model-line" class="text-xs text-muted-foreground">
                    {{ modelLine }}
                  </p>
                </div>
              </template>
            </form.Field>

            <form.Field v-if="continueShown" name="continueOnBlock">
              <template #default="{ field, state }">
                <div class="flex items-start justify-between gap-3">
                  <div class="grid gap-1">
                    <Label :for="ids.continueOnBlock">{{ HOOK_COPY.continueOnBlock }}</Label>
                    <p :id="ids.continueOnBlockHelp" class="text-xs text-muted-foreground">
                      {{ HOOK_COPY.continueOnBlockHelp }}
                    </p>
                  </div>
                  <Switch
                    :id="ids.continueOnBlock"
                    :model-value="state.value"
                    :aria-describedby="ids.continueOnBlockHelp"
                    data-field="hook-continue-on-block"
                    class="mt-0.5 pointer-coarse:after:-inset-y-[11px]"
                    @update:model-value="value => field.handleChange(value === true)"
                  />
                </div>
              </template>
            </form.Field>
          </template>

          <template v-else>
            <form.Field name="command">
              <template #default="{ field, state }">
                <div class="grid gap-2">
                  <Label :for="ids.command">Command</Label>
                  <Textarea
                    :id="ids.command"
                    :model-value="state.value"
                    :data-testid="testIds.hookCommand"
                    :aria-invalid="shownError('command', state.meta) ? true : undefined"
                    :aria-describedby="ids.commandHelp"
                    :maxlength="HOOK_LIMITS.commandMaxChars"
                    rows="1"
                    autocomplete="off"
                    autocapitalize="off"
                    spellcheck="false"
                    class="field-sizing-content max-h-[9.5rem] min-h-9 resize-none font-mono text-[13px]"
                    @update:model-value="value => field.handleChange(String(value))"
                    @blur="field.handleBlur"
                  />
                  <p :id="ids.commandHelp" class="text-xs" :class="shownError('command', state.meta) ? 'text-destructive' : 'text-muted-foreground'">
                    {{ shownError('command', state.meta) ?? HOOK_COPY.commandHelp }}
                  </p>
                </div>
              </template>
            </form.Field>

            <form.Field name="args">
              <template #default="{ field, state }">
                <div class="grid gap-2">
                  <Label :for="ids.args">{{ HOOK_COPY.args }}</Label>
                  <Textarea
                    :id="ids.args"
                    :model-value="state.value"
                    data-field="hook-args"
                    :aria-invalid="shownError('args', state.meta) ? true : undefined"
                    :aria-describedby="ids.argsHelp"
                    rows="1"
                    autocomplete="off"
                    autocapitalize="off"
                    spellcheck="false"
                    class="field-sizing-content max-h-[9.5rem] min-h-9 resize-none font-mono text-[13px]"
                    @update:model-value="value => field.handleChange(String(value))"
                    @blur="field.handleBlur"
                  />
                  <p :id="ids.argsHelp" class="text-xs" :class="shownError('args', state.meta) ? 'text-destructive' : 'text-muted-foreground'">
                    {{ shownError('args', state.meta) ?? HOOK_COPY.argsHelp }}
                  </p>
                </div>
              </template>
            </form.Field>

            <form.Field name="async">
              <template #default="{ field, state }">
                <div class="flex items-start justify-between gap-3">
                  <div class="grid gap-1">
                    <Label :for="ids.async">{{ HOOK_COPY.async }}</Label>
                    <p :id="ids.asyncHelp" class="text-xs text-muted-foreground">
                      {{ HOOK_COPY.asyncHelp }}
                    </p>
                  </div>
                  <Switch
                    :id="ids.async"
                    :model-value="state.value"
                    :aria-describedby="ids.asyncHelp"
                    data-field="hook-async"
                    class="mt-0.5 pointer-coarse:after:-inset-y-[11px]"
                    @update:model-value="value => field.handleChange(value === true)"
                  />
                </div>
              </template>
            </form.Field>
          </template>

          <form.Field v-if="toolEvent" name="if">
            <template #default="{ field, state }">
              <div class="grid gap-2">
                <Label :for="ids.if">{{ HOOK_COPY.ifLabel }}</Label>
                <Input
                  :id="ids.if"
                  :model-value="state.value"
                  data-field="hook-if"
                  :aria-invalid="shownError('if', state.meta) ? true : undefined"
                  :aria-describedby="ids.ifHelp"
                  :maxlength="HOOK_LIMITS.ifMaxChars + 8"
                  placeholder="Bash(npm run *)"
                  autocomplete="off"
                  autocapitalize="off"
                  spellcheck="false"
                  class="font-mono text-[13px] placeholder:font-mono pointer-coarse:h-10"
                  @update:model-value="value => field.handleChange(String(value))"
                  @blur="field.handleBlur"
                />
                <p :id="ids.ifHelp" class="text-xs" :class="shownError('if', state.meta) ? 'text-destructive' : 'text-muted-foreground'">
                  {{ shownError('if', state.meta) ?? HOOK_COPY.ifHelp }}
                </p>
              </div>
            </template>
          </form.Field>

          <form.Field name="statusMessage">
            <template #default="{ field, state }">
              <div class="grid gap-2">
                <Label :for="ids.statusMessage">{{ HOOK_COPY.statusMessage }}</Label>
                <Input
                  :id="ids.statusMessage"
                  :model-value="state.value"
                  data-field="hook-status-message"
                  :aria-invalid="shownError('statusMessage', state.meta) ? true : undefined"
                  :aria-describedby="ids.statusMessageHelp"
                  :maxlength="HOOK_LIMITS.statusMessageMaxChars + 8"
                  autocomplete="off"
                  class="pointer-coarse:h-10"
                  @update:model-value="value => field.handleChange(String(value))"
                  @blur="field.handleBlur"
                />
                <p :id="ids.statusMessageHelp" class="text-xs" :class="shownError('statusMessage', state.meta) ? 'text-destructive' : 'text-muted-foreground'">
                  {{ shownError('statusMessage', state.meta) ?? HOOK_COPY.statusMessageHelp }}
                </p>
              </div>
            </template>
          </form.Field>

          <form.Field name="timeout">
            <template #default="{ field, state }">
              <div class="grid gap-2">
                <Label :for="ids.timeout">Timeout</Label>
                <div class="flex items-center gap-2">
                  <Input
                    :id="ids.timeout"
                    :model-value="state.value"
                    :data-testid="testIds.hookTimeout"
                    :aria-invalid="shownError('timeout', state.meta) ? true : undefined"
                    :aria-describedby="ids.timeoutHelp"
                    inputmode="numeric"
                    maxlength="3"
                    :placeholder="isPrompt ? String(HOOK_LIMITS.promptTimeoutDefaultSec) : String(HOOK_LIMITS.timeoutDefaultSec)"
                    autocomplete="off"
                    class="w-20 tabular-nums pointer-coarse:h-10"
                    @update:model-value="value => field.handleChange(String(value))"
                    @blur="field.handleBlur"
                  />
                  <span class="text-sm text-muted-foreground">seconds</span>
                </div>
                <p v-if="shownError('timeout', state.meta)" :id="ids.timeoutHelp" class="text-xs text-destructive">
                  {{ shownError('timeout', state.meta) }}
                </p>
              </div>
            </template>
          </form.Field>

          <form.Field v-if="!isProject" name="enabled">
            <template #default="{ field, state }">
              <div class="flex items-center justify-between gap-3">
                <Label :for="ids.enabled">On</Label>
                <Switch
                  :id="ids.enabled"
                  :model-value="state.value"
                  :data-testid="testIds.hookEditorEnabled"
                  class="pointer-coarse:after:-inset-y-[11px]"
                  @update:model-value="value => field.handleChange(value === true)"
                />
              </div>
            </template>
          </form.Field>
        </div>

        <SheetFooter class="mt-0 gap-3 border-t bg-popover p-4">
          <Alert
            v-if="submitError"
            role="alert"
            :data-testid="testIds.hookError"
            :data-code="submitError.code"
            class="border-destructive/35 bg-destructive/5 dark:bg-destructive/10"
          >
            <CircleAlertIcon aria-hidden="true" class="text-destructive" />
            <AlertTitle>{{ submitError.message }}</AlertTitle>
          </Alert>
          <div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" :disabled="saving" class="h-10 sm:h-9 pointer-coarse:h-10" @click="requestClose">
              Cancel
            </Button>
            <Button
              type="submit"
              :disabled="saving"
              :aria-busy="saving || undefined"
              :data-testid="testIds.hookSave"
              class="h-10 sm:h-9 pointer-coarse:h-10"
            >
              <Spinner v-if="saving" data-icon="inline-start" />
              Save hook
            </Button>
          </div>
        </SheetFooter>
      </form>
    </SheetContent>
  </Sheet>

  <ConfirmDialog
    :open="discardOpen"
    title="Discard changes?"
    description="Your changes are lost."
    confirm-label="Discard"
    cancel-label="Keep editing"
    :data-testid="testIds.hookDiscardConfirm"
    @update:open="value => discardOpen = value"
    @confirm="discard"
  />
  <ConfirmPasswordDialog
    :open="freshAuth.open.value"
    :description="HOOK_COPY.passwordPrompt"
    :pending="freshAuth.pending.value"
    :error="freshAuth.error.value"
    @update:open="freshAuth.setOpen"
    @submit="freshAuth.submit"
  />
  <ProjectTrustDialog
    v-if="reviewProjectId"
    :open="reviewOpen"
    :project-id="reviewProjectId"
    :focus-key="null"
    @update:open="onReviewOpenChange"
  />
</template>
