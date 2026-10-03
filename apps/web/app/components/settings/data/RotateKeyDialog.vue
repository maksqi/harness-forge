<script setup lang="ts">
// "Rotate the master key?" (docs/UI.md 9.8, 8.4; docs/API.md 5.23; ADR-034): the effects list (counts from status),
// "Type ROTATE to confirm" (key-rotate-confirm, case-sensitive, focused on open) and Rotate key (key-rotate-submit,
// destructive, enabled only for exactly ROTATE), which sends `POST /api/keys/rotate` through
// useFreshAuth().run(…, { required: true }): with a password set and a session that is not fresh, ConfirmPasswordDialog
// asks first; a `403` + `action: 'login'` answer asks and retries once. While the request or the prompt is pending the
// dialog stays open. Success -> toast "Master key rotated" with the counts, rotated(result), the dialog closes. 409
// `env-key` / `key-mismatch` (and any other failure) -> the server message inside the dialog; 409 `busy` -> the busy
// toast. Every opening starts over.
// Contract (docs/UI.md 10.4): props / emits below; root key-rotate-dialog (the dialog content).
import type { KeyRotationResult, KeyStatus } from '@harness-forge/shared'
import { ArchiveIcon, CircleAlertIcon, CircleStopIcon, Link2Icon, LogOutIcon } from '@lucide/vue'
import { computed, ref, useId, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import ConfirmPasswordDialog from '~/components/common/ConfirmPasswordDialog.vue'
import { useApi } from '~/composables/useApi'
import { isFreshAuthCancelled, useFreshAuth } from '~/composables/useFreshAuth'
import { toHarnessError, withHarnessErrors } from '~/utils/errors'
import { testIds } from '~/utils/testids'
import {
  BUSY_MESSAGE,
  conflictReason,
  KEY_ROTATED_TITLE,
  keyRotatedDescription,
  ROTATE_CONFIRMATION,
  rotateEffects,
} from './data'

// Attributes go to the dialog content, not to the renderless dialog root.
defineOptions({ inheritAttrs: false })

const props = defineProps<{
  open: boolean
  /** The counts of the effects list; null while unknown. */
  status: KeyStatus | null
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  'rotated': [result: KeyRotationResult]
}>()

interface RotateFailure {
  message: string
  code: string
  reason: string | null
}

const EFFECT_ICONS = [LogOutIcon, Link2Icon, CircleStopIcon, ArchiveIcon] as const

const api = useApi()
const freshAuth = useFreshAuth()
const ids = { confirm: useId(), submit: useId(), error: useId() }

const typed = ref('')
const rotating = ref(false)
const failure = ref<RotateFailure | null>(null)
// Bumped on every open and close, so an answer that outlives its dialog session cannot touch the next one.
let session = 0

const confirmed = computed(() => typed.value === ROTATE_CONFIRMATION)
/** The request runs or waits for the password: nothing can change and the dialog stays open. */
const pending = computed(() => rotating.value || freshAuth.open.value)
const effects = computed(() => rotateEffects(props.status).map((text, index) => ({ text, icon: EFFECT_ICONS[index]! })))

watch(() => props.open, () => {
  session += 1
  typed.value = ''
  failure.value = null
  // A waiting password prompt belongs to the dialog session that ends here.
  freshAuth.cancel()
})

watch(typed, () => {
  failure.value = null
})

function onOpenChange(value: boolean): void {
  if (!value && pending.value)
    return
  emit('update:open', value)
}

function onOpenAutoFocus(event: Event): void {
  const input = document.getElementById(ids.confirm)
  if (!input)
    return
  event.preventDefault()
  input.focus()
}

function onPasswordCloseAutoFocus(event: Event): void {
  // The prompt has no trigger to return to: focus goes back into this dialog while it is open.
  if (!props.open)
    return
  event.preventDefault()
  document.getElementById(ids.submit)?.focus()
}

/** `POST /keys/rotate`; `rotating` covers the request only, not the password prompt. */
async function rotate(): Promise<KeyRotationResult> {
  rotating.value = true
  try {
    return await withHarnessErrors(api.keys.rotate({ body: { confirm: ROTATE_CONFIRMATION } }))
  }
  finally {
    rotating.value = false
  }
}

function failureOf(error: unknown): RotateFailure {
  const harnessError = toHarnessError(error)
  return {
    message: harnessError.message,
    code: harnessError.code,
    reason: conflictReason(harnessError),
  }
}

async function onSubmit(): Promise<void> {
  if (!confirmed.value || pending.value)
    return
  const current = session
  failure.value = null
  let result: KeyRotationResult
  try {
    result = await freshAuth.run(rotate, { required: true })
  }
  catch (error) {
    if (current !== session || isFreshAuthCancelled(error))
      return
    if (conflictReason(error) === 'busy')
      toast.error(BUSY_MESSAGE)
    else
      failure.value = failureOf(error)
    return
  }
  // The key changed on the server even when the dialog was closed meanwhile: always report it.
  toast.success(KEY_ROTATED_TITLE, { description: keyRotatedDescription(result) })
  emit('rotated', result)
  if (current === session)
    emit('update:open', false)
}
</script>

<template>
  <Dialog :open="open" @update:open="onOpenChange">
    <DialogContent
      v-bind="$attrs"
      :data-testid="testIds.keyRotateDialog"
      class="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md"
      @open-auto-focus="onOpenAutoFocus"
    >
      <form class="grid gap-5" novalidate @submit.prevent="onSubmit">
        <DialogHeader>
          <DialogTitle>Rotate the master key?</DialogTitle>
          <DialogDescription>A new key encrypts every saved secret again.</DialogDescription>
        </DialogHeader>

        <ul class="grid gap-2.5 text-sm" aria-label="What a rotation changes" data-slot="key-rotate-effects">
          <li v-for="effect in effects" :key="effect.text" class="flex items-start gap-2.5">
            <component :is="effect.icon" aria-hidden="true" class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span class="min-w-0 tabular-nums">{{ effect.text }}</span>
          </li>
        </ul>

        <Alert
          v-if="failure"
          :id="ids.error"
          variant="destructive"
          role="alert"
          data-slot="key-rotate-error"
          :data-code="failure.code"
          :data-reason="failure.reason ?? undefined"
          class="border-destructive/35 bg-destructive/5 dark:bg-destructive/10 *:data-[slot=alert-description]:text-foreground/80"
        >
          <CircleAlertIcon aria-hidden="true" />
          <AlertTitle>Couldn't rotate the key</AlertTitle>
          <AlertDescription>{{ failure.message }}</AlertDescription>
        </Alert>

        <div class="grid gap-2">
          <Label :for="ids.confirm">
            Type ROTATE to confirm
          </Label>
          <Input
            :id="ids.confirm"
            v-model="typed"
            autocomplete="off"
            autocapitalize="characters"
            spellcheck="false"
            autofocus
            class="font-mono"
            :disabled="pending"
            :aria-describedby="failure ? ids.error : undefined"
            :data-testid="testIds.keyRotateConfirm"
          />
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" :disabled="pending" @click="onOpenChange(false)">
            Cancel
          </Button>
          <Button
            :id="ids.submit"
            type="submit"
            variant="destructive"
            :disabled="!confirmed || pending"
            :aria-busy="pending || undefined"
            :data-testid="testIds.keyRotateSubmit"
          >
            <Spinner v-if="rotating || freshAuth.pending.value" data-icon="inline-start" />
            Rotate key
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>

  <ConfirmPasswordDialog
    :open="freshAuth.open.value"
    description="Rotating the master key needs your password."
    :pending="freshAuth.pending.value"
    :error="freshAuth.error.value"
    @update:open="freshAuth.setOpen"
    @submit="freshAuth.submit"
    @close-auto-focus="onPasswordCloseAutoFocus"
  />
</template>
