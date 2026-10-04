<script setup lang="ts">
// Remember (docs/UI.md 7.30, 10.7, 12, 14, 15; docs/API.md 4.30, 5.29; ADR-047): `/remember [text]` opens this form
// dialog, mounted by ChatComposer (neither the layout nor the ui store changes), prefilled with the text.
// - Note: `remember-text` (label "Note", 3 -> 8 rows, the counter "{n} / 2,000"; over 2,000 characters after trimming:
//   "Use at most 2,000 characters." and Save disabled).
// - "Save to" (a radio group; items `remember-target`, `data-value`): the project file ("{file} in {project}", or
//   "AGENTS.md in {project} (new file)"), the project's instructions, the custom instructions. Outside a saved project
//   chat (`projectId` or `chatId` null) the project targets are disabled (`aria-disabled`) with the reason "Open a chat in
//   a project to use this." in their `aria-describedby`. The default: the last choice (`localStorage['hf-remember-target']`,
//   written after a save) when it is enabled, else the project file in project chats and the custom instructions
//   elsewhere.
// - Save (`remember-save`; disabled while the note is empty or too long, or a request runs) -> `POST /api/memory
//   { target, text, chatId }` through useApi(); the returned project goes to the projects store, the returned settings
//   to the settings store; the success toast; `saved`; the dialog closes. Failures stay inline above the buttons
//   (`remember-error`, `data-code` = the HarnessError code, `role="alert"`).
// - Keys: Mod+Enter saves (anywhere in the dialog), Esc cancels. An empty dialog opens with focus in the note, a
//   prefilled one on the selected target (arrows switch it). Closing never moves focus by itself: ChatComposer gives
//   it back to its textarea (desktop only).
// Props, emits and the root test id are frozen from Gate P10-0b (C33).
import type { HarnessError, RememberBody, RememberResult, RememberTarget } from '@harness-forge/shared'
import { createServerEvent } from '@harness-forge/shared'
import { CircleAlertIcon } from '@lucide/vue'
import { RadioGroupIndicator, RadioGroupItem, RadioGroupRoot } from 'reka-ui'
import { computed, nextTick, ref, shallowRef, useId, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { useApi } from '~/composables/useApi'
import { useProjectsStore } from '~/stores/projects'
import { useSettingsStore } from '~/stores/settings'
import { toHarnessError, withHarnessErrors } from '~/utils/errors'
import { testIds } from '~/utils/testids'
import {
  defaultTarget,
  REMEMBER_NEEDS_PROJECT,
  REMEMBER_TARGET_KEY,
  REMEMBER_TARGETS,
  REMEMBER_TEXT_MAX,
  REMEMBER_TOO_LONG,
  rememberCounter,
  rememberErrorText,
  rememberTargetCopy,
  rememberToast,
} from './remember'

const props = defineProps<{ open: boolean, text: string, projectId: string | null, chatId: string | null }>()

const emit = defineEmits<{ 'update:open': [open: boolean], 'saved': [result: RememberResult] }>()

const api = useApi()
const projects = useProjectsStore()
const settings = useSettingsStore()

const uid = useId()
const ids = {
  note: `${uid}-note`,
  noteError: `${uid}-note-error`,
  targets: `${uid}-targets`,
  reason: `${uid}-reason`,
  error: `${uid}-error`,
}

function targetId(target: RememberTarget, part: 'radio' | 'label' | 'description'): string {
  return `${uid}-${target}-${part}`
}

const note = ref('')
const target = ref<RememberTarget>('global')
const saving = ref(false)
const failure = shallowRef<HarnessError | null>(null)

/** A saved chat of a project: only there can the project targets be written (the server takes the project from the chat). */
const projectChat = computed(() => props.projectId !== null && props.chatId !== null)
const project = computed(() => (props.projectId ? projects.byId(props.projectId) ?? null : null))

const options = computed(() => REMEMBER_TARGETS.map(item => ({
  value: item.value,
  disabled: item.needsProject && !projectChat.value,
  ...rememberTargetCopy(item.value, project.value),
})))

const trimmed = computed(() => note.value.trim())
const tooLong = computed(() => trimmed.value.length > REMEMBER_TEXT_MAX)
const targetDisabled = computed(() => options.value.find(option => option.value === target.value)?.disabled ?? true)
const canSave = computed(() => !saving.value && trimmed.value !== '' && !tooLong.value && !targetDisabled.value)

// ---------- the last choice ----------

function readLastTarget(): string | null {
  try {
    return globalThis.localStorage?.getItem(REMEMBER_TARGET_KEY) ?? null
  }
  catch {
    return null
  }
}

function writeLastTarget(value: RememberTarget): void {
  try {
    globalThis.localStorage?.setItem(REMEMBER_TARGET_KEY, value)
  }
  catch {
    // Blocked or full storage: the choice is not remembered.
  }
}

// ---------- open and reset ----------

function reset() {
  note.value = props.text.trim()
  target.value = defaultTarget(projectChat.value, readLastTarget())
  failure.value = null
}

watch(() => props.open, (open) => {
  if (open)
    reset()
}, { immediate: true })

// A project that stops being available while the dialog is open (the chat moved): fall back to an enabled target.
watch(projectChat, () => {
  if (props.open && targetDisabled.value)
    target.value = defaultTarget(projectChat.value, null)
})

watch([note, target], () => {
  failure.value = null
})

function onTarget(value: unknown) {
  const next = REMEMBER_TARGETS.find(item => item.value === value)
  if (next)
    target.value = next.value
}

/** Focus on open: the note when it is empty, else the selected target. */
function onOpenAutoFocus(event: Event) {
  event.preventDefault()
  void nextTick(() => {
    const element = trimmed.value === ''
      ? document.getElementById(ids.note)
      : document.getElementById(targetId(target.value, 'radio')) ?? document.getElementById(ids.note)
    element?.focus()
  })
}

/** ChatComposer returns focus to its textarea (desktop only), so reka does not move it. */
function onCloseAutoFocus(event: Event) {
  event.preventDefault()
}

function close() {
  emit('update:open', false)
}

// ---------- save ----------

async function save() {
  if (!canSave.value)
    return
  const chosen = target.value
  const body: RememberBody = {
    target: chosen,
    text: trimmed.value,
    ...(props.chatId === null ? {} : { chatId: props.chatId }),
  }
  saving.value = true
  failure.value = null
  try {
    const result = await withHarnessErrors(api.memory.remember({ body }))
    if (result.project)
      projects.applyEvent(createServerEvent('project.changed', { id: result.project.id, project: result.project }))
    if (result.settings)
      settings.settings = result.settings
    writeLastTarget(chosen)
    toast.success(rememberToast(result, project.value?.name ?? null))
    emit('saved', result)
    if (props.open)
      close()
  }
  catch (error) {
    failure.value = toHarnessError(error)
  }
  finally {
    saving.value = false
  }
}

function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter' || event.isComposing || event.shiftKey || event.altKey || !(event.metaKey || event.ctrlKey))
    return
  event.preventDefault()
  void save()
}

const errorText = computed(() => (failure.value ? rememberErrorText(failure.value) : ''))

const TARGET_CLASS = [
  'group flex w-full items-start gap-3 rounded-lg border bg-card px-3 py-2.5 text-left text-sm outline-none',
  'transition-colors duration-(--duration-fast) hover:bg-accent/50 focus-visible:ring-[3px] focus-visible:ring-ring/50',
  'data-[state=checked]:border-primary data-[state=checked]:bg-primary/5',
  'data-disabled:cursor-not-allowed data-disabled:opacity-60 data-disabled:hover:bg-card pointer-coarse:min-h-10',
].join(' ')
</script>

<template>
  <Dialog :open="open" @update:open="value => emit('update:open', value)">
    <DialogContent
      :data-testid="testIds.rememberDialog"
      class="max-h-[90dvh] overflow-y-auto sm:max-w-lg"
      @open-auto-focus="onOpenAutoFocus"
      @close-auto-focus="onCloseAutoFocus"
    >
      <form class="grid min-w-0 gap-4" novalidate @submit.prevent="save" @keydown="onKeydown">
        <DialogHeader>
          <DialogTitle>Remember</DialogTitle>
          <DialogDescription class="sr-only">
            Save a note to your instructions.
          </DialogDescription>
        </DialogHeader>

        <div class="grid gap-1.5">
          <Label :for="ids.note">Note</Label>
          <Textarea
            :id="ids.note"
            :model-value="note"
            rows="3"
            :aria-invalid="tooLong || undefined"
            :aria-describedby="tooLong ? ids.noteError : undefined"
            :data-testid="testIds.rememberText"
            class="max-h-52 min-h-22 resize-none overflow-y-auto leading-6"
            @update:model-value="value => note = String(value)"
          />
          <div class="flex items-start justify-between gap-3">
            <p v-if="tooLong" :id="ids.noteError" class="text-sm text-destructive">
              {{ REMEMBER_TOO_LONG }}
            </p>
            <span
              aria-live="off"
              data-slot="remember-counter"
              :class="cn('ml-auto shrink-0 text-xs tabular-nums', tooLong ? 'text-destructive' : 'text-muted-foreground')"
            >{{ rememberCounter(trimmed.length) }}</span>
          </div>
        </div>

        <div class="grid gap-2">
          <span :id="ids.targets" class="text-sm font-medium">Save to</span>
          <p v-if="!projectChat" :id="ids.reason" class="text-sm text-muted-foreground">
            {{ REMEMBER_NEEDS_PROJECT }}
          </p>
          <RadioGroupRoot
            :model-value="target"
            :aria-labelledby="ids.targets"
            class="grid gap-2"
            @update:model-value="onTarget"
          >
            <RadioGroupItem
              v-for="option in options"
              :id="targetId(option.value, 'radio')"
              :key="option.value"
              :value="option.value"
              :disabled="option.disabled"
              :aria-disabled="option.disabled || undefined"
              :aria-labelledby="targetId(option.value, 'label')"
              :aria-describedby="option.disabled ? `${targetId(option.value, 'description')} ${ids.reason}` : targetId(option.value, 'description')"
              :data-testid="testIds.rememberTarget"
              :data-value="option.value"
              :class="TARGET_CLASS"
            >
              <span
                aria-hidden="true"
                class="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-input group-data-[state=checked]:border-primary group-data-[state=checked]:bg-primary"
              >
                <RadioGroupIndicator class="flex items-center justify-center">
                  <span class="size-1.5 rounded-full bg-primary-foreground" />
                </RadioGroupIndicator>
              </span>
              <span class="grid min-w-0 flex-1 gap-0.5">
                <span :id="targetId(option.value, 'label')" class="font-medium break-words">{{ option.label }}</span>
                <span :id="targetId(option.value, 'description')" class="text-muted-foreground">{{ option.description }}</span>
              </span>
            </RadioGroupItem>
          </RadioGroupRoot>
        </div>

        <p
          v-if="failure"
          :id="ids.error"
          role="alert"
          :data-testid="testIds.rememberError"
          :data-code="failure.code"
          class="flex items-start gap-2 text-sm text-destructive"
        >
          <CircleAlertIcon aria-hidden="true" class="mt-0.5 size-4 shrink-0" />
          <span class="min-w-0 break-words">{{ errorText }}</span>
        </p>

        <DialogFooter>
          <Button type="button" variant="outline" class="pointer-coarse:h-10" @click="close">
            Cancel
          </Button>
          <Button
            type="submit"
            :disabled="!canSave"
            :aria-busy="saving || undefined"
            :aria-describedby="failure ? ids.error : undefined"
            :data-testid="testIds.rememberSave"
            class="pointer-coarse:h-10"
          >
            <Spinner v-if="saving" data-icon="inline-start" />
            Save
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
