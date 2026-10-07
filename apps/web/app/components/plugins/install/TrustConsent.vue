<script setup lang="ts">
// The consent block of the install and trust dialogs (docs/UI.md 8.3 step 3, 8.4): the required "I trust {source}"
// checkbox and, when a password is set and the session is not fresh (ADR-017), the "Confirm your password" field.
// W12.17: Enter in the password field (not while an IME composes) emits `confirm`: the install review confirms the
// password and goes on with the install (its form never submits, so Install is never the default button); the trust
// dialog does not listen (its form submits Trust).
import { useId } from 'vue'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { testIds } from '~/utils/testids'

const props = withDefaults(defineProps<{
  /** "{source}" of "I trust {source}". */
  source: string
  needsPassword?: boolean
  passwordError?: string | null
  disabled?: boolean
}>(), {
  needsPassword: false,
  passwordError: null,
  disabled: false,
})

const emit = defineEmits<{
  /** + W12.17: Enter in the password field. */
  confirm: []
}>()

const checked = defineModel<boolean>('checked', { required: true })
const password = defineModel<string>('password', { required: true })

const ids = { checkbox: useId(), password: useId(), error: useId() }

function onChecked(value: boolean | 'indeterminate') {
  checked.value = value === true
}

/** Enter in the password field; Enter that ends an IME composition is not a confirmation. */
function onPasswordEnter(event: KeyboardEvent) {
  if (event.isComposing)
    return
  emit('confirm')
}
</script>

<template>
  <div class="grid gap-3">
    <div class="flex items-start gap-2.5">
      <Checkbox
        :id="ids.checkbox"
        :model-value="checked"
        :disabled="props.disabled"
        :data-testid="testIds.trustCheckbox"
        class="mt-0.5"
        @update:model-value="onChecked"
      />
      <Label :for="ids.checkbox" class="min-w-0 flex-wrap leading-snug font-normal">
        I trust <span class="break-all font-medium">{{ props.source }}</span>
      </Label>
    </div>
    <div v-if="props.needsPassword" class="grid gap-1.5">
      <Label :for="ids.password">Confirm your password</Label>
      <Input
        :id="ids.password"
        v-model="password"
        type="password"
        autocomplete="current-password"
        :disabled="props.disabled"
        :aria-invalid="props.passwordError ? true : undefined"
        :aria-describedby="props.passwordError ? ids.error : undefined"
        :data-testid="testIds.trustPassword"
        @keydown.enter="onPasswordEnter"
      />
      <p v-if="props.passwordError" :id="ids.error" role="alert" class="text-sm text-destructive">
        {{ props.passwordError }}
      </p>
      <p v-else class="text-xs text-muted-foreground">
        Running code on the server needs a login within the last 10 minutes.
      </p>
    </div>
  </div>
</template>
