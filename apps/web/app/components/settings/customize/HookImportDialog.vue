<script setup lang="ts">
// The hook import of the Customize Hooks tab (Phase 11, ADR-048; docs/UI.md 2.18, 9.13, 10.8, 14): a form dialog "Import
// hooks" (full width minus 1rem on phones, sticky footer) with the JSON textarea (`hook-import-input`, mono) and Choose
// file… (`hook-import-file`: a visually hidden `.json` input behind a button, at most 256 KB). The text goes through
// `importHooks` (the shared `readSettingsHooks` / `readHooksConfig`; only the `hooks` key is read): the preview "Found {n}
// hooks" (`hook-import-preview`) lists every handler (`hook-import-item`, `data-event`, `data-state` ready | invalid)
// with a checkbox (checked when ready; an invalid one unchecked and disabled with its reason), its event, matcher,
// command and timeout; notes say what was left out; errors (`hook-import-error`): "This isn't valid JSON." / "No hooks
// found.". "Add {n} hooks" (`hook-import-submit`, also Mod+Enter) creates the checked ones as personal hooks, one request
// each under one password prompt ("Saving a hook needs your password.") → toast "Added {n} hooks", `imported`, close.
// Mounted by HooksPanel. Props, emits and the root test id are frozen from Gate P11-0b (C39 stub); implementation W11.8.
import type { PersonalHook } from '@harness-forge/shared'
import type { ImportedHook } from './hooks'
import { CircleAlertIcon, FileUpIcon } from '@lucide/vue'
import { computed, ref, shallowRef, useId, useTemplateRef, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import ConfirmPasswordDialog from '~/components/common/ConfirmPasswordDialog.vue'
import { isFreshAuthCancelled, useFreshAuth } from '~/composables/useFreshAuth'
import { useHooksStore } from '~/stores/hooks'
import { toHarnessError } from '~/utils/errors'
import { testIds } from '~/utils/testids'
import { addedHooksText, addHooksText, foundHooksText, HOOK_COPY, HOOK_EVENT_INFO, HOOK_IMPORT_MAX_BYTES, importHooks, matchesEveryTool } from './hooks'

defineProps<{ open: boolean }>()

const emit = defineEmits<{ 'update:open': [open: boolean], 'imported': [hooks: PersonalHook[]] }>()

const hooks = useHooksStore()
const freshAuth = useFreshAuth()
const fileInput = useTemplateRef<HTMLInputElement>('fileInput')
const ids = { input: useId(), help: useId() }

const text = ref('')
const fileError = ref<string | null>(null)
const submitError = ref<{ code: string, message: string } | null>(null)
const saving = ref(false)
/** The indexes of the preview the user unchecked (ready items are checked by default). */
const unchecked = ref<ReadonlySet<number>>(new Set())
/** Hooks already created by this import (a retry after a password prompt does not create them twice). */
const created = shallowRef<Map<number, PersonalHook>>(new Map())

const result = computed(() => importHooks(text.value))
const items = computed(() => result.value.items)
const error = computed(() => fileError.value ?? result.value.error)
const checked = computed(() => items.value
  .map((item, index) => ({ item, index }))
  .filter(({ item, index }) => item.valid && !unchecked.value.has(index)))

function reset(): void {
  text.value = ''
  fileError.value = null
  submitError.value = null
  saving.value = false
  unchecked.value = new Set()
  created.value = new Map()
}

watch(text, () => {
  unchecked.value = new Set()
  created.value = new Map()
  submitError.value = null
})

function onOpenChange(value: boolean): void {
  if (!value && saving.value)
    return
  emit('update:open', value)
  if (!value)
    reset()
}

function toggle(index: number, value: boolean | 'indeterminate'): void {
  const next = new Set(unchecked.value)
  if (value === true)
    next.delete(index)
  else
    next.add(index)
  unchecked.value = next
}

function itemTitle(item: ImportedHook): string {
  const event = HOOK_EVENT_INFO[item.draft.event].label
  const matcher = item.draft.matcher.trim()
  if (!HOOK_EVENT_INFO[item.draft.event].toolMatcher)
    return matcher === '' ? event : `${event} · ${matcher}`
  return `${event} · ${matchesEveryTool(matcher) && item.valid ? HOOK_COPY.allTools : matcher}`
}

// ---------- the file ----------

function chooseFile(): void {
  const input = fileInput.value
  if (!input)
    return
  input.value = ''
  input.click()
}

async function onFileChosen(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file)
    return
  if (file.size > HOOK_IMPORT_MAX_BYTES) {
    fileError.value = `${file.name} is too large`
    return
  }
  fileError.value = null
  text.value = (await file.text()).replace(/^\uFEFF/, '')
}

function onTextInput(value: string | number): void {
  fileError.value = null
  text.value = String(value)
}

// ---------- adding ----------

function onKeydown(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.isComposing || event.key !== 'Enter' || !(event.metaKey || event.ctrlKey))
    return
  event.preventDefault()
  void submit()
}

async function submit(): Promise<void> {
  if (saving.value || checked.value.length === 0)
    return
  const chosen = checked.value
  saving.value = true
  submitError.value = null
  try {
    // One password prompt for every request: the task creates the checked hooks one by one and skips the ones done.
    await freshAuth.run(async () => {
      for (const { item, index } of chosen) {
        if (created.value.has(index))
          continue
        const { draft } = item
        const hook = await hooks.create({
          event: draft.event,
          matcher: draft.matcher.trim() || null,
          command: draft.command,
          timeout: draft.timeout,
          enabled: draft.enabled,
        })
        created.value = new Map(created.value).set(index, hook)
      }
    }, { required: true })
    const added = chosen.map(({ index }) => created.value.get(index)).filter((hook): hook is PersonalHook => hook !== undefined)
    toast.success(addedHooksText(added.length))
    emit('imported', added)
    emit('update:open', false)
    reset()
  }
  catch (failure) {
    if (isFreshAuthCancelled(failure))
      return
    const harnessError = toHarnessError(failure)
    submitError.value = { code: harnessError.code, message: harnessError.message }
    if (created.value.size > 0)
      emit('imported', [...created.value.values()])
  }
  finally {
    saving.value = false
  }
}
</script>

<template>
  <Dialog :open="open" @update:open="onOpenChange">
    <DialogContent
      :data-testid="testIds.hookImportDialog"
      class="flex max-h-[min(44rem,calc(100dvh-2rem))] w-[calc(100%-1rem)] flex-col gap-0 p-0 sm:max-w-2xl"
      @keydown="onKeydown"
    >
      <DialogHeader class="border-b p-4 pr-12">
        <DialogTitle>{{ HOOK_COPY.importTitle }}</DialogTitle>
        <DialogDescription :id="ids.help">
          {{ HOOK_COPY.importHelp }}
        </DialogDescription>
      </DialogHeader>

      <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain p-4">
        <div class="grid gap-2">
          <div class="flex items-end justify-between gap-3">
            <Label :for="ids.input">Settings JSON</Label>
            <Button type="button" size="sm" variant="outline" class="pointer-coarse:h-10" @click="chooseFile">
              <FileUpIcon aria-hidden="true" data-icon="inline-start" />
              Choose file…
            </Button>
          </div>
          <input
            ref="fileInput"
            type="file"
            accept=".json,application/json"
            class="sr-only"
            tabindex="-1"
            aria-hidden="true"
            :data-testid="testIds.hookImportFile"
            @change="onFileChosen"
          >
          <Textarea
            :id="ids.input"
            :model-value="text"
            :data-testid="testIds.hookImportInput"
            :aria-describedby="ids.help"
            :aria-invalid="error ? true : undefined"
            rows="6"
            placeholder="{ &quot;hooks&quot;: { &quot;PreToolUse&quot;: [ … ] } }"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            class="max-h-64 min-h-28 font-mono text-[13px] placeholder:font-mono"
            @update:model-value="onTextInput"
          />
        </div>

        <p v-if="error" role="alert" :data-testid="testIds.hookImportError" class="text-sm text-destructive">
          {{ error }}
        </p>

        <section
          v-if="items.length > 0"
          :data-testid="testIds.hookImportPreview"
          :data-count="items.length"
          :aria-label="foundHooksText(items.length)"
          class="flex flex-col gap-2"
        >
          <h3 class="text-sm font-medium">
            {{ foundHooksText(items.length) }}
          </h3>
          <ul class="flex flex-col divide-y rounded-lg border">
            <li
              v-for="(item, index) in items"
              :key="index"
              :data-testid="testIds.hookImportItem"
              :data-event="item.draft.event"
              :data-state="item.valid ? 'ready' : 'invalid'"
              class="flex min-w-0 items-start gap-3 px-3 py-2"
            >
              <Checkbox
                :id="`${ids.input}-item-${index}`"
                :model-value="item.valid && !unchecked.has(index)"
                :disabled="!item.valid || saving"
                :aria-label="itemTitle(item)"
                class="mt-0.5 pointer-coarse:after:-inset-3"
                @update:model-value="value => toggle(index, value)"
              />
              <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                <div class="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5 text-sm">
                  <span class="font-medium break-all" :class="item.valid ? undefined : 'text-muted-foreground'">{{ itemTitle(item) }}</span>
                  <code class="min-w-0 flex-1 basis-40 truncate font-mono text-xs" :title="item.draft.command">{{ item.draft.command }}</code>
                  <span class="text-xs text-muted-foreground tabular-nums">{{ item.draft.timeout ?? 60 }}s</span>
                </div>
                <p v-if="item.message" class="text-xs text-destructive">
                  {{ item.message }}
                </p>
              </div>
            </li>
          </ul>
        </section>

        <ul v-if="result.notes.length > 0" data-slot="hook-import-notes" class="flex flex-col gap-0.5 text-xs text-muted-foreground">
          <li v-for="(note, index) in result.notes" :key="index">
            {{ note }}
          </li>
        </ul>
      </div>

      <DialogFooter class="flex-col gap-3 border-t p-4 sm:flex-col">
        <Alert
          v-if="submitError"
          role="alert"
          data-slot="hook-import-submit-error"
          :data-code="submitError.code"
          class="border-destructive/35 bg-destructive/5 dark:bg-destructive/10"
        >
          <CircleAlertIcon aria-hidden="true" class="text-destructive" />
          <AlertTitle>{{ submitError.message }}</AlertTitle>
          <AlertDescription v-if="created.size > 0">
            {{ addedHooksText(created.size) }}
          </AlertDescription>
        </Alert>
        <div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" :disabled="saving" class="h-10 sm:h-9 pointer-coarse:h-10" @click="onOpenChange(false)">
            Cancel
          </Button>
          <Button
            type="button"
            :disabled="saving || checked.length === 0"
            :aria-busy="saving || undefined"
            :data-testid="testIds.hookImportSubmit"
            :data-count="checked.length"
            class="h-10 sm:h-9 pointer-coarse:h-10"
            @click="submit"
          >
            <Spinner v-if="saving" data-icon="inline-start" />
            {{ addHooksText(checked.length) }}
          </Button>
        </div>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <ConfirmPasswordDialog
    :open="freshAuth.open.value"
    :description="HOOK_COPY.passwordPrompt"
    :pending="freshAuth.pending.value"
    :error="freshAuth.error.value"
    @update:open="freshAuth.setOpen"
    @submit="freshAuth.submit"
  />
</template>
