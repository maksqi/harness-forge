<script setup lang="ts">
// Trust dialog (docs/UI.md 8.4) for an installed plugin in the `untrusted` state (an update changed its hash, or its
// files changed on disk), opened from PluginCard "Review" and the detail header (W3.1). Shows TrustWarning for the
// plugin, the required "I trust {source}" checkbox and, when a password is set and the session is not fresh
// (ADR-017), the "Confirm your password" field; Trust logs in first when needed, then pins the current hash
// (`POST /api/plugins/:id/trust` with `{ sha256: trust.hash }`) and emits `trusted(id)`. A server that still asks for
// a fresh login gets ConfirmPasswordDialog and one retry; a stale hash (files changed meanwhile) reloads the plugin.
import type { PluginDetail } from '@harness-forge/shared'
import type { HarnessErrorUiAction } from '~/components/common/harness-error'
import { computed, ref, useId, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import ConfirmPasswordDialog from '~/components/common/ConfirmPasswordDialog.vue'
import HarnessErrorAlert from '~/components/common/HarnessErrorAlert.vue'
import { useAuthStore } from '~/stores/auth'
import { usePluginsStore } from '~/stores/plugins'
import { toHarnessError } from '~/utils/errors'
import { testIds } from '~/utils/testids'
import { isFreshAuthError, passwordErrorText, pluginSourceLabel } from './install'
import TrustConsent from './TrustConsent.vue'
import TrustWarning from './TrustWarning.vue'

// Attributes go to the dialog content, not to the renderless dialog root.
defineOptions({ inheritAttrs: false })

const props = defineProps<{ open: boolean, pluginId: string }>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  'trusted': [id: string]
}>()

const auth = useAuthStore()
const plugins = usePluginsStore()
const formId = useId()

const loading = ref(false)
const loadError = ref<unknown>(null)
const error = ref<unknown>(null)
const trusting = ref(false)
const checked = ref(false)
const password = ref('')
const passwordError = ref<string | null>(null)
const confirmOpen = ref(false)
const confirmPending = ref(false)
const confirmError = ref<string | null>(null)
// Bumped on every open and close, so a request that outlives its dialog session cannot touch the next one.
let session = 0

const detail = computed<PluginDetail | undefined>(() => plugins.details[props.pluginId])
const name = computed(() => detail.value?.name ?? props.pluginId)
const source = computed(() => (detail.value ? pluginSourceLabel(detail.value) : props.pluginId))
const busy = computed(() => trusting.value || confirmPending.value)
const needsTrust = computed(() => detail.value !== undefined && detail.value.trust.required && !detail.value.trust.trusted)
const needsPassword = computed(() => needsTrust.value && auth.status?.enabled === true && !auth.fresh)
const canTrust = computed(() => needsTrust.value && !busy.value && checked.value && detail.value?.trust.hash != null
  && !(needsPassword.value && password.value === ''))

async function load(current: number) {
  loading.value = true
  loadError.value = null
  try {
    await plugins.fetchOne(props.pluginId)
  }
  catch (failure) {
    if (current === session)
      loadError.value = toHarnessError(failure)
  }
  finally {
    if (current === session)
      loading.value = false
  }
}

watch(() => [props.open, props.pluginId] as const, ([open]) => {
  session += 1
  error.value = null
  trusting.value = false
  checked.value = false
  password.value = ''
  passwordError.value = null
  confirmOpen.value = false
  confirmPending.value = false
  confirmError.value = null
  loadError.value = null
  if (!open)
    return
  if (!auth.loaded)
    void auth.fetchStatus().catch(() => {})
  void load(session)
}, { immediate: true })

watch(password, () => {
  passwordError.value = null
})

function onOpenChange(value: boolean) {
  if (!value && trusting.value)
    return
  emit('update:open', value)
}

async function pin(current: number): Promise<void> {
  const plugin = detail.value
  const hash = plugin?.trust.hash
  if (!plugin || !hash)
    return
  const result = await plugins.trust(plugin.id, hash)
  if (current !== session)
    return
  toast.success(`Trusted ${result.name}`)
  emit('trusted', result.id)
  emit('update:open', false)
}

async function handleFailure(failure: unknown, current: number) {
  if (current !== session)
    return
  if (isFreshAuthError(failure)) {
    confirmError.value = null
    confirmOpen.value = true
    return
  }
  const harnessError = toHarnessError(failure)
  error.value = harnessError
  if (harnessError.code === 'conflict') {
    // The files changed since the dialog loaded them: show the new hash and ask again.
    checked.value = false
    await load(current)
  }
}

async function trust() {
  if (!canTrust.value)
    return
  const current = session
  error.value = null
  passwordError.value = null
  trusting.value = true
  try {
    if (needsPassword.value) {
      try {
        await auth.login(password.value)
      }
      catch (failure) {
        if (current === session)
          passwordError.value = passwordErrorText(failure)
        return
      }
    }
    await pin(current)
  }
  catch (failure) {
    await handleFailure(failure, current)
  }
  finally {
    if (current === session)
      trusting.value = false
  }
}

/** Fallback fresh-auth prompt: log in, then retry the trust request once. */
async function onConfirmPassword(value: string) {
  const current = session
  confirmPending.value = true
  confirmError.value = null
  try {
    await auth.login(value)
  }
  catch (failure) {
    if (current === session) {
      confirmError.value = passwordErrorText(failure)
      confirmPending.value = false
    }
    return
  }
  if (current !== session)
    return
  confirmPending.value = false
  confirmOpen.value = false
  trusting.value = true
  try {
    await pin(current)
  }
  catch (failure) {
    if (current === session)
      error.value = toHarnessError(failure)
  }
  finally {
    if (current === session)
      trusting.value = false
  }
}

function onErrorAction(action: HarnessErrorUiAction) {
  if (action === 'login') {
    confirmError.value = null
    confirmOpen.value = true
  }
  else if (action === 'retry') {
    void load(session)
  }
}
</script>

<template>
  <Dialog :open="open" @update:open="onOpenChange">
    <DialogContent
      :data-testid="testIds.trustDialog"
      :data-plugin-id="pluginId"
      class="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-lg"
      v-bind="$attrs"
    >
      <DialogHeader>
        <DialogTitle>Trust {{ name }}?</DialogTitle>
        <DialogDescription>
          It stays inactive until you trust it. Review what it can do first.
        </DialogDescription>
      </DialogHeader>

      <form :id="formId" class="-mx-1 grid min-h-0 gap-4 overflow-y-auto px-1" novalidate @submit.prevent="trust">
        <div v-if="loading && !detail" class="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner />
          Loading the plugin…
        </div>
        <HarnessErrorAlert v-else-if="loadError && !detail" :error="loadError" @action="onErrorAction" />
        <template v-else-if="detail">
          <p v-if="!detail.trust.required" class="text-sm text-muted-foreground">
            This plugin runs no code, so it needs no trust.
          </p>
          <p v-else-if="detail.trust.trusted" class="text-sm text-muted-foreground">
            This plugin is already trusted.
          </p>
          <template v-else>
            <TrustWarning :plugin="detail" />
            <TrustConsent
              v-model:checked="checked"
              v-model:password="password"
              :source="source"
              :needs-password="needsPassword"
              :password-error="passwordError"
              :disabled="busy"
            />
          </template>
        </template>
        <HarnessErrorAlert v-if="error" :error="error" @action="onErrorAction" />
      </form>

      <DialogFooter>
        <Button type="button" variant="outline" :disabled="trusting" @click="onOpenChange(false)">
          Cancel
        </Button>
        <Button
          type="submit"
          :form="formId"
          :disabled="!canTrust"
          :aria-busy="trusting || undefined"
          :data-testid="testIds.trustConfirm"
        >
          <Spinner v-if="trusting" data-icon="inline-start" />
          Trust
        </Button>
      </DialogFooter>
    </DialogContent>

    <ConfirmPasswordDialog
      v-model:open="confirmOpen"
      description="Confirm your password to trust a plugin that runs code on this server."
      :pending="confirmPending"
      :error="confirmError"
      @submit="onConfirmPassword"
    />
  </Dialog>
</template>
