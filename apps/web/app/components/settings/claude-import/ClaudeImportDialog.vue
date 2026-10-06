<script setup lang="ts">
// Import from Claude Code (Phase 12, ADR-055; docs/UI.md 2.19, 9.14, 10.9): a dialog (`claude-import-dialog`,
// `data-step` source | preview | result) mounted by pages/settings/customize.vue (`?import=claude`, the header's
// `customize-import-claude`). Step 1 ClaudeImportSource → Continue (`claude-import-continue`): `useClaudeImport()`
// `planFromFiles` / `planFromZip` (upload, no side effects) or `scanServer` (fresh auth); step 2 ClaudeImportPreview →
// Back (`claude-import-back`) / Import {n} items (`claude-import-submit`, `data-count`): `apply(planId, selection)` (fresh
// auth, the prompt text from `needsFreshAuth`); step 3 ClaudeImportResult. Errors: `claude-import-error` (`data-code`).
// After an apply the customizations, the hooks and the settings are refetched and `imported(result)` is emitted. Closing
// drops the state (the server's plan expires by itself).
// Props, emits and the root test id are frozen from Gate P12-0b (C46 stub); W12.10 implements the wizard in P12-A
// (focus on every step, the live region, the expired plan, the mobile layout).
import type { ClaudeImportApplyResult, ClaudeImportHome, ClaudeImportPlan } from '@harness-forge/shared'
import type { ClaudeImportSelection } from './claude-import'
import { computed, ref, shallowRef, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import ConfirmPasswordDialog from '~/components/common/ConfirmPasswordDialog.vue'
import { useClaudeImport } from '~/composables/useClaudeImport'
import { isFreshAuthCancelled, useFreshAuth } from '~/composables/useFreshAuth'
import { useCustomizationsStore } from '~/stores/customizations'
import { useHooksStore } from '~/stores/hooks'
import { useSettingsStore } from '~/stores/settings'
import { toHarnessError } from '~/utils/errors'
import { testIds } from '~/utils/testids'
import { defaultSelection, needsFreshAuth } from './claude-import'
import ClaudeImportPreview from './ClaudeImportPreview.vue'
import ClaudeImportResult from './ClaudeImportResult.vue'
import ClaudeImportSource from './ClaudeImportSource.vue'

const props = defineProps<{ open: boolean }>()

const emit = defineEmits<{ 'update:open': [open: boolean], 'imported': [result: ClaudeImportApplyResult] }>()

type Choice = { kind: 'folder', files: readonly File[], claudeJson: File | null } | { kind: 'zip', file: File } | { kind: 'server' }

const PROMPTS = {
  scan: 'Scanning this server\'s Claude Code folder needs your password.',
  executables: 'Importing hooks and commands that run on this server needs your password.',
  import: 'Importing from Claude Code needs your password.',
} as const

const claudeImport = useClaudeImport()
const freshAuth = useFreshAuth()
const customizations = useCustomizationsStore()
const hooks = useHooksStore()
const settings = useSettingsStore()

const step = ref<'source' | 'preview' | 'result'>('source')
const busy = ref(false)
const home = shallowRef<ClaudeImportHome | null>(null)
const choice = shallowRef<Choice | null>(null)
const plan = shallowRef<ClaudeImportPlan | null>(null)
const selection = ref<ClaudeImportSelection>({ items: {}, instructions: 'append' })
const result = shallowRef<ClaudeImportApplyResult | null>(null)
const error = shallowRef<{ code: string, message: string } | null>(null)
const prompt = ref<string>(PROMPTS.import)
let session = 0

const canContinue = computed(() => {
  const current = choice.value
  if (!current || busy.value)
    return false
  return current.kind !== 'folder' || current.files.length > 0 || current.claudeJson !== null
})
const picked = computed(() => Object.keys(selection.value.items).length)

watch(() => props.open, (open) => {
  session += 1
  step.value = 'source'
  busy.value = false
  choice.value = null
  plan.value = null
  result.value = null
  error.value = null
  selection.value = { items: {}, instructions: 'append' }
  freshAuth.cancel()
  if (open) {
    const current = session
    claudeImport.serverHome()
      .then((value) => {
        if (current === session)
          home.value = value
      })
      .catch(() => {})
  }
}, { immediate: true })

function fail(failure: unknown): void {
  const harnessError = toHarnessError(failure)
  error.value = { code: harnessError.code, message: harnessError.message }
}

async function continueToPreview(): Promise<void> {
  const current = choice.value
  if (!current || !canContinue.value)
    return
  const started = session
  busy.value = true
  error.value = null
  try {
    let next: ClaudeImportPlan
    if (current.kind === 'folder') {
      next = await claudeImport.planFromFiles(current.files, current.claudeJson)
    }
    else if (current.kind === 'zip') {
      next = await claudeImport.planFromZip(current.file)
    }
    else {
      prompt.value = PROMPTS.scan
      next = await freshAuth.run(() => claudeImport.scanServer(), { required: true })
    }
    if (started !== session)
      return
    plan.value = next
    selection.value = defaultSelection(next)
    step.value = 'preview'
  }
  catch (failure) {
    if (started === session && !isFreshAuthCancelled(failure))
      fail(failure)
  }
  finally {
    if (started === session)
      busy.value = false
  }
}

async function submit(): Promise<void> {
  const current = plan.value
  if (!current || busy.value)
    return
  const needs = needsFreshAuth(current, selection.value)
  if (needs === null)
    return
  const started = session
  prompt.value = PROMPTS[needs]
  busy.value = true
  error.value = null
  try {
    const applied = await freshAuth.run(() => claudeImport.apply(current.id, selection.value), { required: true })
    if (started !== session)
      return
    result.value = applied
    step.value = 'result'
    void customizations.refreshLoaded().catch(() => {})
    void hooks.refreshLoaded().catch(() => {})
    void settings.fetch().catch(() => {})
    emit('imported', applied)
  }
  catch (failure) {
    if (started === session && !isFreshAuthCancelled(failure))
      fail(failure)
  }
  finally {
    if (started === session)
      busy.value = false
  }
}

function back(): void {
  if (busy.value)
    return
  step.value = 'source'
  plan.value = null
  error.value = null
}
</script>

<template>
  <Dialog :open="open" @update:open="value => emit('update:open', value)">
    <DialogContent
      :data-testid="testIds.claudeImportDialog"
      :data-step="step"
      class="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-2xl"
    >
      <DialogHeader>
        <DialogTitle>Import from Claude Code</DialogTitle>
        <DialogDescription>
          Step {{ step === 'source' ? 1 : step === 'preview' ? 2 : 3 }} of 3
        </DialogDescription>
      </DialogHeader>

      <div class="-mx-1 grid min-h-0 content-start gap-4 overflow-y-auto px-1">
        <ClaudeImportSource
          v-if="step === 'source'"
          :busy="busy"
          :server-home="home"
          @folder="(files, claudeJson) => choice = { kind: 'folder', files, claudeJson }"
          @zip="file => choice = { kind: 'zip', file }"
          @scan="choice = { kind: 'server' }"
        />
        <ClaudeImportPreview v-else-if="step === 'preview' && plan" v-model:selection="selection" :plan="plan" />
        <ClaudeImportResult v-else-if="result" :result="result" />

        <p v-if="error" role="alert" :data-testid="testIds.claudeImportError" :data-code="error.code" class="text-sm text-destructive">
          {{ error.message }}
        </p>
      </div>

      <DialogFooter>
        <template v-if="step === 'source'">
          <Button type="button" variant="outline" :disabled="busy" @click="emit('update:open', false)">
            Cancel
          </Button>
          <Button type="button" :disabled="!canContinue" :data-testid="testIds.claudeImportContinue" @click="continueToPreview">
            Continue
          </Button>
        </template>
        <template v-else-if="step === 'preview'">
          <Button type="button" variant="outline" :disabled="busy" :data-testid="testIds.claudeImportBack" @click="back">
            Back
          </Button>
          <Button type="button" :disabled="busy || picked === 0" :data-testid="testIds.claudeImportSubmit" :data-count="picked" @click="submit">
            Import {{ picked }} {{ picked === 1 ? 'item' : 'items' }}
          </Button>
        </template>
        <Button v-else type="button" variant="outline" @click="emit('update:open', false)">
          Close
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <ConfirmPasswordDialog
    :open="freshAuth.open.value"
    :description="prompt"
    :pending="freshAuth.pending.value"
    :error="freshAuth.error.value"
    @update:open="freshAuth.setOpen"
    @submit="freshAuth.submit"
  />
</template>
