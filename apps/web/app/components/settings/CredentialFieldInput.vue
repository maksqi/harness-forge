<script setup lang="ts">
// One credential field of ProviderKeyDialog (docs/UI.md 9.2). Secrets are password inputs that start empty (the stored
// value is write-only; its masked hint is the placeholder) with a reveal toggle for what the user typed. Non-secret
// fields show their stored override; "Reset" goes back to the default. Env-provided values get a "From env" note.
import type { CredentialFieldView, FieldLink } from './key-dialog'
import { ArrowUpRightIcon, EyeIcon, EyeOffIcon } from '@lucide/vue'
import { computed, ref, useId, watch } from 'vue'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import ProviderStatusBadge from '~/components/providers/ProviderStatusBadge.vue'
import { testIds } from '~/utils/testids'
import { envNotice, isOverridden } from './key-dialog'

const props = withDefaults(defineProps<{
  view: CredentialFieldView
  modelValue: string
  link?: FieldLink | null
  error?: string | null
  disabled?: boolean
}>(), {
  link: null,
  error: null,
  disabled: false,
})

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const inputId = useId()
const noteId = useId()
const errorId = useId()
const revealed = ref(false)

// Nothing typed, nothing to reveal: the toggle only ever shows the user's own input.
watch(() => props.modelValue, (value) => {
  if (!value)
    revealed.value = false
})

const testId = computed(() => (props.view.type === 'url' && props.view.key === 'baseURL' ? testIds.keyBaseUrl : testIds.keyInput))
const fromEnv = computed(() => props.view.source === 'env')
const showReset = computed(() => isOverridden(props.view) && props.modelValue.trim() !== '')
const describedBy = computed(() => [fromEnv.value ? noteId : null, props.error ? errorId : null].filter(Boolean).join(' ') || undefined)

function update(value: string | number) {
  emit('update:modelValue', String(value))
}

function onSelect(value: unknown) {
  if (typeof value === 'string')
    emit('update:modelValue', value)
}
</script>

<template>
  <div data-slot="credential-field" :data-field="view.key" class="grid gap-2">
    <div class="flex min-h-5 items-center justify-between gap-3">
      <Label :for="inputId">
        {{ view.label }}
        <span v-if="!view.required && view.type !== 'select'" class="font-normal text-muted-foreground">(optional)</span>
      </Label>
      <a
        v-if="link"
        :href="link.href"
        target="_blank"
        rel="noopener noreferrer"
        :data-testid="link.getKey ? testIds.keyGetLink : undefined"
        class="inline-flex items-center gap-0.5 rounded-sm text-xs text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        {{ link.label }}
        <ArrowUpRightIcon aria-hidden="true" class="size-3" />
        <span class="sr-only">(opens in a new tab)</span>
      </a>
      <button
        v-else-if="showReset"
        type="button"
        :disabled="disabled"
        class="rounded-sm text-xs text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
        @click="emit('update:modelValue', '')"
      >
        Reset
      </button>
    </div>

    <InputGroup v-if="view.secret">
      <InputGroupInput
        :id="inputId"
        :model-value="modelValue"
        :type="revealed ? 'text' : 'password'"
        :placeholder="view.placeholder"
        :disabled="disabled"
        :data-testid="testId"
        :data-value="view.key"
        :aria-invalid="error ? true : undefined"
        :aria-describedby="describedBy"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        data-1p-ignore
        data-lpignore="true"
        class="font-mono text-[13px] placeholder:font-sans placeholder:text-sm"
        @update:model-value="update"
      />
      <InputGroupAddon align="inline-end">
        <InputGroupButton
          size="icon-xs"
          :aria-label="revealed ? 'Hide key' : 'Show key'"
          :aria-pressed="revealed"
          :title="revealed ? 'Hide key' : 'Show key'"
          :disabled="disabled || !modelValue"
          :data-testid="testIds.keyReveal"
          :data-state="revealed ? 'on' : 'off'"
          @click="revealed = !revealed"
        >
          <EyeOffIcon v-if="revealed" aria-hidden="true" />
          <EyeIcon v-else aria-hidden="true" />
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>

    <Select
      v-else-if="view.type === 'select'"
      :model-value="modelValue"
      :disabled="disabled"
      @update:model-value="onSelect"
    >
      <SelectTrigger :id="inputId" class="w-full" :data-testid="testId" :data-value="view.key" :aria-describedby="describedBy">
        <SelectValue :placeholder="view.placeholder" />
      </SelectTrigger>
      <SelectContent position="popper">
        <SelectItem v-for="option in view.options" :key="option" :value="option">
          {{ option }}
        </SelectItem>
      </SelectContent>
    </Select>

    <Input
      v-else
      :id="inputId"
      :model-value="modelValue"
      :type="view.type === 'url' ? 'url' : 'text'"
      :placeholder="view.placeholder"
      :disabled="disabled"
      :data-testid="testId"
      :data-value="view.key"
      :aria-invalid="error ? true : undefined"
      :aria-describedby="describedBy"
      autocomplete="off"
      autocapitalize="off"
      spellcheck="false"
      :class="view.type === 'url' ? 'font-mono text-[13px] placeholder:font-sans placeholder:text-sm' : undefined"
      @update:model-value="update"
    />

    <div v-if="fromEnv" :id="noteId" class="flex items-start gap-2 text-xs text-muted-foreground">
      <ProviderStatusBadge status="env" :data-testid="testIds.keyEnvBadge" class="mt-px" />
      <span class="leading-5">{{ envNotice(view) }}</span>
    </div>
    <p v-if="error" :id="errorId" role="alert" class="text-xs text-destructive">
      {{ error }}
    </p>
  </div>
</template>
