<script setup lang="ts">
// Provider wizard (docs/UI.md 8.5 and 10.4 `ProviderWizard`): five steps (Basics, API, Credentials, Models, Review)
// over one TanStack form, validated with the shared zod schemas (wizard.ts). Next is disabled until the step is valid
// (pressing it anyway shows the step's errors and focuses the first one); completed steps are clickable. The create
// flow keeps a draft without secret values in localStorage['hf-wizard-draft'] ("Discard draft" clears it).
// Create: `POST /api/plugins` (credentials travel in the draft and are stored encrypted by the server) -> toast
// "Provider created" -> emit `created(id)`. Edit (`editId`, from `?edit=`): the declarative plugin's manifest is loaded
// into the same steps and saved with `PUT /api/plugins/:id/manifest`; `created(id)` is emitted after "Save changes"
// too. A fresh-auth refusal (403 + action login, stdio MCP servers) asks for the password and retries once.
import type { IconRef, ModelInfo, PluginDetail, PluginManifest, ValidationIssue } from '@harness-forge/shared'
import type { WizardIssues, WizardStep, WizardValues } from './wizard'
import type { WizardContext } from './wizard-context'
import { HarnessError } from '@harness-forge/shared'
import { CheckIcon, HistoryIcon } from '@lucide/vue'
import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import {
  Stepper,
  StepperIndicator,
  StepperItem,
  StepperSeparator,
  StepperTitle,
  StepperTrigger,
} from '@/components/ui/stepper'
import ConfirmDialog from '~/components/common/ConfirmDialog.vue'
import ConfirmPasswordDialog from '~/components/common/ConfirmPasswordDialog.vue'
import { useApi } from '~/composables/useApi'
import { useAuthStore } from '~/stores/auth'
import { usePluginsStore } from '~/stores/plugins'
import { useProvidersStore } from '~/stores/providers'
import { toHarnessError } from '~/utils/errors'
import { testIds } from '~/utils/testids'
import {
  buildDraft,
  buildManifestUpdate,
  clearWizardDraft,
  defaultWizardValues,
  enteredCredentials,
  firstInvalidStep,
  hasDraftContent,
  issuesOfStep,
  loadWizardDraft,
  providerIdOf,
  saveWizardDraft,
  STEP_DESCRIPTIONS,
  STEP_TITLES,
  validateWizard,
  valuesFromManifest,
  WIZARD_STEPS,
  wizardPathOfIssue,
} from './wizard'
import { createErrorLookup, createWizardForm, WIZARD_CONTEXT } from './wizard-context'
import WizardApiStep from './WizardApiStep.vue'
import WizardBasicsStep from './WizardBasicsStep.vue'
import WizardCredentialsStep from './WizardCredentialsStep.vue'
import WizardErrorAlert from './WizardErrorAlert.vue'
import WizardModelsStep from './WizardModelsStep.vue'
import WizardReviewStep from './WizardReviewStep.vue'

const props = defineProps<{ editId?: string }>()
const emit = defineEmits<{ created: [id: string], cancel: [] }>()

const api = useApi()
const auth = useAuthStore()
const plugins = usePluginsStore()
const providers = useProvidersStore()

const STEP_TEST_IDS: Readonly<Record<WizardStep, string>> = {
  basics: testIds.wizardStepBasics,
  api: testIds.wizardStepApi,
  credentials: testIds.wizardStepCredentials,
  models: testIds.wizardStepModels,
  review: testIds.wizardStepReview,
}

// ---------- state ----------

const editing = computed(() => Boolean(props.editId))
const stored = props.editId ? null : loadWizardDraft()
const form = createWizardForm(stored?.values ?? defaultWizardValues())
const values = form.useSelector(state => state.values)

const step = ref<WizardStep>('basics')
const touched = ref<ReadonlySet<string>>(new Set())
const attempted = ref<ReadonlySet<WizardStep>>(new Set())
const serverIssues = ref<WizardIssues>({})
const fetched = ref<ModelInfo[] | null>(null)
const detail = ref<PluginDetail | null>(null)
const base = ref<PluginManifest | null>(null)
const loading = ref(Boolean(props.editId))
const loadError = ref<unknown>(null)
const restored = ref(stored !== null && hasDraftContent(stored.values))
const submitting = ref(false)
const submitError = ref<unknown>(null)
const discardOpen = ref(false)
const passwordOpen = ref(false)
const passwordPending = ref(false)
const passwordError = ref<string | null>(null)
const panel = ref<HTMLElement | null>(null)
let created = false

const existingIds = computed(() => new Set(plugins.items.map(plugin => plugin.id)))
const issues = computed<WizardIssues>(() => ({
  ...serverIssues.value,
  ...validateWizard(values.value, { existingIds: existingIds.value, editing: editing.value, base: base.value }),
}))
const errorOf = createErrorLookup(issues, touched, attempted)
const existingIcon = computed<IconRef>(() => detail.value?.icon ?? null)

function touch(path: string) {
  if (!touched.value.has(path))
    touched.value = new Set([...touched.value, path])
}

function patch(next: Partial<WizardValues>) {
  for (const key of Object.keys(next) as Array<keyof WizardValues>) {
    if (JSON.stringify(values.value[key]) !== JSON.stringify(next[key]))
      form.setFieldValue(key, next[key] as never, { dontUpdateMeta: true })
  }
}

const context: WizardContext = { form, values, issues, editing, base, existingIcon, fetched, errorOf, touch, patch }
provide(WIZARD_CONTEXT, context)

// ---------- steps ----------

const index = computed(() => WIZARD_STEPS.indexOf(step.value))
const isLast = computed(() => step.value === 'review')

function isStepValid(target: WizardStep): boolean {
  return issuesOfStep(issues.value, target).length === 0
}

/** Every step before `target` is valid. */
function isReachable(target: WizardStep): boolean {
  return WIZARD_STEPS.slice(0, WIZARD_STEPS.indexOf(target)).every(isStepValid)
}

function isCompleted(target: WizardStep): boolean {
  return WIZARD_STEPS.indexOf(target) < index.value && isStepValid(target)
}

async function focusStep() {
  await nextTick()
  const root = panel.value
  const target = root?.querySelector<HTMLElement>('[data-wizard-autofocus]')
    ?? root?.querySelector<HTMLElement>('input:not([type="hidden"]):not([tabindex="-1"]), textarea, button')
  target?.focus()
}

async function focusFirstInvalid() {
  await nextTick()
  panel.value?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
}

function markAttempted(target: WizardStep) {
  if (!attempted.value.has(target))
    attempted.value = new Set([...attempted.value, target])
}

function goTo(target: WizardStep | undefined) {
  if (!target || target === step.value || !isReachable(target))
    return
  step.value = target
  void focusStep()
}

function onStepperChange(value: number | undefined) {
  if (value !== undefined)
    goTo(WIZARD_STEPS[value - 1])
}

async function next() {
  if (!isStepValid(step.value)) {
    markAttempted(step.value)
    await focusFirstInvalid()
    return
  }
  goTo(WIZARD_STEPS[index.value + 1])
}

function back() {
  goTo(WIZARD_STEPS[index.value - 1])
}

/** Enter in a field of the step panel moves on (never creates). */
function onPanelSubmit() {
  if (!isLast.value)
    void next()
}

// ---------- draft ----------

/** Draft writes are debounced; a pending write is flushed when the wizard goes away. */
const PERSIST_DELAY_MS = 300
let persistTimer: ReturnType<typeof setTimeout> | undefined

function persistNow() {
  clearTimeout(persistTimer)
  persistTimer = undefined
  if (editing.value || created)
    return
  if (hasDraftContent(values.value))
    saveWizardDraft(step.value, values.value)
  else
    clearWizardDraft()
}

watch([values, step], () => {
  clearTimeout(persistTimer)
  persistTimer = setTimeout(persistNow, PERSIST_DELAY_MS)
})

onBeforeUnmount(() => {
  if (persistTimer !== undefined)
    persistNow()
})

watch(values, () => {
  if (Object.keys(serverIssues.value).length > 0)
    serverIssues.value = {}
  submitError.value = null
})

function discardDraft() {
  clearWizardDraft()
  form.reset(defaultWizardValues())
  touched.value = new Set()
  attempted.value = new Set()
  serverIssues.value = {}
  fetched.value = null
  submitError.value = null
  restored.value = false
  discardOpen.value = false
  step.value = 'basics'
  toast('Draft discarded')
  void focusStep()
}

// ---------- load (edit mode) ----------

async function loadForEdit(id: string) {
  loading.value = true
  loadError.value = null
  try {
    const found = await plugins.fetchOne(id)
    if (found.builtin || found.kind !== 'declarative' || !found.editable)
      throw new HarnessError({ code: 'forbidden', message: `${found.name} cannot be edited in the provider wizard.` })
    detail.value = found
    base.value = found.manifest
    form.reset(valuesFromManifest(found.manifest))
  }
  catch (error) {
    loadError.value = error
  }
  finally {
    loading.value = false
  }
}

onMounted(async () => {
  void plugins.fetchAll().catch(() => {})
  if (props.editId) {
    await loadForEdit(props.editId)
    return
  }
  if (stored) {
    // Back to where the draft was left, but never past the first step that needs work.
    const blocked = firstInvalidStep(issues.value)
    const wanted = WIZARD_STEPS.indexOf(stored.step)
    step.value = blocked !== null && WIZARD_STEPS.indexOf(blocked) < wanted ? blocked : stored.step
  }
  void focusStep()
})

// ---------- create / save ----------

async function saveEditedCredentials() {
  const entered = enteredCredentials(values.value)
  if (Object.keys(entered).length === 0)
    return
  try {
    await providers.saveCredentials(providerIdOf(values.value), entered)
  }
  catch (error) {
    toast.error('The changes were saved, but not the credentials', { description: toHarnessError(error).message })
  }
}

function showServerIssues(error: HarnessError) {
  const reported = (error.details as { issues?: ValidationIssue[] } | undefined)?.issues ?? []
  const mapped: WizardIssues = {}
  for (const issue of reported) {
    const path = wizardPathOfIssue(issue.path, values.value)
    mapped[path] ??= issue.message
  }
  if (Object.keys(mapped).length === 0)
    mapped.manifest = error.message
  serverIssues.value = mapped
  const target = firstInvalidStep(mapped) ?? 'review'
  markAttempted(target)
  if (target === 'review')
    submitError.value = error
  step.value = target
  void focusFirstInvalid()
}

function handleSubmitError(error: unknown) {
  const failure = toHarnessError(error)
  if (failure.code === 'forbidden' && failure.action === 'login') {
    passwordError.value = null
    passwordOpen.value = true
    return
  }
  if (failure.code === 'validation_error') {
    showServerIssues(failure)
    return
  }
  const reason = (failure.details as { reason?: unknown } | undefined)?.reason
  if (failure.code === 'conflict' && reason === 'exists' && !editing.value) {
    void plugins.fetchAll().catch(() => {})
    serverIssues.value = { id: failure.message }
    markAttempted('basics')
    step.value = 'basics'
    void focusFirstInvalid()
    return
  }
  submitError.value = failure
}

async function submit() {
  const invalid = firstInvalidStep(issues.value)
  if (invalid !== null && invalid !== 'review') {
    markAttempted(invalid)
    step.value = invalid
    await focusFirstInvalid()
    return
  }
  submitting.value = true
  submitError.value = null
  try {
    if (props.editId && base.value) {
      const saved = await api.pluginDrafts.updateManifest({ params: { id: props.editId }, body: buildManifestUpdate(values.value, base.value) })
      await saveEditedCredentials()
      toast.success('Changes saved')
      void plugins.fetchOne(saved.id).catch(() => {})
      emit('created', saved.id)
    }
    else {
      const createdPlugin = await api.pluginDrafts.create({ body: buildDraft(values.value) })
      created = true
      clearWizardDraft()
      toast.success('Provider created')
      void plugins.fetchOne(createdPlugin.id).catch(() => {})
      emit('created', createdPlugin.id)
    }
  }
  catch (error) {
    handleSubmitError(error)
  }
  finally {
    submitting.value = false
  }
}

async function confirmPassword(password: string) {
  passwordPending.value = true
  passwordError.value = null
  try {
    await auth.login(password)
  }
  catch (error) {
    const failure = toHarnessError(error)
    passwordError.value = failure.code === 'unauthorized' ? 'Wrong password' : failure.message
    return
  }
  finally {
    passwordPending.value = false
  }
  passwordOpen.value = false
  await submit()
}
</script>

<template>
  <div :data-testid="testIds.wizard" :data-step="step" class="flex flex-col gap-6">
    <div v-if="loading" class="grid gap-4" aria-busy="true" aria-label="Loading the plugin">
      <Skeleton class="h-14 w-full rounded-lg" />
      <Skeleton class="h-72 w-full rounded-xl" />
    </div>

    <WizardErrorAlert v-else-if="loadError" :error="loadError">
      <Button type="button" size="sm" variant="outline" @click="emit('cancel')">
        Back to plugins
      </Button>
    </WizardErrorAlert>

    <template v-else>
      <p v-if="restored && !editing" class="-mb-2 flex items-center gap-2 text-xs text-muted-foreground">
        <HistoryIcon aria-hidden="true" class="size-3.5" />
        Continuing your draft.
      </p>

      <Stepper
        :model-value="index + 1"
        :linear="false"
        class="flex w-full items-start gap-2"
        @update:model-value="onStepperChange"
      >
        <StepperItem
          v-for="(item, position) in WIZARD_STEPS"
          :key="item"
          :step="position + 1"
          :completed="isCompleted(item)"
          :disabled="!isReachable(item)"
          :data-step-item="item"
          class="relative flex w-full flex-col items-center justify-center"
        >
          <StepperSeparator
            v-if="position < WIZARD_STEPS.length - 1"
            class="absolute top-4 right-[calc(-50%+18px)] left-[calc(50%+22px)] block h-0.5 shrink-0 rounded-full bg-border group-data-[state=completed]:bg-primary/70"
          />
          <StepperTrigger as-child>
            <button
              type="button"
              class="z-10 rounded-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed"
              :aria-label="`${STEP_TITLES[item]}, step ${position + 1} of ${WIZARD_STEPS.length}`"
            >
              <StepperIndicator
                class="size-8 border text-xs font-semibold tabular-nums group-data-[state=active]:border-primary group-data-[state=completed]:border-primary/70 group-data-[state=completed]:bg-primary/15 group-data-[state=completed]:text-foreground group-data-[state=inactive]:bg-background group-data-[state=inactive]:text-muted-foreground"
              >
                <CheckIcon v-if="isCompleted(item)" aria-hidden="true" class="size-4" />
                <span v-else aria-hidden="true">{{ position + 1 }}</span>
              </StepperIndicator>
            </button>
          </StepperTrigger>
          <div class="mt-2 flex flex-col items-center text-center">
            <StepperTitle
              class="text-xs font-medium text-muted-foreground group-data-[state=active]:text-foreground sm:text-sm"
            >
              {{ STEP_TITLES[item] }}
            </StepperTitle>
          </div>
        </StepperItem>
      </Stepper>

      <form
        ref="panel"
        novalidate
        :aria-label="`${STEP_TITLES[step]} step`"
        class="rounded-xl border bg-card shadow-xs"
        @submit.prevent="onPanelSubmit"
      >
        <header class="border-b px-5 py-4">
          <h2 class="text-base font-medium tracking-tight">
            {{ STEP_TITLES[step] }}
            <span class="ml-1 text-xs font-normal text-muted-foreground tabular-nums">{{ index + 1 }} / {{ WIZARD_STEPS.length }}</span>
          </h2>
          <p class="mt-0.5 text-sm text-muted-foreground">
            {{ STEP_DESCRIPTIONS[step] }}
          </p>
        </header>
        <div :data-testid="STEP_TEST_IDS[step]" class="px-5 py-5">
          <WizardBasicsStep v-if="step === 'basics'" />
          <WizardApiStep v-else-if="step === 'api'" />
          <WizardCredentialsStep v-else-if="step === 'credentials'" />
          <WizardModelsStep v-else-if="step === 'models'" />
          <WizardReviewStep v-else />
        </div>
        <!-- Enter in a text field submits the step form (Next). -->
        <button type="submit" class="hidden" tabindex="-1" aria-hidden="true" />
      </form>

      <WizardErrorAlert v-if="submitError" :error="submitError" :provider-name="values.name || undefined" />

      <footer class="flex flex-wrap items-center gap-2">
        <Button
          v-if="!editing"
          type="button"
          variant="link"
          class="h-auto px-0 text-muted-foreground hover:text-foreground"
          :data-testid="testIds.wizardDiscard"
          @click="discardOpen = true"
        >
          Discard draft
        </Button>
        <div class="ml-auto flex items-center gap-2">
          <Button v-if="index === 0" type="button" variant="ghost" @click="emit('cancel')">
            Cancel
          </Button>
          <Button v-else type="button" variant="ghost" :data-testid="testIds.wizardBack" @click="back">
            Back
          </Button>
          <Button
            v-if="!isLast"
            type="button"
            :aria-disabled="!isStepValid(step) || undefined"
            class="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            :data-testid="testIds.wizardNext"
            @click="next"
          >
            Next
          </Button>
          <Button
            v-else
            type="button"
            :disabled="submitting"
            :aria-busy="submitting || undefined"
            :data-testid="testIds.wizardCreate"
            @click="submit"
          >
            <Spinner v-if="submitting" data-icon="inline-start" />
            {{ editing ? 'Save changes' : 'Create provider' }}
          </Button>
        </div>
      </footer>
    </template>

    <ConfirmDialog
      v-model:open="discardOpen"
      title="Discard this draft?"
      description="Everything you entered in the wizard is cleared."
      confirm-label="Discard"
      @confirm="discardDraft"
    />
    <ConfirmPasswordDialog
      v-model:open="passwordOpen"
      description="This provider starts a program on the server. Confirm your password to continue."
      :pending="passwordPending"
      :error="passwordError"
      @submit="confirmPassword"
    />
  </div>
</template>
