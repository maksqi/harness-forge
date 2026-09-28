<script setup lang="ts">
// Provider key dialog (docs/UI.md 2.5, 9.2): one input per credential field (main fields, then "Advanced"), Test
// (`POST /providers/:id/test` with the draft, nothing stored) and Save (`PUT /providers/:id/credentials`), which runs
// Test first and offers "Save anyway" when it fails. Stored secrets are never loaded: inputs start empty with the
// masked hint as placeholder, and the draft is wiped whenever the dialog closes. Opened by the providers page and by
// `/settings/providers?configure=<providerId>`.
import type { HarnessErrorInit } from '@harness-forge/shared'
import { ChevronRightIcon, CircleAlertIcon, CircleCheckIcon } from '@lucide/vue'
import { computed, reactive, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import ConfirmDialog from '~/components/common/ConfirmDialog.vue'
import { errorTitle } from '~/components/common/harness-error'
import ProviderIcon from '~/components/providers/ProviderIcon.vue'
import { useProvidersStore } from '~/stores/providers'
import { toHarnessError } from '~/utils/errors'
import { testIds } from '~/utils/testids'
import CredentialFieldInput from './CredentialFieldInput.vue'
import {
  changedValues,
  credentialFieldViews,
  draftErrors,
  fieldLinks,
  hasStoredSecret,
  isOverridden,
  splitFieldViews,
  testSuccessText,
  valuesSignature,
} from './key-dialog'
import { toastError } from './notify'

// Attributes go to the dialog content, not to the renderless dialog root.
defineOptions({ inheritAttrs: false })

const props = defineProps<{ open: boolean, providerId: string }>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  'saved': [providerId: string]
}>()

type Phase = 'idle' | 'testing' | 'saving' | 'removing'
type Outcome
  = | { kind: 'ok', text: string, signature: string }
    | { kind: 'test-error', error: HarnessErrorInit, signature: string }
    | { kind: 'save-error', error: HarnessErrorInit }

const providers = useProvidersStore()

const provider = computed(() => providers.byId(props.providerId))
const providerName = computed(() => provider.value?.name ?? props.providerId)
const views = computed(() => (provider.value ? credentialFieldViews(provider.value) : []))
const sections = computed(() => splitFieldViews(views.value))
const links = computed(() => (provider.value ? fieldLinks(provider.value) : {}))
const hasMainSecret = computed(() => sections.value.main.some(view => view.secret))

const draft = reactive<Record<string, string>>({})
/** Starting value of every field, captured when the dialog opened (see `changedValues`). */
const baseline = reactive<Record<string, string>>({})
const phase = ref<Phase>('idle')
const outcome = ref<Outcome | null>(null)
const advancedOpen = ref(false)
const confirmRemove = ref(false)
// Bumped on every open and close, so a request that outlives its dialog session cannot touch the next one.
let session = 0

const values = computed(() => changedValues(views.value, draft, baseline))
const signature = computed(() => valuesSignature(values.value))
const dirty = computed(() => Object.keys(values.value).length > 0)
const errors = computed(() => draftErrors(views.value, draft))
const valid = computed(() => Object.keys(errors.value).length === 0)
const busy = computed(() => phase.value !== 'idle')
const canRemove = computed(() => hasStoredSecret(views.value))
const canTest = computed(() => !!provider.value && valid.value && !busy.value
  && (dirty.value || provider.value.status !== 'not_configured' || views.value.length === 0))
const canSave = computed(() => !!provider.value && valid.value && !busy.value && dirty.value)
const offerSaveAnyway = computed(() => outcome.value?.kind === 'test-error' && dirty.value
  && outcome.value.signature === signature.value && !busy.value)

/** Adds fields that have no draft yet (all of them after a reset) with their starting value. */
function fillDraft() {
  for (const view of views.value) {
    if (!(view.key in draft)) {
      draft[view.key] = view.initial
      baseline[view.key] = view.initial
    }
  }
}

function resetDraft() {
  for (const key of Object.keys(draft))
    delete draft[key]
  for (const key of Object.keys(baseline))
    delete baseline[key]
  fillDraft()
}

// The provider may arrive (or gain fields) after the dialog opened.
watch(views, fillDraft)

function startSession() {
  session += 1
  resetDraft()
  phase.value = 'idle'
  outcome.value = null
  confirmRemove.value = false
  advancedOpen.value = sections.value.main.length === 0
    || sections.value.advanced.some(view => isOverridden(view) || view.source === 'stored')
}

watch(() => [props.open, props.providerId] as const, ([open]) => {
  if (open) {
    startSession()
  }
  else {
    // Typed secrets never outlive the dialog.
    session += 1
    resetDraft()
    outcome.value = null
    phase.value = 'idle'
  }
}, { immediate: true })

function close() {
  emit('update:open', false)
}

function onOpenChange(value: boolean) {
  // A save or removal in flight finishes first.
  if (!value && (phase.value === 'saving' || phase.value === 'removing'))
    return
  emit('update:open', value)
}

function errorInit(error: unknown): HarnessErrorInit {
  const { code, message, status, providerId, retryAfterMs, action, details } = toHarnessError(error)
  return { code, message, status, providerId, retryAfterMs, action, details }
}

/** Runs the connection test with the draft (or the stored values when nothing changed). True when it passed. */
async function runTest(): Promise<boolean> {
  const current = session
  const id = props.providerId
  const tested = signature.value
  const draftValues = dirty.value ? { ...values.value } : undefined
  phase.value = 'testing'
  outcome.value = null
  try {
    const result = await providers.test(id, draftValues)
    // A test of the stored values is persisted (status, lastError): reload the rows even without the event stream.
    if (!draftValues)
      providers.fetchAll().catch(() => {})
    if (current !== session)
      return false
    if (result.ok) {
      outcome.value = { kind: 'ok', text: testSuccessText(result), signature: tested }
      return true
    }
    outcome.value = {
      kind: 'test-error',
      error: result.error ?? { code: 'provider_error', message: 'The connection test failed.' },
      signature: tested,
    }
    return false
  }
  catch (error) {
    if (current === session)
      outcome.value = { kind: 'test-error', error: errorInit(error), signature: tested }
    return false
  }
  finally {
    if (current === session)
      phase.value = 'idle'
  }
}

async function persist(tested: boolean) {
  const current = session
  const id = props.providerId
  const name = providerName.value
  phase.value = 'saving'
  try {
    await providers.saveCredentials(id, { ...values.value })
    if (current !== session)
      return
    phase.value = 'idle'
    toast.success(tested ? `${name} connected` : `${name} saved`)
    emit('saved', id)
    close()
  }
  catch (error) {
    if (current === session)
      outcome.value = { kind: 'save-error', error: errorInit(error) }
  }
  finally {
    if (current === session)
      phase.value = 'idle'
  }
}

async function onTest() {
  if (canTest.value)
    await runTest()
}

/** Save runs Test first (unless these exact values just passed); a failed test offers "Save anyway". */
async function onSave() {
  if (!canSave.value)
    return
  const passed = outcome.value?.kind === 'ok' && outcome.value.signature === signature.value
  if (!passed && !(await runTest()))
    return
  await persist(true)
}

async function onSaveAnyway() {
  if (offerSaveAnyway.value)
    await persist(false)
}

/** Enter in a field: Save when something changed, else Test. */
function onSubmit() {
  if (dirty.value)
    void onSave()
  else
    void onTest()
}

async function onRemove() {
  const current = session
  const id = props.providerId
  const name = providerName.value
  phase.value = 'removing'
  try {
    await providers.clearCredentials(id)
    if (current !== session)
      return
    confirmRemove.value = false
    toast.success(`${name} key removed`)
    startSession()
  }
  catch (error) {
    if (current === session)
      confirmRemove.value = false
    toastError(error, name)
  }
  finally {
    if (current === session)
      phase.value = 'idle'
  }
}

const formElement = ref<HTMLFormElement | null>(null)

/** Focus the first field (e.g. the API key) instead of the "Get a key" link next to its label. */
function onOpenAutoFocus(event: Event) {
  const field = formElement.value?.querySelector<HTMLElement>('input:not([disabled]), button[role="combobox"]:not([disabled])')
  if (!field)
    return
  event.preventDefault()
  field.focus()
}

const outcomeTitle = computed(() => (outcome.value && outcome.value.kind !== 'ok'
  ? errorTitle(outcome.value.error, providerName.value)
  : ''))
</script>

<template>
  <Dialog :open="open" @update:open="onOpenChange">
    <DialogContent
      :data-testid="testIds.keyDialog"
      :data-provider-id="providerId"
      class="gap-5 sm:max-w-lg"
      v-bind="$attrs"
      @open-auto-focus="onOpenAutoFocus"
    >
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2.5 text-base">
          <ProviderIcon
            :id="providerId"
            :icon="provider?.icon"
            :name="providerName"
            size="md"
            variant="color"
          />
          <span class="min-w-0 truncate">{{ providerName }}</span>
        </DialogTitle>
        <DialogDescription>
          <template v-if="!provider">
            This provider is not available. It may have been removed.
          </template>
          <template v-else-if="views.length === 0">
            This provider needs no configuration.
          </template>
          <template v-else-if="hasMainSecret">
            Keys are encrypted on this server and never shown again.
          </template>
          <template v-else-if="provider.local">
            No key needed. Change the address if the server runs elsewhere.
          </template>
          <template v-else>
            Choose where harness-forge reaches this provider.
          </template>
        </DialogDescription>
      </DialogHeader>

      <form v-if="provider" ref="formElement" class="grid gap-5" novalidate @submit.prevent="onSubmit">
        <CredentialFieldInput
          v-for="view in sections.main"
          :key="view.key"
          :model-value="draft[view.key] ?? ''"
          :view="view"
          :link="links[view.key]"
          :error="errors[view.key]"
          :disabled="phase === 'saving' || phase === 'removing'"
          @update:model-value="value => (draft[view.key] = value)"
        />

        <Collapsible v-if="sections.advanced.length" v-model:open="advancedOpen" class="grid gap-4">
          <CollapsibleTrigger
            :data-testid="testIds.keyAdvanced"
            class="group/advanced -ml-1 inline-flex w-fit items-center gap-1 rounded-sm px-1 text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <ChevronRightIcon
              aria-hidden="true"
              class="size-4 transition-transform duration-(--duration-fast) group-data-[state=open]/advanced:rotate-90"
            />
            Advanced
          </CollapsibleTrigger>
          <CollapsibleContent class="grid gap-5">
            <CredentialFieldInput
              v-for="view in sections.advanced"
              :key="view.key"
              :model-value="draft[view.key] ?? ''"
              :view="view"
              :link="links[view.key]"
              :error="errors[view.key]"
              :disabled="phase === 'saving' || phase === 'removing'"
              @update:model-value="value => (draft[view.key] = value)"
            />
          </CollapsibleContent>
        </Collapsible>

        <div aria-live="polite" class="empty:hidden">
          <p v-if="phase === 'testing'" class="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner class="size-3.5" />
            Testing the connection…
          </p>
          <div
            v-else-if="outcome"
            :data-testid="testIds.keyTestResult"
            :data-status="outcome.kind === 'ok' ? 'ok' : 'error'"
            :class="outcome.kind === 'ok'
              ? 'flex items-center gap-2 text-sm'
              : 'flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm dark:bg-destructive/10'"
          >
            <template v-if="outcome.kind === 'ok'">
              <CircleCheckIcon aria-hidden="true" class="size-4 shrink-0 text-success" />
              <span class="tabular-nums">{{ outcome.text }}</span>
            </template>
            <template v-else>
              <CircleAlertIcon aria-hidden="true" class="mt-0.5 size-4 shrink-0 text-destructive" />
              <div class="min-w-0 flex-1 space-y-0.5">
                <p class="font-medium">
                  {{ outcomeTitle }}
                </p>
                <p class="break-words text-muted-foreground">
                  {{ outcome.error.message }}
                </p>
                <button
                  v-if="offerSaveAnyway"
                  type="button"
                  :data-testid="testIds.keySaveAnyway"
                  class="mt-1 rounded-sm text-sm font-medium text-foreground underline decoration-primary/60 underline-offset-4 outline-none hover:decoration-primary focus-visible:ring-2 focus-visible:ring-ring/50"
                  @click="onSaveAnyway"
                >
                  Save anyway
                </button>
              </div>
            </template>
          </div>
        </div>

        <DialogFooter class="items-stretch sm:items-center">
          <Button
            v-if="canRemove"
            type="button"
            variant="ghost"
            :disabled="busy"
            :data-testid="testIds.keyRemove"
            class="text-destructive hover:bg-destructive/10 hover:text-destructive sm:mr-auto dark:hover:bg-destructive/15"
            @click="confirmRemove = true"
          >
            Remove key
          </Button>
          <Button
            type="button"
            variant="outline"
            :disabled="!canTest"
            :aria-busy="phase === 'testing' || undefined"
            :data-testid="testIds.keyTest"
            @click="onTest"
          >
            <Spinner v-if="phase === 'testing'" data-icon="inline-start" />
            Test
          </Button>
          <Button
            type="submit"
            :disabled="!canSave"
            :aria-busy="phase === 'saving' || undefined"
            :data-testid="testIds.keySave"
          >
            <Spinner v-if="phase === 'saving'" data-icon="inline-start" />
            Save
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>

  <ConfirmDialog
    v-model:open="confirmRemove"
    :title="`Remove the ${providerName} key?`"
    description="The saved key is deleted from this server. A key from the server environment keeps working."
    confirm-label="Remove"
    :pending="phase === 'removing'"
    @confirm="onRemove"
  />
</template>
