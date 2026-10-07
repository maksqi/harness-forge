<script setup lang="ts">
// The definition editor of the Customize page (docs/UI.md 2.17, 9.12, 10.7, 12, 14): a right Sheet (`w-full
// sm:max-w-2xl`, full width on phones) whose body scrolls under a sticky footer. TanStack Form holds the fields of the
// kind: Name (mono; a `/` adornment for commands), Description, Tools (All / Only these + ToolMultiSelect; agents and
// commands), Model (SettingsModelSelect; agents also "Same as the chat" = `inherit`), Argument hint (commands) and the
// body in MarkdownEditor with the size of the whole file ("{n} KB / 64 KB"). The fields are serialized with the shared
// `formatDefinition` and re-parsed with `parseDefinition` on every change, so the form follows the server's rules; the
// inline errors use the editor's copy. Save (`customization-save`, also Mod+Enter in any field) → customizations
// `create({ kind, content })` (new, import) or `update(id, { content })` (edit) → toast "{Kind} saved", `saved`, close.
// A 409 `exists` shows on the name field, a 400 with diagnostics lists them in the form-level alert, any other error
// shows its message there (`customization-error`, `data-code`). Closing with changes (Esc, ×, Cancel, a click outside)
// asks "Discard changes?" (`customization-discard-confirm`; opens on Keep editing). Opens with focus on Name (new,
// import) or Description (edit); reka returns focus to the element that had it when the sheet opened.
// Props, emits and the root test id are frozen from Gate P10-0b (C33).
// Phase 11 (W11.8; docs/UI.md 9.13): output styles (kind `style`) have Name, Description, Keep coding instructions
// (`customization-keep-coding`, a Switch, default off) and the body (no Tools or Model); skills add Show in the slash menu
// (`customization-user-invocable`, default on), Only when you run it (`customization-model-invocation`, default off) and
// the Argument hint. A style keeps its label as written while its name is still the label's slug.
// Phase 12 (ADR-058; W12.11; docs/UI.md 9.14): Claude Code's newer keys. Agents: Tools not allowed
// (`customization-disallowed-tools`, a ToolMultiSelect), Max turns (`customization-max-turns`, 1–200), Color
// (`customization-color`, the eight colors with their dots, "None" first) and Skills (`customization-skills`, at most 5
// of the catalog's skills, CustomizationSkillSelect). Commands and skills: When to use (`customization-when-to-use`),
// Tools not allowed in this turn, Run in a sub-agent (`customization-fork`, `context: fork`) and its Agent
// (`customization-fork-agent`, the catalog's agent types, default `general`). Skills also get Allowed tools and Model
// (like commands). The body help names `$ARGUMENTS[N]`, `$name` and `${CLAUDE_SKILL_DIR}`. Keys the form does not show
// (`arguments`, a Claude model name such as `model: sonnet` while no model is chosen) are kept on save; every key is
// written by the shared `formatDefinition` only when it is set.
import type { AgentColor, Customization, CustomizationKind, DefinitionDiagnostic, ToolSummary } from '@harness-forge/shared'
import type { AcceptableValue } from 'reka-ui'
import type { CustomizationDraft, DraftField } from './customize'
import { AGENT_COLORS, DEFINITION_LIMITS, parseDefinition } from '@harness-forge/shared'
import { CircleAlertIcon, FileUpIcon } from '@lucide/vue'
import { useForm } from '@tanstack/vue-form'
import { computed, nextTick, ref, shallowRef, useId, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { AGENT_COLOR_TOKENS } from '~/components/chat/agent/agent-tools'
import ConfirmDialog from '~/components/common/ConfirmDialog.vue'
import MarkdownEditor from '~/components/common/MarkdownEditor.vue'
import SettingsModelSelect from '~/components/settings/SettingsModelSelect.vue'
import { useCustomizationsStore } from '~/stores/customizations'
import { usePluginsStore } from '~/stores/plugins'
import { toHarnessError } from '~/utils/errors'
import { testIds } from '~/utils/testids'
import CustomizationSkillSelect from './CustomizationSkillSelect.vue'
import {
  AGENT_COLOR_LABELS,
  argumentHintError,
  bodyDiagnostics,
  bodyError,
  CONTENT_MAX_BYTES,
  descriptionError,
  diagnosticField,
  draftContent,
  draftFromUser,
  EDITOR_COPY,
  EDITOR_FIELD_COPY,
  emptyDraft,
  existsError,
  maxTurnsError,
  maxTurnsValue,
  nameError,
  nameMaxChars,
  sizeLabel,
  skillsError,
  utf8Bytes,
  whenToUseError,
} from './customize'
import ToolMultiSelect from './ToolMultiSelect.vue'

const props = defineProps<{
  open: boolean
  kind: CustomizationKind
  mode: 'new' | 'edit' | 'import'
  /** Edit mode: the personal definition. */
  customization?: Customization | null
  /** New (Duplicate) and import mode: the prefilled fields. */
  draft?: CustomizationDraft | null
  /** Import notes (customization-import-notes). */
  notes?: readonly string[]
}>()

const emit = defineEmits<{ 'update:open': [open: boolean], 'saved': [customization: Customization] }>()

interface FormValues {
  name: string
  description: string
  toolsMode: 'all' | 'some'
  tools: string[]
  model: string | null
  argumentHint: string
  body: string
  /** + Phase 11: styles. */
  keepCodingInstructions: boolean
  /** + Phase 11: skills ("Show in the slash menu"). */
  userInvocable: boolean
  /** + Phase 11: skills ("Only when you run it" = not model-invocable). */
  onlyWhenRun: boolean
  /** + Phase 12: agents, commands and skills ("Tools not allowed"). */
  disallowedTools: string[]
  /** + Phase 12: agents ("Max turns", as typed; '' = no limit of its own). */
  maxTurns: string
  /** + Phase 12: agents ("Color"; '' = none). */
  color: AgentColor | ''
  /** + Phase 12: agents ("Skills"). */
  skills: string[]
  /** + Phase 12: commands and skills ("When to use"). */
  whenToUse: string
  /** + Phase 12: commands and skills ("Run in a sub-agent"). */
  fork: boolean
  /** + Phase 12: the fork's agent type ('' = general). */
  forkAgent: string
}

/** The Color select's value for "None" (a select item cannot have an empty value). */
const NO_COLOR = '__none__'
/** The default agent type of a fork. */
const DEFAULT_FORK_AGENT = 'general'

const customizations = useCustomizationsStore()
const plugins = usePluginsStore()
const ids = {
  name: useId(),
  nameError: useId(),
  description: useId(),
  descriptionHelp: useId(),
  tools: useId(),
  model: useId(),
  inherit: useId(),
  argumentHint: useId(),
  argumentHintHelp: useId(),
  body: useId(),
  bodyHelp: useId(),
  keepCoding: useId(),
  keepCodingHelp: useId(),
  userInvocable: useId(),
  modelInvocation: useId(),
  modelInvocationHelp: useId(),
  disallowed: useId(),
  disallowedHelp: useId(),
  maxTurns: useId(),
  maxTurnsHelp: useId(),
  color: useId(),
  colorHelp: useId(),
  skills: useId(),
  skillsHelp: useId(),
  whenToUse: useId(),
  whenToUseHelp: useId(),
  fork: useId(),
  forkHelp: useId(),
  forkAgent: useId(),
}

const copy = computed(() => EDITOR_COPY[props.kind])
const fieldCopy = computed(() => EDITOR_FIELD_COPY[props.kind])
const title = computed(() => {
  if (props.mode === 'edit')
    return `Edit ${props.customization?.name ?? copy.value.title}`
  return props.mode === 'import' ? `Import ${copy.value.title}` : `New ${copy.value.title}`
})

/** The draft the sheet opened with (its content decides "changed"). */
const initial = shallowRef<CustomizationDraft>(emptyDraft(props.kind))
const submitError = ref<{ code: string, message: string, lines: string[] } | null>(null)
/** The name a 409 `exists` answered for (the name field shows it until the name changes). */
const conflictName = ref<string | null>(null)
const discardOpen = ref(false)
const saving = ref(false)

function valuesOf(draft: CustomizationDraft): FormValues {
  return {
    name: draft.name,
    description: draft.description,
    toolsMode: draft.tools === null ? 'all' : 'some',
    tools: draft.tools ? [...draft.tools] : [],
    model: draft.model,
    argumentHint: draft.argumentHint ?? '',
    body: draft.body,
    keepCodingInstructions: draft.keepCodingInstructions ?? false,
    userInvocable: draft.userInvocable ?? true,
    onlyWhenRun: draft.modelInvocable === false,
    disallowedTools: draft.disallowedTools ? [...draft.disallowedTools] : [],
    maxTurns: typeof draft.maxTurns === 'number' ? String(draft.maxTurns) : '',
    color: draft.color ?? '',
    skills: draft.skills ? [...draft.skills] : [],
    whenToUse: draft.whenToUse ?? '',
    fork: draft.fork ?? false,
    forkAgent: draft.forkAgent ?? '',
  }
}

function draftOf(values: FormValues): CustomizationDraft {
  const draft: CustomizationDraft = {
    kind: props.kind,
    name: values.name,
    description: values.description,
    // + Phase 12: skills have Allowed tools and a Model too (ADR-058).
    tools: props.kind === 'style' || values.toolsMode === 'all' ? null : [...values.tools],
    model: props.kind === 'style' ? null : values.model,
    argumentHint: props.kind === 'command' || props.kind === 'skill' ? values.argumentHint : null,
    body: values.body,
  }
  // + Phase 11: the style and skill keys (absent = the default, like the parser's fields).
  if (props.kind === 'style') {
    draft.keepCodingInstructions = values.keepCodingInstructions
    const label = initial.value.label
    if (label)
      draft.label = label
  }
  if (props.kind === 'skill') {
    if (!values.userInvocable)
      draft.userInvocable = false
    if (values.onlyWhenRun)
      draft.modelInvocable = false
  }
  // + Phase 12: the Claude Code keys (absent = not set, like the parser's fields).
  if (props.kind !== 'style') {
    if (values.disallowedTools.length > 0)
      draft.disallowedTools = [...values.disallowedTools]
    // Not shown in the form: kept as the file had them.
    if (initial.value.modelAlias)
      draft.modelAlias = initial.value.modelAlias
  }
  if (props.kind === 'agent') {
    const turns = maxTurnsValue(values.maxTurns)
    if (turns !== null)
      draft.maxTurns = turns
    if (values.color)
      draft.color = values.color
    if (values.skills.length > 0)
      draft.skills = [...values.skills]
  }
  if (props.kind === 'command' || props.kind === 'skill') {
    if (values.whenToUse.trim() !== '')
      draft.whenToUse = values.whenToUse
    if (values.fork) {
      draft.fork = true
      if (values.forkAgent)
        draft.forkAgent = values.forkAgent
    }
    if (initial.value.arguments && initial.value.arguments.length > 0)
      draft.arguments = [...initial.value.arguments]
  }
  return draft
}

const form = useForm({
  defaultValues: valuesOf(initial.value),
  onSubmit: async ({ value }) => {
    await save(draftOf(value))
  },
})

const values = form.useSelector(state => state.values)
const attempted = form.useSelector(state => state.submissionAttempts > 0)

const current = computed(() => draftOf(values.value))
const content = computed(() => draftContent(current.value))
const bytes = computed(() => utf8Bytes(content.value))
const parsed = computed(() => parseDefinition(props.kind, content.value))
const dirty = computed(() => content.value !== draftContent(initial.value))

const errors = computed<Partial<Record<DraftField, string>>>(() => {
  const draft = current.value
  const found: Partial<Record<DraftField, string>> = {}
  const name = nameError(props.kind, draft.name)
    ?? (conflictName.value !== null && conflictName.value === draft.name.trim() ? existsError(props.kind, draft.name) : null)
  if (name)
    found.name = name
  const description = descriptionError(props.kind, draft.description)
  if (description)
    found.description = description
  const hint = props.kind === 'command' || props.kind === 'skill' ? argumentHintError(draft.argumentHint) : null
  if (hint)
    found.argumentHint = hint
  const body = bodyError(draft)
  if (body)
    found.body = body
  return found
})

/** + Phase 12: the problems of the Claude Code fields (Max turns, Skills, When to use). */
const fieldErrors = computed(() => {
  const value = values.value
  return {
    maxTurns: props.kind === 'agent' ? maxTurnsError(value.maxTurns) : null,
    skills: props.kind === 'agent' ? skillsError(value.skills) : null,
    whenToUse: props.kind === 'command' || props.kind === 'skill' ? whenToUseError(value.whenToUse) : null,
  }
})

/** Parser errors the field rules do not cover (shown in the form-level alert). */
const parseErrors = computed(() => {
  if (Object.keys(errors.value).length > 0)
    return []
  return parsed.value.diagnostics.filter(diagnostic => diagnostic.level === 'error').map(diagnostic => diagnostic.message)
})
/** Warnings of the live parse, by field (unknown tools, model notes). */
const warnings = computed(() => {
  const byField: Partial<Record<DraftField, string[]>> = {}
  for (const diagnostic of parsed.value.diagnostics) {
    if (diagnostic.level === 'error')
      continue
    const field = diagnosticField(diagnostic)
    if (field)
      (byField[field] ??= []).push(diagnostic.message)
  }
  return byField
})
const invalid = computed(() => Object.keys(errors.value).length > 0 || parseErrors.value.length > 0
  || Object.values(fieldErrors.value).some(error => error !== null))
const bodyMarkers = computed<DefinitionDiagnostic[]>(() => bodyDiagnostics(content.value, current.value.body, parsed.value.diagnostics))

const toolOptions = computed<readonly ToolSummary[]>(() => (props.kind === 'agent'
  // A sub-agent never gets the core-agent tools (task, todo_write, exit_plan_mode, skill).
  ? plugins.tools.filter(tool => tool.pluginId !== 'core-agent')
  : plugins.tools))

/** + Phase 12: the catalog's skills an agent can preload (the global catalog; names a file lists stay as chips). */
const skillOptions = computed(() => {
  const seen = new Map<string, { name: string, description: string }>()
  for (const entry of customizations.entriesOf(null, 'skill')) {
    if (entry.state !== 'invalid' && !seen.has(entry.name))
      seen.set(entry.name, { name: entry.name, description: entry.description })
  }
  return [...seen.values()]
})

/** + Phase 12: the agent types a fork can run as (general first, then the catalog's agents; the chosen one kept). */
const forkAgentOptions = computed(() => {
  const names = new Set<string>([DEFAULT_FORK_AGENT, 'explore'])
  for (const entry of customizations.entriesOf(null, 'agent')) {
    if (entry.state !== 'invalid')
      names.add(entry.name)
  }
  const chosen = values.value.forkAgent
  if (chosen)
    names.add(chosen)
  return [...names]
})

/** + Phase 12: the dot of an agent color (a design token, never a literal color). */
function colorDot(color: AgentColor): Record<string, string> {
  return { backgroundColor: `var(--${AGENT_COLOR_TOKENS[color]})` }
}

/** + Phase 12: the none label of the Model select keeps a Claude model name the file uses. */
const modelNoneLabel = computed(() => (initial.value.modelAlias ? `${initial.value.modelAlias} (Claude model name)` : fieldCopy.value.modelNone))

/** The inline error of a field once it was left or a save was tried (import mode shows them at once). */
function shownError(field: DraftField, meta?: { isBlurred: boolean, isDirty: boolean }): string | null {
  const error = errors.value[field]
  if (!error)
    return null
  if (field === 'name' && conflictName.value !== null)
    return error
  if (field === 'body' && bytes.value > CONTENT_MAX_BYTES)
    return error
  if (attempted.value || props.mode === 'import' || meta?.isBlurred)
    return error
  return null
}

// ---------- opening ----------

function openingDraft(): CustomizationDraft {
  if (props.mode === 'edit' && props.customization)
    return draftFromUser(props.customization)
  return props.draft ? { ...props.draft, kind: props.kind } : emptyDraft(props.kind)
}

watch(() => props.open, (open) => {
  if (!open)
    return
  initial.value = openingDraft()
  form.reset(valuesOf(initial.value))
  submitError.value = null
  conflictName.value = null
  discardOpen.value = false
  saving.value = false
  if (!plugins.toolsLoaded)
    plugins.fetchTools().catch(() => {})
  if (!plugins.mcpLoaded)
    plugins.fetchMcp().catch(() => {})
  // + Phase 12: the skills and agent types of the Skills and fork Agent pickers (the global catalog), quietly.
  if (props.kind !== 'style' && !customizations.catalog(null))
    customizations.fetchCatalog(null, { maxAgeMs: 60_000 }).catch(() => {})
}, { immediate: true })

function focusField(id: string): void {
  void nextTick(() => document.getElementById(id)?.focus())
}

function onOpenAutoFocus(event: Event): void {
  event.preventDefault()
  focusField(props.mode === 'edit' ? ids.description : ids.name)
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

function submit(): void {
  void form.handleSubmit()
}

function onKeydown(event: KeyboardEvent): void {
  // The body editor handles its own Mod+Enter (it prevents the default and emits submit).
  if (event.defaultPrevented || event.isComposing || event.key !== 'Enter' || !(event.metaKey || event.ctrlKey))
    return
  event.preventDefault()
  submit()
}

async function save(draft: CustomizationDraft): Promise<void> {
  if (saving.value || invalid.value) {
    if (errors.value.name)
      focusField(ids.name)
    return
  }
  saving.value = true
  submitError.value = null
  const body = draftContent(draft)
  try {
    const saved = props.mode === 'edit' && props.customization
      ? await customizations.update(props.customization.id, { content: body })
      : await customizations.create({ kind: props.kind, content: body })
    toast.success(fieldCopy.value.saved)
    initial.value = draft
    emit('saved', saved)
    emit('update:open', false)
  }
  catch (error) {
    const harnessError = toHarnessError(error)
    const details = harnessError.details as { reason?: unknown, diagnostics?: unknown } | undefined
    if (harnessError.code === 'conflict' && details?.reason === 'exists') {
      conflictName.value = draft.name.trim()
      focusField(ids.name)
    }
    else {
      const diagnostics = Array.isArray(details?.diagnostics) ? details.diagnostics : []
      const lines = diagnostics
        .map(entry => (entry && typeof entry === 'object' && typeof (entry as { message?: unknown }).message === 'string' ? (entry as { message: string }).message : null))
        .filter((line): line is string => line !== null)
      submitError.value = { code: harnessError.code, message: harnessError.message, lines }
    }
  }
  finally {
    saving.value = false
  }
}

function onToolsMode(value: AcceptableValue, handleChange: (value: 'all' | 'some') => void): void {
  if (value === 'all' || value === 'some')
    handleChange(value)
}

function onColor(value: AcceptableValue, handleChange: (value: AgentColor | '') => void): void {
  if (value === NO_COLOR)
    handleChange('')
  else if (typeof value === 'string' && (AGENT_COLORS as readonly string[]).includes(value))
    handleChange(value as AgentColor)
}

function onForkAgent(value: AcceptableValue, handleChange: (value: string) => void): void {
  if (typeof value === 'string')
    handleChange(value === DEFAULT_FORK_AGENT ? '' : value)
}

/** + Phase 12: a field's own error once it was left or a save was tried (import mode at once). */
function shownFieldError(error: string | null, meta?: { isBlurred: boolean }): string | null {
  if (!error)
    return null
  return attempted.value || props.mode === 'import' || meta?.isBlurred ? error : null
}

function errorProps(field: DraftField, errorId: string, meta?: { isBlurred: boolean, isDirty: boolean }) {
  const error = shownError(field, meta)
  return { 'aria-invalid': error ? true : undefined, 'aria-describedby': error ? errorId : undefined }
}
</script>

<template>
  <Sheet :open="open" @update:open="onSheetOpenChange">
    <SheetContent
      side="right"
      :data-testid="testIds.customizationEditor"
      :data-kind="kind"
      :data-mode="mode"
      class="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-2xl"
      @open-auto-focus="onOpenAutoFocus"
    >
      <SheetHeader class="border-b pr-14">
        <SheetTitle class="truncate">
          {{ title }}
        </SheetTitle>
        <SheetDescription class="sr-only">
          {{ copy.bodyHelp }}
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
            v-if="notes && notes.length > 0"
            :data-testid="testIds.customizationImportNotes"
            :data-count="notes.length"
            class="border-primary/30 bg-primary/5"
          >
            <FileUpIcon aria-hidden="true" />
            <AlertDescription class="text-foreground">
              <ul class="flex flex-col gap-0.5">
                <li v-for="(note, index) in notes" :key="index" :class="index > 0 ? 'text-muted-foreground' : undefined">
                  {{ note }}
                </li>
              </ul>
            </AlertDescription>
          </Alert>

          <form.Field name="name">
            <template #default="{ field, state }">
              <div class="grid gap-2">
                <Label :for="ids.name">Name</Label>
                <InputGroup v-if="kind === 'command'" class="font-mono">
                  <InputGroupAddon aria-hidden="true" class="font-mono">
                    /
                  </InputGroupAddon>
                  <InputGroupInput
                    :id="ids.name"
                    :model-value="state.value"
                    :data-testid="testIds.customizationName"
                    v-bind="errorProps('name', ids.nameError, state.meta)"
                    :maxlength="nameMaxChars(kind) + 8"
                    autocomplete="off"
                    autocapitalize="off"
                    spellcheck="false"
                    class="font-mono text-[13px]"
                    @update:model-value="(value: string | number) => field.handleChange(String(value))"
                    @blur="field.handleBlur"
                  />
                </InputGroup>
                <Input
                  v-else
                  :id="ids.name"
                  :model-value="state.value"
                  :data-testid="testIds.customizationName"
                  v-bind="errorProps('name', ids.nameError, state.meta)"
                  :maxlength="nameMaxChars(kind) + 8"
                  autocomplete="off"
                  autocapitalize="off"
                  spellcheck="false"
                  class="font-mono text-[13px]"
                  @update:model-value="value => field.handleChange(String(value))"
                  @blur="field.handleBlur"
                />
                <p v-if="shownError('name', state.meta)" :id="ids.nameError" class="text-xs text-destructive">
                  {{ shownError('name', state.meta) }}
                </p>
              </div>
            </template>
          </form.Field>

          <form.Field name="description">
            <template #default="{ field, state }">
              <div class="grid gap-2">
                <Label :for="ids.description">Description</Label>
                <Textarea
                  :id="ids.description"
                  :model-value="state.value"
                  :data-testid="testIds.customizationDescription"
                  :aria-invalid="shownError('description', state.meta) ? true : undefined"
                  :aria-describedby="ids.descriptionHelp"
                  rows="2"
                  class="max-h-[6.75rem] min-h-[3.75rem] resize-none"
                  @update:model-value="value => field.handleChange(String(value))"
                  @blur="field.handleBlur"
                />
                <p :id="ids.descriptionHelp" class="text-xs" :class="shownError('description', state.meta) ? 'text-destructive' : 'text-muted-foreground'">
                  {{ shownError('description', state.meta) ?? fieldCopy.descriptionHelp }}
                </p>
              </div>
            </template>
          </form.Field>

          <form.Field v-if="kind === 'command' || kind === 'skill'" name="whenToUse">
            <template #default="{ field, state }">
              <div class="grid gap-2">
                <Label :for="ids.whenToUse">When to use</Label>
                <Textarea
                  :id="ids.whenToUse"
                  :model-value="state.value"
                  :data-testid="testIds.customizationWhenToUse"
                  :aria-invalid="shownFieldError(fieldErrors.whenToUse, state.meta) ? true : undefined"
                  :aria-describedby="ids.whenToUseHelp"
                  rows="2"
                  class="max-h-[6.75rem] min-h-[3.75rem] resize-none"
                  @update:model-value="value => field.handleChange(String(value))"
                  @blur="field.handleBlur"
                />
                <p :id="ids.whenToUseHelp" class="text-xs" :class="shownFieldError(fieldErrors.whenToUse, state.meta) ? 'text-destructive' : 'text-muted-foreground'">
                  {{ shownFieldError(fieldErrors.whenToUse, state.meta) ?? 'Added to the description the agent reads.' }}
                </p>
              </div>
            </template>
          </form.Field>

          <form.Field v-if="kind !== 'style'" name="toolsMode">
            <template #default="{ field, state }">
              <fieldset class="grid gap-2.5">
                <legend class="mb-2 text-sm font-medium">
                  {{ fieldCopy.toolsLabel }}
                </legend>
                <RadioGroup
                  :model-value="state.value"
                  :aria-label="fieldCopy.toolsLabel"
                  :data-testid="testIds.customizationToolsMode"
                  :data-value="state.value"
                  class="flex flex-col gap-2 sm:flex-row sm:gap-5"
                  @update:model-value="value => onToolsMode(value, field.handleChange)"
                >
                  <Label class="font-normal pointer-coarse:min-h-10">
                    <RadioGroupItem value="all" />
                    {{ fieldCopy.toolsAll }}
                  </Label>
                  <Label class="font-normal pointer-coarse:min-h-10">
                    <RadioGroupItem value="some" />
                    Only these tools
                  </Label>
                </RadioGroup>
                <form.Field v-if="state.value === 'some'" name="tools">
                  <template #default="{ field: toolsField, state: toolsState }">
                    <ToolMultiSelect
                      :model-value="toolsState.value"
                      :tools="toolOptions"
                      :label="fieldCopy.toolsLabel"
                      :data-testid="testIds.customizationTools"
                      @update:model-value="value => toolsField.handleChange(value ?? [])"
                    />
                  </template>
                </form.Field>
                <ul v-if="warnings.tools" class="flex flex-col gap-0.5 text-xs text-muted-foreground">
                  <li v-for="(line, index) in warnings.tools" :key="index">
                    {{ line }}
                  </li>
                </ul>
              </fieldset>
            </template>
          </form.Field>

          <form.Field v-if="kind !== 'style'" name="disallowedTools">
            <template #default="{ field, state }">
              <div class="grid gap-2">
                <Label :id="ids.disallowed">{{ kind === 'agent' ? 'Tools not allowed' : 'Tools not allowed in this turn' }}</Label>
                <ToolMultiSelect
                  :model-value="state.value"
                  :tools="toolOptions"
                  :label="kind === 'agent' ? 'Tools not allowed' : 'Tools not allowed in this turn'"
                  :data-testid="testIds.customizationDisallowedTools"
                  :aria-describedby="ids.disallowedHelp"
                  @update:model-value="value => field.handleChange(value ?? [])"
                />
                <p :id="ids.disallowedHelp" class="text-xs text-muted-foreground">
                  Removed after the allowed tools. A rule with arguments, like Bash(rm *), removes the whole tool.
                </p>
              </div>
            </template>
          </form.Field>

          <form.Field v-if="kind !== 'style'" name="model">
            <template #default="{ field, state }">
              <div class="grid gap-2">
                <Label :for="ids.model">Model</Label>
                <SettingsModelSelect
                  :id="ids.model"
                  :model-value="state.value === 'inherit' ? null : state.value"
                  allow-none
                  :none-label="state.value === 'inherit' ? 'Same as the chat' : modelNoneLabel"
                  label="Model"
                  :data-testid="testIds.customizationModel"
                  :data-value="state.value ?? ''"
                  class="pointer-coarse:h-10"
                  @update:model-value="value => field.handleChange(value)"
                />
                <Label v-if="kind === 'agent'" :for="ids.inherit" class="font-normal text-muted-foreground pointer-coarse:min-h-10">
                  <Checkbox
                    :id="ids.inherit"
                    :model-value="state.value === 'inherit'"
                    @update:model-value="value => field.handleChange(value === true ? 'inherit' : null)"
                  />
                  Same as the chat
                </Label>
                <ul v-if="warnings.model" class="flex flex-col gap-0.5 text-xs text-muted-foreground">
                  <li v-for="(line, index) in warnings.model" :key="index">
                    {{ line }}
                  </li>
                </ul>
              </div>
            </template>
          </form.Field>

          <template v-if="kind === 'agent'">
            <form.Field name="maxTurns">
              <template #default="{ field, state }">
                <div class="grid gap-2">
                  <Label :for="ids.maxTurns">Max turns</Label>
                  <Input
                    :id="ids.maxTurns"
                    :model-value="state.value"
                    :data-testid="testIds.customizationMaxTurns"
                    inputmode="numeric"
                    autocomplete="off"
                    :maxlength="4"
                    :aria-invalid="shownFieldError(fieldErrors.maxTurns, state.meta) ? true : undefined"
                    :aria-describedby="ids.maxTurnsHelp"
                    class="w-28 tabular-nums pointer-coarse:h-10"
                    @update:model-value="value => field.handleChange(String(value))"
                    @blur="field.handleBlur"
                  />
                  <p :id="ids.maxTurnsHelp" class="text-xs" :class="shownFieldError(fieldErrors.maxTurns, state.meta) ? 'text-destructive' : 'text-muted-foreground'">
                    {{ shownFieldError(fieldErrors.maxTurns, state.meta) ?? 'At most this many steps; the sub-agent step limit still applies.' }}
                  </p>
                </div>
              </template>
            </form.Field>

            <form.Field name="color">
              <template #default="{ field, state }">
                <div class="grid gap-2">
                  <Label :for="ids.color">Color</Label>
                  <Select :model-value="state.value || NO_COLOR" @update:model-value="value => onColor(value, field.handleChange)">
                    <SelectTrigger
                      :id="ids.color"
                      :data-testid="testIds.customizationColor"
                      :data-value="state.value"
                      :aria-describedby="ids.colorHelp"
                      class="w-48 pointer-coarse:h-10"
                    >
                      <span class="inline-flex min-w-0 items-center gap-2">
                        <span v-if="state.value" aria-hidden="true" class="size-2 shrink-0 rounded-full" :style="colorDot(state.value)" />
                        {{ state.value ? AGENT_COLOR_LABELS[state.value] : 'None' }}
                      </span>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem :value="NO_COLOR" data-value="">
                        None
                      </SelectItem>
                      <SelectItem v-for="color in AGENT_COLORS" :key="color" :value="color" :data-value="color">
                        <span aria-hidden="true" data-slot="customization-color-dot" :data-value="color" class="size-2 shrink-0 rounded-full" :style="colorDot(color)" />
                        {{ AGENT_COLOR_LABELS[color] }}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <p :id="ids.colorHelp" class="text-xs text-muted-foreground">
                    Marks this agent's runs in the chat.
                  </p>
                </div>
              </template>
            </form.Field>

            <form.Field name="skills">
              <template #default="{ field, state }">
                <div class="grid gap-2">
                  <Label :id="ids.skills">Skills</Label>
                  <CustomizationSkillSelect
                    :model-value="state.value"
                    :options="skillOptions"
                    label="Skills"
                    :max="DEFINITION_LIMITS.agentSkillsMax"
                    :data-testid="testIds.customizationSkills"
                    :aria-describedby="ids.skillsHelp"
                    @update:model-value="value => field.handleChange(value)"
                  />
                  <p :id="ids.skillsHelp" class="text-xs" :class="shownFieldError(fieldErrors.skills, { isBlurred: true }) ? 'text-destructive' : 'text-muted-foreground'">
                    {{ shownFieldError(fieldErrors.skills, { isBlurred: true }) ?? 'Loaded into the sub-agent\'s instructions when it starts.' }}
                  </p>
                </div>
              </template>
            </form.Field>
          </template>

          <template v-if="kind === 'command' || kind === 'skill'">
            <form.Field name="fork">
              <template #default="{ field, state }">
                <div class="flex items-start justify-between gap-3">
                  <div class="grid gap-1">
                    <Label :for="ids.fork">Run in a sub-agent</Label>
                    <p :id="ids.forkHelp" class="text-xs text-muted-foreground">
                      The {{ kind === 'skill' ? 'skill' : 'command' }} runs as a sub-agent and only its report comes back.
                    </p>
                  </div>
                  <Switch
                    :id="ids.fork"
                    :model-value="state.value"
                    :aria-describedby="ids.forkHelp"
                    :data-testid="testIds.customizationFork"
                    class="mt-0.5 pointer-coarse:after:-inset-y-[11px]"
                    @update:model-value="value => field.handleChange(value === true)"
                  />
                </div>
              </template>
            </form.Field>
            <form.Field v-if="values.fork" name="forkAgent">
              <template #default="{ field, state }">
                <div class="grid gap-2">
                  <Label :for="ids.forkAgent">Agent</Label>
                  <Select :model-value="state.value || DEFAULT_FORK_AGENT" @update:model-value="value => onForkAgent(value, field.handleChange)">
                    <SelectTrigger
                      :id="ids.forkAgent"
                      :data-testid="testIds.customizationForkAgent"
                      :data-value="state.value || DEFAULT_FORK_AGENT"
                      class="w-full font-mono text-[13px] sm:w-64 pointer-coarse:h-10"
                    >
                      <span class="min-w-0 truncate">{{ state.value || DEFAULT_FORK_AGENT }}</span>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem v-for="agent in forkAgentOptions" :key="agent" :value="agent" :data-value="agent" class="font-mono text-[13px]">
                        {{ agent }}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </template>
            </form.Field>
          </template>

          <template v-if="kind === 'skill'">
            <form.Field name="userInvocable">
              <template #default="{ field, state }">
                <div class="flex items-start justify-between gap-3">
                  <div class="grid gap-1">
                    <Label :for="ids.userInvocable">Show in the slash menu</Label>
                  </div>
                  <Switch
                    :id="ids.userInvocable"
                    :model-value="state.value"
                    :data-testid="testIds.customizationUserInvocable"
                    class="mt-0.5 pointer-coarse:after:-inset-y-[11px]"
                    @update:model-value="value => field.handleChange(value === true)"
                  />
                </div>
              </template>
            </form.Field>
            <form.Field name="onlyWhenRun">
              <template #default="{ field, state }">
                <div class="flex items-start justify-between gap-3">
                  <div class="grid gap-1">
                    <Label :for="ids.modelInvocation">Only when you run it</Label>
                    <p :id="ids.modelInvocationHelp" class="text-xs text-muted-foreground">
                      The agent doesn't load it by itself; it runs only as /name.
                    </p>
                  </div>
                  <Switch
                    :id="ids.modelInvocation"
                    :model-value="state.value"
                    :aria-describedby="ids.modelInvocationHelp"
                    :data-testid="testIds.customizationModelInvocation"
                    class="mt-0.5 pointer-coarse:after:-inset-y-[11px]"
                    @update:model-value="value => field.handleChange(value === true)"
                  />
                </div>
              </template>
            </form.Field>
          </template>

          <form.Field v-if="kind === 'style'" name="keepCodingInstructions">
            <template #default="{ field, state }">
              <div class="flex items-start justify-between gap-3">
                <div class="grid gap-1">
                  <Label :for="ids.keepCoding">Keep coding instructions</Label>
                  <p :id="ids.keepCodingHelp" class="text-xs text-muted-foreground">
                    On: the agent keeps its tool rules and task hints. Off: only this style shapes its replies.
                  </p>
                </div>
                <Switch
                  :id="ids.keepCoding"
                  :model-value="state.value"
                  :aria-describedby="ids.keepCodingHelp"
                  :data-testid="testIds.customizationKeepCoding"
                  class="mt-0.5 pointer-coarse:after:-inset-y-[11px]"
                  @update:model-value="value => field.handleChange(value === true)"
                />
              </div>
            </template>
          </form.Field>

          <form.Field v-if="kind === 'command' || kind === 'skill'" name="argumentHint">
            <template #default="{ field, state }">
              <div class="grid gap-2">
                <Label :for="ids.argumentHint">Argument hint</Label>
                <Input
                  :id="ids.argumentHint"
                  :model-value="state.value"
                  :data-testid="testIds.customizationArgumentHint"
                  :aria-invalid="shownError('argumentHint', state.meta) ? true : undefined"
                  :aria-describedby="ids.argumentHintHelp"
                  placeholder="<file> [focus]"
                  autocomplete="off"
                  spellcheck="false"
                  class="font-mono text-[13px] placeholder:font-mono"
                  @update:model-value="value => field.handleChange(String(value))"
                  @blur="field.handleBlur"
                />
                <p :id="ids.argumentHintHelp" class="text-xs" :class="shownError('argumentHint', state.meta) ? 'text-destructive' : 'text-muted-foreground'">
                  {{ shownError('argumentHint', state.meta) ?? 'Shown after the command while you type its arguments.' }}
                </p>
              </div>
            </template>
          </form.Field>

          <form.Field name="body">
            <template #default="{ field, state }">
              <div class="grid gap-2">
                <div class="flex items-baseline justify-between gap-3">
                  <Label :id="ids.body">{{ copy.body }}</Label>
                  <span aria-live="off" class="text-xs tabular-nums" :class="bytes > CONTENT_MAX_BYTES ? 'text-destructive' : 'text-muted-foreground'">
                    {{ sizeLabel(bytes) }}
                  </span>
                </div>
                <MarkdownEditor
                  :model-value="state.value"
                  :label="copy.body"
                  :diagnostics="bodyMarkers"
                  :data-testid="testIds.customizationBody"
                  :aria-describedby="ids.bodyHelp"
                  @update:model-value="value => field.handleChange(value)"
                  @submit="submit"
                />
                <p :id="ids.bodyHelp" class="text-xs" :class="shownError('body', state.meta) ? 'text-destructive' : 'text-muted-foreground'">
                  {{ shownError('body', state.meta) ?? copy.bodyHelp }}
                </p>
              </div>
            </template>
          </form.Field>
        </div>

        <SheetFooter class="mt-0 gap-3 border-t bg-popover p-4">
          <Alert
            v-if="submitError || parseErrors.length > 0"
            role="alert"
            :data-testid="testIds.customizationError"
            :data-code="submitError?.code ?? 'validation_error'"
            class="border-destructive/35 bg-destructive/5 dark:bg-destructive/10"
          >
            <CircleAlertIcon aria-hidden="true" class="text-destructive" />
            <AlertTitle>{{ submitError?.message ?? 'The definition has errors.' }}</AlertTitle>
            <AlertDescription v-if="(submitError?.lines.length ?? 0) > 0 || (!submitError && parseErrors.length > 0)">
              <ul class="flex flex-col gap-0.5">
                <li v-for="(line, index) in submitError ? submitError.lines : parseErrors" :key="index">
                  {{ line }}
                </li>
              </ul>
            </AlertDescription>
          </Alert>
          <div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" :disabled="saving" class="pointer-coarse:h-10" @click="requestClose">
              Cancel
            </Button>
            <Button
              type="submit"
              :disabled="saving || invalid"
              :aria-busy="saving || undefined"
              :data-testid="testIds.customizationSave"
              class="pointer-coarse:h-10"
            >
              <Spinner v-if="saving" data-icon="inline-start" />
              {{ copy.save }}
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
    :data-testid="testIds.customizationDiscardConfirm"
    @update:open="value => discardOpen = value"
    @confirm="discard"
  />
</template>
