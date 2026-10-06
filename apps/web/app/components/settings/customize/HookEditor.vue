<script setup lang="ts">
// The hook editor of the Customize Hooks tab (Phase 11, ADR-048; docs/UI.md 2.18, 9.13, 10.8, 14): a right Sheet
// (`w-full sm:max-w-2xl`, full width on phones) whose body scrolls under a sticky footer, titled "New hook" / "Edit hook"
// / "Copy hook". The warning (`hook-warning`), Event (`hook-event`, a Select of the eight events with their descriptions
// from `HOOK_EVENT_INFO`), Tools (`hook-matcher`, PreToolUse and PostToolUse only, mono, checked with the shared
// `compileMatcher`; the preview `hook-matcher-preview` "Matches {list}" / "No tool is named {name} now." through
// `matcherPreview` over the tools store, debounced 300 ms, `aria-live="polite"`), Command (`hook-command`, a mono
// textarea), Timeout (`hook-timeout`, 1 – 600 seconds, empty = 60) and On (`hook-editor-enabled`). TanStack Form holds
// the fields; the inline errors show once a field was left or a save was tried.
// Save hook (`hook-save`, also Mod+Enter in any field) → `useFreshAuth().run(() => hooks.create(body) | hooks.update(id,
// patch), { required })` ("Saving a hook needs your password."; an edit that only turns the hook off needs none) →
// toast "Hook saved", `saved`, close. A 400 on the matcher shows on the field; any other error shows in the form-level
// alert (`hook-error`, `data-code`). Closing with changes (Esc, ×, Cancel, a click outside) asks "Discard changes?"
// (`hook-discard-confirm`). Opens with focus on Event (new, copy) or Command (edit); reka returns focus to the element
// that had it when the sheet opened. Tab is never captured.
// Props, emits and the root test id are frozen from Gate P11-0b (C39 stub); implementation W11.8.
// Phase 12 (ADR-056, ADR-057; C46 CCR, W12.12 owns it in P12-A): `mode: 'project'` with `target` edits a hook of a
// project's settings file (`hook-editor[data-mode=project]`): Save writes through `hooks.saveProjectHook(projectId, target,
// draft)` (no password: saving never approves) and closes without `saved` (no personal hook); the Type toggle
// (`hook-type`), the Prompt field (`hook-prompt`) and the five new events are W12.12's.
import type { HookCreate, HookEvent, HookUpdate, PersonalHook } from '@harness-forge/shared'
import type { AcceptableValue } from 'reka-ui'
import type { HookDraft, ProjectHookTarget } from './hooks'
import { HOOK_EVENTS, HOOK_LIMITS, isHookTurnOff } from '@harness-forge/shared'
import { CircleAlertIcon, TriangleAlertIcon } from '@lucide/vue'
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
import ConfirmDialog from '~/components/common/ConfirmDialog.vue'
import ConfirmPasswordDialog from '~/components/common/ConfirmPasswordDialog.vue'
import { isFreshAuthCancelled, useFreshAuth } from '~/composables/useFreshAuth'
import { useHooksStore } from '~/stores/hooks'
import { usePluginsStore } from '~/stores/plugins'
import { toHarnessError } from '~/utils/errors'
import { testIds } from '~/utils/testids'
import { commandError, HOOK_COPY, HOOK_EVENT_INFO, matcherError, matcherPreview, parseHookTimeout } from './hooks'

const props = defineProps<{
  open: boolean
  /** + Phase 12: `project` edits a hook of a project's settings file (`target`). */
  mode: 'new' | 'edit' | 'copy' | 'project'
  /** Edit mode: the personal hook. */
  hook: PersonalHook | null
  /** New (Duplicate, Copy to personal), copy and project mode: the prefilled fields. */
  draft?: HookDraft | null
  /** + Phase 12, project mode: where the hook is written (null indexes = a new handler). */
  target?: ProjectHookTarget | null
}>()

const emit = defineEmits<{ 'update:open': [open: boolean], 'saved': [hook: PersonalHook] }>()

interface FormValues {
  event: HookEvent
  matcher: string
  command: string
  timeout: string
  enabled: boolean
}

type Field = 'matcher' | 'command' | 'timeout'

/** How long the matcher preview waits after the last keystroke. */
const PREVIEW_DELAY_MS = 300

const hooks = useHooksStore()
const plugins = usePluginsStore()
const freshAuth = useFreshAuth()
const ids = {
  event: useId(),
  eventHelp: useId(),
  matcher: useId(),
  matcherHelp: useId(),
  matcherPreview: useId(),
  command: useId(),
  commandHelp: useId(),
  timeout: useId(),
  timeoutHelp: useId(),
  enabled: useId(),
}

const title = computed(() => ({ new: 'New hook', edit: 'Edit hook', copy: 'Copy hook', project: 'Edit project hook' })[props.mode])

const EMPTY_DRAFT: HookDraft = { event: 'PreToolUse', matcher: '', command: '', timeout: null, enabled: true }

/** The draft the sheet opened with (its values decide "changed"). */
const initial = shallowRef<HookDraft>(EMPTY_DRAFT)
const submitError = ref<{ code: string, message: string } | null>(null)
/** A matcher the server refused (400 on `matcher`), until the matcher changes. */
const serverMatcher = ref<{ value: string, message: string } | null>(null)
const discardOpen = ref(false)
const saving = ref(false)

function valuesOf(draft: HookDraft): FormValues {
  return {
    event: draft.event,
    matcher: draft.matcher,
    command: draft.command,
    timeout: draft.timeout === null ? '' : String(draft.timeout),
    enabled: draft.enabled,
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

const toolEvent = computed(() => HOOK_EVENT_INFO[values.value.event].toolMatcher)
const dirty = computed(() => JSON.stringify(values.value) !== JSON.stringify(valuesOf(initial.value)))

const errors = computed<Partial<Record<Field, string>>>(() => {
  const found: Partial<Record<Field, string>> = {}
  const current = values.value
  if (toolEvent.value) {
    const matcher = matcherError(current.matcher)
      ?? (serverMatcher.value && serverMatcher.value.value === current.matcher ? serverMatcher.value.message : null)
    if (matcher)
      found.matcher = matcher
  }
  const command = commandError(current.command)
  if (command)
    found.command = command
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

/** The inline error of a field once it was left or a save was tried; a server refusal shows at once. */
function shownError(field: Field, meta?: { isBlurred: boolean }): string | null {
  const error = errors.value[field]
  if (!error)
    return null
  if (field === 'matcher' && serverMatcher.value)
    return error
  return attempted.value || meta?.isBlurred ? error : null
}

// ---------- opening ----------

function openingDraft(): HookDraft {
  if (props.mode === 'edit' && props.hook) {
    const hook = props.hook
    // Phase 12 (C40 compile fix): prompt hooks (ADR-057) open with an empty command until W12.12 adds the Prompt type.
    return { event: hook.event, matcher: hook.matcher ?? '', command: hook.type === 'command' ? hook.command : '', timeout: hook.timeout, enabled: hook.enabled }
  }
  return props.draft ? { ...props.draft } : { ...EMPTY_DRAFT }
}

watch(() => props.open, (open) => {
  if (!open)
    return
  initial.value = openingDraft()
  form.reset(valuesOf(initial.value))
  submitError.value = null
  serverMatcher.value = null
  discardOpen.value = false
  saving.value = false
  if (!plugins.toolsLoaded)
    plugins.fetchTools().catch(() => {})
}, { immediate: true })

function focusField(id: string): void {
  void nextTick(() => document.getElementById(id)?.focus())
}

function onOpenAutoFocus(event: Event): void {
  event.preventDefault()
  focusField(props.mode === 'edit' || props.mode === 'project' ? ids.command : ids.event)
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

/** The matcher to save: tool events send theirs (null for every tool); other events keep only an unchanged one. */
function matcherOf(current: FormValues): string | null {
  if (HOOK_EVENT_INFO[current.event].toolMatcher)
    return current.matcher.trim() || null
  return current.event === initial.value.event ? initial.value.matcher.trim() || null : null
}

function bodyOf(current: FormValues): Extract<HookCreate, { command: string }> & { matcher: string | null, timeout: number | null, enabled: boolean } {
  const timeout = parseHookTimeout(current.timeout)
  return {
    event: current.event,
    matcher: matcherOf(current),
    command: current.command.trim(),
    timeout: 'value' in timeout ? timeout.value : null,
    enabled: current.enabled,
  }
}

/** The changed fields of an edit. */
function patchOf(hook: PersonalHook, body: ReturnType<typeof bodyOf>): HookUpdate {
  const patch: HookUpdate = {}
  if (body.event !== hook.event)
    patch.event = body.event
  if (body.matcher !== (hook.matcher?.trim() || null))
    patch.matcher = body.matcher
  if (body.command !== (hook.type === 'command' ? hook.command : ''))
    patch.command = body.command
  if (body.timeout !== hook.timeout)
    patch.timeout = body.timeout
  if (body.enabled !== hook.enabled)
    patch.enabled = body.enabled
  return patch
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
  if (errors.value.matcher)
    return ids.matcher
  if (errors.value.command)
    return ids.command
  if (errors.value.timeout)
    return ids.timeout
  return null
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

async function save(): Promise<void> {
  if (saving.value)
    return
  if (invalid.value) {
    const field = firstInvalidField()
    if (field)
      focusField(field)
    return
  }
  const current = values.value
  const body = bodyOf(current)
  saving.value = true
  submitError.value = null
  try {
    if (props.mode === 'project') {
      // Phase 12: a project's settings file; no password (saving never approves), no personal hook to emit.
      const target = props.target
      if (!target)
        return
      await hooks.saveProjectHook(target.projectId, target, { ...initial.value, event: current.event, matcher: body.matcher ?? '', command: body.command, timeout: body.timeout, enabled: current.enabled })
      toast.success(HOOK_COPY.saved!)
      form.reset({ ...current })
      initial.value = { ...initial.value, event: current.event, matcher: current.matcher, command: current.command, timeout: body.timeout, enabled: current.enabled }
      emit('update:open', false)
      return
    }
    let saved: PersonalHook
    if (props.mode === 'edit' && props.hook) {
      const hook = props.hook
      const patch = patchOf(hook, body)
      if (Object.keys(patch).length === 0) {
        initial.value = openingDraft()
        emit('update:open', false)
        return
      }
      saved = await freshAuth.run(() => hooks.update(hook.id, patch), { required: !isHookTurnOff(patch) })
    }
    else {
      saved = await freshAuth.run(() => hooks.create(body), { required: true })
    }
    toast.success(HOOK_COPY.saved!)
    form.reset({ ...current })
    initial.value = { event: current.event, matcher: current.matcher, command: current.command, timeout: body.timeout, enabled: current.enabled }
    emit('saved', saved)
    emit('update:open', false)
  }
  catch (error) {
    if (isFreshAuthCancelled(error))
      return
    const failure = toHarnessError(error)
    const matcher = matcherIssue(failure)
    if (matcher) {
      serverMatcher.value = { value: current.matcher, message: matcher }
      focusField(ids.matcher)
    }
    else {
      submitError.value = { code: failure.code, message: failure.message }
    }
  }
  finally {
    saving.value = false
  }
}

function onEvent(value: AcceptableValue, handleChange: (value: HookEvent) => void): void {
  if (typeof value === 'string' && (HOOK_EVENTS as readonly string[]).includes(value))
    handleChange(value as HookEvent)
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
        <SheetDescription class="sr-only">
          {{ HOOK_COPY.warning }}
        </SheetDescription>
      </SheetHeader>

      <form
        class="flex min-h-0 flex-1 flex-col"
        novalidate
        @submit.prevent.stop="submit"
        @keydown="onKeydown"
      >
        <div class="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-contain p-4">
          <Alert :data-testid="testIds.hookWarning" class="border-warning/40 bg-warning/5 dark:bg-warning/10 *:[svg]:text-warning">
            <TriangleAlertIcon aria-hidden="true" />
            <AlertDescription class="text-foreground">
              {{ HOOK_COPY.warning }}
            </AlertDescription>
          </Alert>

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
              </div>
            </template>
          </form.Field>

          <form.Field v-if="toolEvent" name="matcher">
            <template #default="{ field, state }">
              <div class="grid gap-2">
                <Label :for="ids.matcher">Tools</Label>
                <Input
                  :id="ids.matcher"
                  :model-value="state.value"
                  :data-testid="testIds.hookMatcher"
                  :aria-invalid="shownError('matcher', state.meta) ? true : undefined"
                  :aria-describedby="`${ids.matcherHelp} ${ids.matcherPreview}`"
                  :maxlength="HOOK_LIMITS.matcherMaxChars + 8"
                  placeholder="Bash|Edit"
                  autocomplete="off"
                  autocapitalize="off"
                  spellcheck="false"
                  class="font-mono text-[13px] placeholder:font-mono pointer-coarse:h-10"
                  @update:model-value="value => field.handleChange(String(value))"
                  @blur="field.handleBlur"
                />
                <p :id="ids.matcherHelp" class="text-xs text-muted-foreground">
                  {{ HOOK_COPY.matcherHelp }}
                </p>
                <p
                  :id="ids.matcherPreview"
                  :data-testid="testIds.hookMatcherPreview"
                  :data-count="preview.matches.length"
                  aria-live="polite"
                  class="min-h-4 text-xs break-words"
                  :class="shownError('matcher', state.meta) || !preview.ok ? 'text-destructive' : 'text-muted-foreground'"
                >
                  {{ shownError('matcher', state.meta) ?? preview.text }}
                </p>
              </div>
            </template>
          </form.Field>

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
                    placeholder="60"
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

          <form.Field name="enabled">
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
</template>
