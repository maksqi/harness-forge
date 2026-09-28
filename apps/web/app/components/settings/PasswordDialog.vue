<script setup lang="ts">
// Set, change or remove the login password (docs/UI.md 9.4): current (change/remove), new and confirm ->
// `PUT /api/auth/password`, a fresh-auth route (ADR-017). The "Current password" field doubles as the fresh-auth
// prompt: the auth store logs in with it first when the session is not fresh (docs/UI.md 8.4). TanStack Form + zod.
import type { PasswordDialogMode, PasswordFailure } from './password'
import { useForm } from '@tanstack/vue-form'
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
import { FieldError } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { useAuthStore } from '~/stores/auth'
import { testIds } from '~/utils/testids'
import {
  changePasswordWithFreshAuth,
  currentPasswordRule,
  newPasswordRule,
  PASSWORD_MIN,
  passwordFailure,
} from './password'

const props = defineProps<{ open: boolean, mode: PasswordDialogMode }>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  'done': [mode: PasswordDialogMode]
}>()

const auth = useAuthStore()
const failure = ref<PasswordFailure | null>(null)
const ids = { current: useId(), next: useId(), confirm: useId(), error: useId() }

const COPY: Record<PasswordDialogMode, { title: string, description: string, action: string, done: string }> = {
  set: {
    title: 'Set a password',
    description: `Anyone who opens harness-forge will need it. Use at least ${PASSWORD_MIN} characters.`,
    action: 'Set password',
    done: 'Password set',
  },
  change: {
    title: 'Change password',
    description: 'Other browsers are signed out and need the new password.',
    action: 'Change password',
    done: 'Password changed',
  },
  remove: {
    title: 'Remove password',
    description: 'harness-forge will open without a password. Enter your current password to confirm.',
    action: 'Remove password',
    done: 'Password removed',
  },
}

const copy = computed(() => COPY[props.mode])
const needsCurrent = computed(() => props.mode !== 'set')
const needsNext = computed(() => props.mode !== 'remove')

const form = useForm({
  defaultValues: { current: '', next: '', confirm: '' },
  // Every submit runs every validator, so all problems show at once.
  canSubmitWhenInvalid: true,
  onSubmit: async ({ value }) => {
    failure.value = null
    try {
      await changePasswordWithFreshAuth(auth, {
        current: needsCurrent.value ? value.current : undefined,
        next: needsNext.value ? value.next : null,
      })
      toast.success(copy.value.done)
      emit('done', props.mode)
      emit('update:open', false)
    }
    catch (error) {
      failure.value = passwordFailure(error)
    }
  },
})

/** Checked on every change of either field; shown once the field was left or a submit was tried. */
function confirmRule({ value }: { value: string }) {
  return value === form.state.values.next ? undefined : 'Passwords do not match.'
}

const submitting = form.useSelector(state => state.isSubmitting)
const attempted = form.useSelector(state => state.submissionAttempts > 0)
const currentValue = form.useSelector(state => state.values.current)

// A new attempt at the current password clears "Wrong password".
watch(currentValue, () => {
  if (failure.value?.field === 'current')
    failure.value = null
})
const currentFailure = computed(() => (failure.value?.field === 'current' && needsCurrent.value ? failure.value.message : null))
const formFailure = computed(() => (failure.value && !currentFailure.value ? failure.value.message : null))

watch(() => [props.open, props.mode] as const, () => {
  // Passwords never outlive the dialog.
  form.reset()
  failure.value = null
})

function onOpenChange(value: boolean) {
  if (!value && submitting.value)
    return
  emit('update:open', value)
}

/** Validation messages of a field once it was left or a submit was tried, plus a server message for it. */
function messages(meta: { errors: ReadonlyArray<unknown>, isBlurred: boolean }, extra?: string | null): string[] {
  const list = meta.isBlurred || attempted.value
    ? meta.errors
        .map(error => (typeof error === 'string' ? error : (error as { message?: unknown } | undefined)?.message))
        .filter((message): message is string => typeof message === 'string' && message !== '')
    : []
  return extra ? [...list, extra] : list
}
</script>

<template>
  <Dialog :open="open" @update:open="onOpenChange">
    <DialogContent :data-testid="testIds.passwordDialog" :data-mode="mode" class="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-sm">
      <form class="grid gap-5" novalidate @submit.prevent.stop="form.handleSubmit()">
        <DialogHeader>
          <DialogTitle>{{ copy.title }}</DialogTitle>
          <DialogDescription>{{ copy.description }}</DialogDescription>
        </DialogHeader>

        <form.Field v-if="needsCurrent" name="current" :validators="{ onChange: currentPasswordRule }">
          <template #default="{ field, state }">
            <div class="grid gap-2">
              <Label :for="ids.current">Current password</Label>
              <Input
                :id="ids.current"
                :model-value="state.value"
                type="password"
                autocomplete="current-password"
                :disabled="submitting"
                :aria-invalid="messages(state.meta, currentFailure).length > 0 || undefined"
                :data-testid="testIds.passwordCurrent"
                @update:model-value="value => field.handleChange(String(value))"
                @blur="field.handleBlur"
              />
              <FieldError :errors="messages(state.meta, currentFailure)" class="text-xs" />
            </div>
          </template>
        </form.Field>

        <form.Field v-if="needsNext" name="next" :validators="{ onChange: newPasswordRule }">
          <template #default="{ field, state }">
            <div class="grid gap-2">
              <Label :for="ids.next">New password</Label>
              <Input
                :id="ids.next"
                :model-value="state.value"
                type="password"
                autocomplete="new-password"
                :disabled="submitting"
                :aria-invalid="messages(state.meta).length > 0 || undefined"
                :data-testid="testIds.passwordNew"
                @update:model-value="value => field.handleChange(String(value))"
                @blur="field.handleBlur"
              />
              <FieldError :errors="messages(state.meta)" class="text-xs" />
            </div>
          </template>
        </form.Field>

        <form.Field v-if="needsNext" name="confirm" :validators="{ onChange: confirmRule, onChangeListenTo: ['next'] }">
          <template #default="{ field, state }">
            <div class="grid gap-2">
              <Label :for="ids.confirm">Confirm new password</Label>
              <Input
                :id="ids.confirm"
                :model-value="state.value"
                type="password"
                autocomplete="new-password"
                :disabled="submitting"
                :aria-invalid="messages(state.meta).length > 0 || undefined"
                :data-testid="testIds.passwordConfirm"
                @update:model-value="value => field.handleChange(String(value))"
                @blur="field.handleBlur"
              />
              <FieldError :errors="messages(state.meta)" class="text-xs" />
            </div>
          </template>
        </form.Field>

        <p v-if="formFailure" :id="ids.error" role="alert" class="text-sm text-destructive">
          {{ formFailure }}
        </p>

        <DialogFooter>
          <Button type="button" variant="outline" :disabled="submitting" @click="onOpenChange(false)">
            Cancel
          </Button>
          <Button
            type="submit"
            :variant="mode === 'remove' ? 'destructive' : 'default'"
            :disabled="submitting"
            :aria-busy="submitting || undefined"
            :data-testid="testIds.passwordSave"
          >
            <Spinner v-if="submitting" data-icon="inline-start" />
            {{ copy.action }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
