<script setup lang="ts">
// The review steps of an install (docs/UI.md 8.3 steps 2-4, 8.4, 8.13, 10.9), extracted from InstallDialog in Phase 12
// (C46) so the install dialog and MarketplaceInstallDialog share one fresh-auth flow:
// 2. Preview (InspectPreview) of the `PluginInspection`.
// 3. Trust, for plugins that run anything: TrustWarning + the required "I trust {source}" checkbox and, when a password
//    is set and the session is not fresh (ADR-017), the "Confirm your password" field.
// 4. Install: logs in first when the password field is shown (useFreshAuth `login()`), then `POST /api/plugins/install`
//    with the request's source, `trust` and the reviewed `sha256`, through `run(send, { required })`: if the server still
//    asks for a fresh login (403 + action `login`), ConfirmPasswordDialog asks for the password and the install runs once
//    more; the "Log in" action of the error alert opens the same prompt (`confirm()`) and submits again.
// When the package changed since the preview (409 `conflict`, reason `stale`) the error shows and `stale` is emitted: the
// parent inspects again and passes the new inspection, which the review shows with the notice "This plugin changed since
// you reviewed it" and a fresh consent. Success emits `installed(detail)` (the parent shows the toast and closes).
// Root: `data-slot="install-review"` (`display: contents`: its form and footer are the dialog's body and footer rows); the
// test ids of the preview, trust and install steps are unchanged. Exposes `installing` (the parent keeps its dialog open
// meanwhile). Props, emits and the root slot are frozen from Gate P12-0b (C46); W12.9 owns the component in P12-A.
// W12.9 (docs/UI.md 14.1): Install is never the default button (Enter on the review, in a field or on the focused button
// does nothing; Space or a click installs); when the review opens, focus moves to the trust checkbox (when shown), else
// to Install (else Back), so the dialogs land on the decision.
// W12.17: the one exception is the inline password field (TrustConsent `confirm`): Enter there confirms the password and
// goes on with the install, exactly like clicking Install (the login, then the install; nothing while Install is
// disabled). A wrong password puts the focus back in the field, so Enter there retries. The password prompt
// (ConfirmPasswordDialog, after the server asked for a fresh login) confirms on Enter too and continues the install the
// user clicked.
import type { PluginDetail, PluginInspection } from '@harness-forge/shared'
import type { InstallRequest } from './install'
import type { HarnessErrorUiAction } from '~/components/common/harness-error'
import { RefreshCwIcon } from '@lucide/vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from 'vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { DialogFooter } from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import ConfirmPasswordDialog from '~/components/common/ConfirmPasswordDialog.vue'
import HarnessErrorAlert from '~/components/common/HarnessErrorAlert.vue'
import { useApi } from '~/composables/useApi'
import { isFreshAuthCancelled, useFreshAuth } from '~/composables/useFreshAuth'
import { useAuthStore } from '~/stores/auth'
import { toHarnessError, withHarnessErrors } from '~/utils/errors'
import { testIds } from '~/utils/testids'
import InspectPreview from './InspectPreview.vue'
import { installBody, isStaleReview, zipForm } from './install'
import TrustConsent from './TrustConsent.vue'
import TrustWarning from './TrustWarning.vue'

const props = defineProps<{ inspection: PluginInspection, request: InstallRequest, sourceLabel: string }>()

const emit = defineEmits<{ back: [], installed: [plugin: PluginDetail], stale: [] }>()

const api = useApi()
const auth = useAuthStore()
const freshAuth = useFreshAuth()

const formElement = useTemplateRef<HTMLFormElement>('form')
const rootElement = useTemplateRef<HTMLElement>('root')

const phase = ref<'idle' | 'installing'>('idle')
const error = ref<unknown>(null)
const trustChecked = ref(false)
const password = ref('')
const passwordError = ref<string | null>(null)
/** The package changed since the user reviewed it: the preview shows the new inspection. */
const staleReview = ref(false)
/** A `stale` was emitted: the next inspection from the parent is the refreshed one. */
let awaitingFresh = false
// Bumped when the review ends, so a request that outlives it cannot touch anything.
let session = 0

const busy = computed(() => phase.value !== 'idle' || freshAuth.pending.value)
const requiresTrust = computed(() => props.inspection.requiresTrust)
const needsPassword = computed(() => requiresTrust.value && auth.status?.enabled === true && !auth.fresh)
const sourceConflict = computed(() => props.inspection.existing !== null && props.inspection.existing.source !== props.inspection.source)
const canInstall = computed(() => {
  const current = props.inspection
  if (busy.value || !current.compatible || sourceConflict.value)
    return false
  if (current.requiresTrust && !trustChecked.value)
    return false
  return !(needsPassword.value && password.value === '')
})

watch(password, () => {
  passwordError.value = null
})

watch(() => props.inspection, async () => {
  trustChecked.value = false
  password.value = ''
  passwordError.value = null
  if (!awaitingFresh)
    return
  awaitingFresh = false
  error.value = null
  staleReview.value = true
  // The notice sits above the preview; the user was looking at the Install button at the bottom.
  await nextTick()
  formElement.value?.scrollTo?.({ top: 0 })
})

onBeforeUnmount(() => {
  session += 1
})

/** The decision of the review: the trust checkbox when shown, else Install, else Back (an incompatible plugin). */
function focusDecision(): void {
  const root = rootElement.value
  if (!root)
    return
  const candidates = [testIds.trustCheckbox, testIds.installSubmit, testIds.installBack]
    .map(id => root.querySelector<HTMLElement>(`[data-testid="${id}"]`))
  // Without scrolling: the preview's top stays in view.
  candidates.find(element => element && !(element as HTMLButtonElement).disabled)?.focus({ preventScroll: true })
}

onMounted(() => {
  void nextTick(focusDecision)
})

/** The inline password field gets the focus back (its text selected) after a failed login. */
function focusPassword(): void {
  const field = rootElement.value?.querySelector<HTMLInputElement>(`[data-testid="${testIds.trustPassword}"]`)
  if (!field || field.disabled)
    return
  field.focus()
  field.select()
}

/** Enter in the inline password field (W12.17): the same as clicking Install (`install` checks `canInstall`). */
function confirmPassword(): void {
  void install()
}

function showError(failure: unknown): void {
  error.value = toHarnessError(failure)
}

/** Installs exactly what the preview showed: the server refuses with `409 conflict` (`stale`) when it changed. */
function sendInstall(): Promise<PluginDetail> {
  const options = { trust: requiresTrust.value && trustChecked.value, sha256: props.inspection.sha256 }
  const request = props.request
  if (request.kind === 'zip')
    return withHarnessErrors(api.pluginInstall.install({ form: zipForm(request.file, options) }))
  return withHarnessErrors(api.pluginInstall.install({ body: installBody(request.source, options) }))
}

async function install(): Promise<void> {
  if (!canInstall.value)
    return
  const current = session
  error.value = null
  passwordError.value = null
  staleReview.value = false
  awaitingFresh = false
  phase.value = 'installing'
  try {
    if (needsPassword.value) {
      const failed = await freshAuth.login(password.value)
      if (failed !== null) {
        if (current === session) {
          passwordError.value = failed
          // After the field is enabled again (`finally`): the user fixes the password and presses Enter.
          void nextTick(focusPassword)
        }
        return
      }
    }
    const detail = await freshAuth.run(sendInstall, { required: requiresTrust.value })
    if (current === session)
      emit('installed', detail)
  }
  catch (failure) {
    if (current !== session || isFreshAuthCancelled(failure))
      return
    showError(failure)
    if (isStaleReview(failure)) {
      // The parent inspects again; the error stays when that fails too.
      awaitingFresh = true
      emit('stale')
    }
  }
  finally {
    if (current === session)
      phase.value = 'idle'
  }
}

function back(): void {
  if (busy.value)
    return
  emit('back')
}

/** "Log in" of the error alert: the password prompt now, then the install runs again. */
async function logIn(): Promise<void> {
  const current = session
  try {
    await freshAuth.confirm()
  }
  catch {
    // Closed: nothing else happens.
    return
  }
  if (current === session)
    void install()
}

function onErrorAction(action: HarnessErrorUiAction): void {
  if (action === 'login')
    void logIn()
  else if (action === 'retry')
    void install()
}

defineExpose({ installing: computed(() => phase.value === 'installing') })
</script>

<template>
  <div ref="root" data-slot="install-review" class="contents">
    <!-- Install is never the default button: submitting the form (Enter in a field) does nothing; Enter in the password
         field goes on through TrustConsent's `confirm`. -->
    <form ref="form" class="-mx-1 grid min-h-0 gap-4 overflow-y-auto px-1" novalidate @submit.prevent>
      <Alert
        v-if="staleReview"
        :data-testid="testIds.installStale"
        class="border-warning/40 bg-warning/5 *:data-[slot=alert-description]:text-foreground/80 dark:bg-warning/10 *:[svg]:text-warning"
      >
        <RefreshCwIcon aria-hidden="true" />
        <AlertTitle>This plugin changed since you reviewed it</AlertTitle>
        <AlertDescription>
          The preview now shows the current version. Review it again before you install.
        </AlertDescription>
      </Alert>
      <InspectPreview :inspection="inspection" :source-label="sourceLabel" />
      <template v-if="inspection.requiresTrust">
        <TrustWarning :inspection="inspection" />
        <TrustConsent
          v-model:checked="trustChecked"
          v-model:password="password"
          :source="sourceLabel"
          :needs-password="needsPassword"
          :password-error="passwordError"
          :disabled="busy"
          @confirm="confirmPassword"
        />
      </template>

      <HarnessErrorAlert
        v-if="error"
        :error="error"
        :data-testid="testIds.installError"
        @action="onErrorAction"
      />
    </form>

    <DialogFooter>
      <Button type="button" variant="outline" :disabled="busy" :data-testid="testIds.installBack" @click="back">
        Back
      </Button>
      <Button
        type="button"
        :disabled="!canInstall"
        :aria-busy="phase === 'installing' || undefined"
        :data-testid="testIds.installSubmit"
        @keydown.enter.prevent
        @click="install"
      >
        <Spinner v-if="phase === 'installing'" data-icon="inline-start" />
        Install
      </Button>
    </DialogFooter>

    <ConfirmPasswordDialog
      :open="freshAuth.open.value"
      description="Confirm your password to install a plugin that runs code on this server."
      :pending="freshAuth.pending.value"
      :error="freshAuth.error.value"
      @update:open="freshAuth.setOpen"
      @submit="freshAuth.submit"
    />
  </div>
</template>
