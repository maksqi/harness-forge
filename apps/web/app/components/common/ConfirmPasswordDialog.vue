<script setup lang="ts">
// Fresh-auth prompt (docs/API.md "fresh", docs/UI.md 8.4). Presentational: emits the password; the caller runs
// auth.login(password), passes `pending` and `error` ("Wrong password", rate-limit text), closes the dialog on
// success and retries its request once. The password is cleared whenever the dialog closes.
import { ref, useId, watch } from 'vue'
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
import { testIds } from '~/utils/testids'

// Attributes go to the dialog content, not to the renderless dialog root.
defineOptions({ inheritAttrs: false })

const props = withDefaults(defineProps<{
  open: boolean
  description?: string
  pending?: boolean
  error?: string | null
}>(), {
  description: 'Confirm your password to continue.',
  pending: false,
  error: null,
})

const emit = defineEmits<{
  'update:open': [value: boolean]
  'submit': [password: string]
}>()

const password = ref('')
const inputId = useId()
const errorId = useId()

watch(() => props.open, (open) => {
  if (!open)
    password.value = ''
})

function onOpenChange(value: boolean) {
  if (!value && props.pending)
    return
  emit('update:open', value)
}

function onSubmit() {
  if (!password.value || props.pending)
    return
  emit('submit', password.value)
}
</script>

<template>
  <Dialog :open="open" @update:open="onOpenChange">
    <DialogContent :data-testid="testIds.confirmPasswordDialog" class="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-sm" v-bind="$attrs">
      <form class="grid gap-5" @submit.prevent="onSubmit">
        <DialogHeader>
          <DialogTitle>Confirm your password</DialogTitle>
          <DialogDescription>{{ description }}</DialogDescription>
        </DialogHeader>
        <div class="grid gap-2">
          <Label :for="inputId">
            Password
          </Label>
          <Input
            :id="inputId"
            v-model="password"
            type="password"
            autocomplete="current-password"
            autofocus
            :disabled="pending"
            :aria-invalid="error ? true : undefined"
            :aria-describedby="error ? errorId : undefined"
            :data-testid="testIds.confirmPasswordInput"
          />
          <p v-if="error" :id="errorId" role="alert" class="text-sm text-destructive">
            {{ error }}
          </p>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" :disabled="pending" @click="onOpenChange(false)">
            Cancel
          </Button>
          <Button
            type="submit"
            :disabled="!password || pending"
            :aria-busy="pending || undefined"
            :data-testid="testIds.confirmPasswordSubmit"
          >
            <Spinner v-if="pending" data-icon="inline-start" />
            Confirm
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
