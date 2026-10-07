<script setup lang="ts">
// Import from Claude Code (Phase 12, ADR-055; docs/UI.md 2.19, 9.14, 10.9, 14): a dialog named "Import from Claude
// Code" (`claude-import-dialog`, `data-step` source | preview | result) mounted by pages/settings/customize.vue
// (`?import=claude`, the header's `customize-import-claude`). A dialog on desktop (`max-w-2xl`), full screen below `sm`
// with a sticky footer and 40px targets. The step heading ("Step {n} of 3" as text, then the step's title) takes focus
// when the dialog opens and on every step change.
// 1. ClaudeImportSource → Continue (`claude-import-continue`, disabled until the source has something to send):
//    `useClaudeImport()` `planFromFiles` / `planFromZip` (upload, no side effects) or `scanServer` (fresh auth: "Scanning
//    this server's Claude Code folder needs your password."). The source stays mounted, so Back keeps what was picked.
// 2. ClaudeImportPreview → Back (`claude-import-back`) / Import {n} items (`claude-import-submit`, `data-count`; never the
//    default button), with "Includes {n} items that run commands on this server." when such items are picked:
//    `apply(planId, selection)` (fresh auth; the prompt text from `needsFreshAuth`). An expired plan (404) reads "This
//    preview expired. Start again." with Start again (back to step 1). Escape, × or the overlay ask "Discard this
//    import?" (Keep reviewing focused); nothing closes the dialog while the import runs.
// 3. ClaudeImportResult (+ the turned-off lines) → Open Customize (the tab of the first imported kind), MCP servers (when
//    servers were imported: Plugins → MCP servers) and Close.
//    The server's warnings show as they are (W12.17: it never repeats the per-item turned-off notes, so nothing is
//    filtered).
// Errors: `claude-import-error` (`data-code`, `role="alert"`). After an apply the customizations, the hooks, the shell
// rules (when loaded) and the settings are refetched and `imported(result)` is emitted. Closing drops the state (the
// server's plan expires by itself); the page removes `?import=claude`.
// Props, emits and the root test id are frozen from Gate P12-0b (C46 stub); body W12.10 (P12-A).
import type { ClaudeImportApplyResult, ClaudeImportHome, ClaudeImportPlan } from '@harness-forge/shared'
import type { ClaudeImportSelection } from './claude-import'
import { CircleAlertIcon } from '@lucide/vue'
import { computed, nextTick, ref, shallowRef, useTemplateRef, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import ConfirmDialog from '~/components/common/ConfirmDialog.vue'
import ConfirmPasswordDialog from '~/components/common/ConfirmPasswordDialog.vue'
import { CORE_MCP_PLUGIN_ID } from '~/components/plugins/mcp/mcp-form'
import { useRoute, useRouter } from '~/components/settings/nuxt-imports'
import { useClaudeImport } from '~/composables/useClaudeImport'
import { isFreshAuthCancelled, useFreshAuth } from '~/composables/useFreshAuth'
import { useCustomizationsStore } from '~/stores/customizations'
import { useHooksStore } from '~/stores/hooks'
import { useSettingsStore } from '~/stores/settings'
import { useShellRulesStore } from '~/stores/shell-rules'
import { toHarnessError } from '~/utils/errors'
import { testIds } from '~/utils/testids'
import {
  defaultSelection,
  executableCount,
  executablesText,
  importedServers,
  importErrorText,
  needsFreshAuth,
  resultTab,
  submitText,
  turnedOffLines,
} from './claude-import'
import ClaudeImportPreview from './ClaudeImportPreview.vue'
import ClaudeImportResult from './ClaudeImportResult.vue'
import ClaudeImportSource from './ClaudeImportSource.vue'

const props = defineProps<{ open: boolean }>()

const emit = defineEmits<{ 'update:open': [open: boolean], 'imported': [result: ClaudeImportApplyResult] }>()

type Step = 'source' | 'preview' | 'result'
type Choice = { kind: 'folder', files: readonly File[], claudeJson: File | null } | { kind: 'zip', file: File } | { kind: 'server' }

const PROMPTS = {
  scan: 'Scanning this server\'s Claude Code folder needs your password.',
  executables: 'Importing hooks and commands that run on this server needs your password.',
  import: 'Importing from Claude Code needs your password.',
} as const

const STEP_TITLES: Readonly<Record<Step, string>> = {
  source: 'Choose what to read',
  preview: 'Choose what to import',
  result: 'Import finished',
}

/** Full screen below `sm` (docs/UI.md 14.5): the content fills the viewport and the footer row stays at the bottom. */
const CONTENT_CLASS = [
  'max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] gap-4 sm:max-w-2xl',
  'max-sm:top-0 max-sm:left-0 max-sm:h-dvh max-sm:max-h-dvh max-sm:w-full max-sm:max-w-full max-sm:translate-x-0 max-sm:translate-y-0',
  'max-sm:rounded-none max-sm:p-4 max-sm:pb-[max(1rem,env(safe-area-inset-bottom))]',
].join(' ')
const FOOTER_BUTTON = 'max-sm:h-10 pointer-coarse:h-10'

const claudeImport = useClaudeImport()
const freshAuth = useFreshAuth()
const customizations = useCustomizationsStore()
const hooks = useHooksStore()
const settings = useSettingsStore()
const shellRules = useShellRulesStore()
const route = useRoute()
const router = useRouter()
const heading = useTemplateRef<HTMLElement>('heading')

const step = ref<Step>('source')
const busy = ref(false)
const home = shallowRef<ClaudeImportHome | null>(null)
const choice = shallowRef<Choice | null>(null)
const plan = shallowRef<ClaudeImportPlan | null>(null)
const selection = ref<ClaudeImportSelection>({ items: {}, instructions: 'append' })
const applied = shallowRef<ClaudeImportSelection | null>(null)
const result = shallowRef<ClaudeImportApplyResult | null>(null)
const error = shallowRef<{ code: string, message: string, expired: boolean } | null>(null)
const prompt = ref<string>(PROMPTS.import)
const discardOpen = ref(false)
/** Bumped on every open / close: an answer that arrives after it is dropped. */
let session = 0

const stepNumber = computed(() => (step.value === 'source' ? 1 : step.value === 'preview' ? 2 : 3))
const canContinue = computed(() => {
  const current = choice.value
  if (!current || busy.value)
    return false
  return current.kind !== 'folder' || current.files.length > 0 || current.claudeJson !== null
})
const picked = computed(() => Object.keys(selection.value.items).length)
const executables = computed(() => (plan.value ? executableCount(plan.value, selection.value) : 0))
const turnedOff = computed(() => (plan.value && applied.value && result.value ? turnedOffLines(plan.value, applied.value, result.value) : []))
const openTab = computed(() => (plan.value && result.value ? resultTab(plan.value, result.value) : null))
const showServers = computed(() => (plan.value && result.value ? importedServers(plan.value, result.value) : false))

watch(() => props.open, (open) => {
  session += 1
  step.value = 'source'
  busy.value = false
  choice.value = null
  plan.value = null
  applied.value = null
  result.value = null
  error.value = null
  discardOpen.value = false
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

watch(step, async () => {
  await nextTick()
  heading.value?.focus()
})

function onOpenAutoFocus(event: Event): void {
  event.preventDefault()
  heading.value?.focus()
}

/** Escape, × and the overlay: step 2 asks first; nothing closes while the import runs. */
function onOpenChange(value: boolean): void {
  if (value) {
    emit('update:open', true)
    return
  }
  if (busy.value && step.value === 'preview')
    return
  if (step.value === 'preview') {
    discardOpen.value = true
    return
  }
  emit('update:open', false)
}

function discard(): void {
  discardOpen.value = false
  emit('update:open', false)
}

function fail(failure: unknown, at: 'source' | 'preview'): void {
  const harnessError = toHarnessError(failure)
  error.value = {
    code: harnessError.code,
    message: importErrorText(harnessError, at),
    expired: at === 'preview' && harnessError.code === 'not_found',
  }
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
      fail(failure, 'source')
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
  const picks = selection.value
  prompt.value = PROMPTS[needs]
  busy.value = true
  error.value = null
  try {
    const answer = await freshAuth.run(() => claudeImport.apply(current.id, picks), { required: true })
    if (started !== session)
      return
    applied.value = picks
    result.value = answer
    step.value = 'result'
    void customizations.refreshLoaded().catch(() => {})
    void hooks.refreshLoaded().catch(() => {})
    void settings.fetch().catch(() => {})
    if (shellRules.loaded)
      void shellRules.fetchAll().catch(() => {})
    emit('imported', answer)
  }
  catch (failure) {
    if (started === session && !isFreshAuthCancelled(failure))
      fail(failure, 'preview')
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
  selection.value = { items: {}, instructions: 'append' }
  error.value = null
}

/** Open Customize: closes the dialog and shows the tab of the first imported kind (the other query values kept). */
function openCustomize(): void {
  const tab = openTab.value
  const { import: _import, ...query } = route?.query ?? {}
  emit('update:open', false)
  if (tab !== null)
    router.push({ path: '/settings/customize', query: { ...query, tab } }).catch(() => {})
}

/** MCP servers: closes the dialog and opens Plugins → MCP servers (`core-mcp`), where the imported servers are listed. */
function openServers(): void {
  emit('update:open', false)
  router.push(`/plugins/${CORE_MCP_PLUGIN_ID}`).catch(() => {})
}
</script>

<template>
  <Dialog :open="open" @update:open="onOpenChange">
    <DialogContent
      :data-testid="testIds.claudeImportDialog"
      :data-step="step"
      :aria-busy="busy || undefined"
      :class="CONTENT_CLASS"
      @open-auto-focus="onOpenAutoFocus"
    >
      <DialogHeader class="pr-8">
        <DialogTitle>Import from Claude Code</DialogTitle>
        <DialogDescription>
          Agents, commands, skills, hooks and MCP servers from a Claude Code folder.
        </DialogDescription>
      </DialogHeader>

      <div class="-mx-1 grid min-h-0 content-start gap-4 overflow-y-auto px-1">
        <h3 ref="heading" tabindex="-1" class="text-sm font-medium outline-none" data-slot="claude-import-step">
          <span class="text-muted-foreground">Step {{ stepNumber }} of 3</span> · {{ STEP_TITLES[step] }}
        </h3>
        <ClaudeImportSource
          v-show="step === 'source'"
          :busy="busy"
          :server-home="home"
          @folder="(files, claudeJson) => choice = { kind: 'folder', files, claudeJson }"
          @zip="file => choice = { kind: 'zip', file }"
          @scan="choice = { kind: 'server' }"
        />
        <ClaudeImportPreview v-if="step === 'preview' && plan" v-model:selection="selection" :plan="plan" />
        <ClaudeImportResult v-if="step === 'result' && result" :result="result">
          <p v-for="line in turnedOff" :key="line" data-slot="claude-import-turned-off">
            {{ line }}
          </p>
        </ClaudeImportResult>
      </div>

      <div class="grid min-w-0 gap-3 border-t pt-3 max-sm:-mx-4 max-sm:px-4">
        <div
          v-if="error"
          role="alert"
          :data-testid="testIds.claudeImportError"
          :data-code="error.code"
          class="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-destructive"
        >
          <CircleAlertIcon aria-hidden="true" class="size-4 shrink-0" />
          <span class="min-w-0 flex-1 break-words">{{ error.message }}</span>
          <Button v-if="error.expired" type="button" size="sm" variant="outline" :class="FOOTER_BUTTON" data-action="start-again" @click="back">
            Start again
          </Button>
        </div>
        <p v-if="step === 'preview' && executables > 0" class="text-xs text-muted-foreground" data-slot="claude-import-executables">
          {{ executablesText(executables) }}
        </p>
        <DialogFooter>
          <template v-if="step === 'source'">
            <Button type="button" variant="outline" :class="FOOTER_BUTTON" @click="onOpenChange(false)">
              Cancel
            </Button>
            <Button type="button" :class="FOOTER_BUTTON" :disabled="!canContinue" :aria-busy="busy || undefined" :data-testid="testIds.claudeImportContinue" @click="continueToPreview">
              {{ busy ? 'Reading…' : 'Continue' }}
            </Button>
          </template>
          <template v-else-if="step === 'preview'">
            <Button type="button" variant="outline" :class="FOOTER_BUTTON" :disabled="busy" :data-testid="testIds.claudeImportBack" @click="back">
              Back
            </Button>
            <Button
              type="button"
              :class="FOOTER_BUTTON"
              :disabled="busy || picked === 0"
              :aria-busy="busy || undefined"
              :data-testid="testIds.claudeImportSubmit"
              :data-count="picked"
              @click="submit"
            >
              {{ busy ? 'Importing…' : submitText(picked) }}
            </Button>
          </template>
          <template v-else>
            <Button type="button" variant="outline" :class="FOOTER_BUTTON" data-action="open-customize" @click="openCustomize">
              Open Customize
            </Button>
            <Button v-if="showServers" type="button" variant="outline" :class="FOOTER_BUTTON" data-action="open-mcp" @click="openServers">
              MCP servers
            </Button>
            <Button type="button" :class="FOOTER_BUTTON" data-action="close" @click="emit('update:open', false)">
              Close
            </Button>
          </template>
        </DialogFooter>
      </div>
    </DialogContent>
  </Dialog>

  <ConfirmDialog
    :open="discardOpen"
    title="Discard this import?"
    description="Nothing is imported. The preview is dropped."
    confirm-label="Discard"
    cancel-label="Keep reviewing"
    @update:open="value => discardOpen = value"
    @confirm="discard"
  />

  <ConfirmPasswordDialog
    :open="freshAuth.open.value"
    :description="prompt"
    :pending="freshAuth.pending.value"
    :error="freshAuth.error.value"
    @update:open="freshAuth.setOpen"
    @submit="freshAuth.submit"
  />
</template>
