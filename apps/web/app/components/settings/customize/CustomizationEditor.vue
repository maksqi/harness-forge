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
import type { Customization, CustomizationKind, DefinitionDiagnostic, ToolSummary } from '@harness-forge/shared'
import type { AcceptableValue } from 'reka-ui'
import type { CustomizationDraft, DraftField } from './customize'
import { parseDefinition } from '@harness-forge/shared'
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
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import ConfirmDialog from '~/components/common/ConfirmDialog.vue'
import MarkdownEditor from '~/components/common/MarkdownEditor.vue'
import SettingsModelSelect from '~/components/settings/SettingsModelSelect.vue'
import { useCustomizationsStore } from '~/stores/customizations'
import { usePluginsStore } from '~/stores/plugins'
import { toHarnessError } from '~/utils/errors'
import { testIds } from '~/utils/testids'
import {
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
  nameError,
  nameMaxChars,
  sizeLabel,
  utf8Bytes,
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
}

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
  }
}

function draftOf(values: FormValues): CustomizationDraft {
  const draft: CustomizationDraft = {
    kind: props.kind,
    name: values.name,
    description: values.description,
    tools: props.kind === 'skill' || props.kind === 'style' || values.toolsMode === 'all' ? null : [...values.tools],
    model: props.kind === 'skill' || props.kind === 'style' ? null : values.model,
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
const invalid = computed(() => Object.keys(errors.value).length > 0 || parseErrors.value.length > 0)
const bodyMarkers = computed<DefinitionDiagnostic[]>(() => bodyDiagnostics(content.value, current.value.body, parsed.value.diagnostics))

const toolOptions = computed<readonly ToolSummary[]>(() => (props.kind === 'agent'
  // A sub-agent never gets the core-agent tools (task, todo_write, exit_plan_mode, skill).
  ? plugins.tools.filter(tool => tool.pluginId !== 'core-agent')
  : plugins.tools))

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

          <form.Field v-if="kind === 'agent' || kind === 'command'" name="toolsMode">
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

          <form.Field v-if="kind === 'agent' || kind === 'command'" name="model">
            <template #default="{ field, state }">
              <div class="grid gap-2">
                <Label :for="ids.model">Model</Label>
                <SettingsModelSelect
                  :id="ids.model"
                  :model-value="state.value === 'inherit' ? null : state.value"
                  allow-none
                  :none-label="state.value === 'inherit' ? 'Same as the chat' : fieldCopy.modelNone"
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
