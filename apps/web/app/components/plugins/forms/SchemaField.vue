<script setup lang="ts">
// One property of the settings form (docs/UI.md 8.9, docs/PLUGINS.md section 7): `title` is the label (with a
// required marker), `description` the help text (plain text), then the control for the property: text / URL input,
// autosizing textarea, write-only secret, select, number input (step 1 for integers, min / max), switch, checkbox
// group for enum lists, tag input for string lists. Presentational: the value comes in and changes go out.
import type { SettingsProperty } from '@harness-forge/shared'
import type { AcceptableValue } from 'reka-ui'
import type { SchemaFieldKind } from './schema-form'
import { computed, useId } from 'vue'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { testIds } from '~/utils/testids'
import { schemaFieldKind } from './schema-form'
import SchemaSecretInput from './SchemaSecretInput.vue'
import SchemaTagInput from './SchemaTagInput.vue'

const props = withDefaults(defineProps<{
  name: string
  property: SettingsProperty
  required?: boolean
  modelValue?: unknown
  errors?: readonly string[]
  secretStored?: boolean
  secretHint?: string | null
  disabled?: boolean
}>(), {
  required: false,
  modelValue: undefined,
  errors: () => [],
  secretStored: false,
  secretHint: null,
  disabled: false,
})

const emit = defineEmits<{
  'update:modelValue': [value: unknown]
  'blur': []
}>()

// URL literals stay out of template props: vue-tsc 3.3.12 breaks on `//` inside a component prop value
// (vuejs/language-tools#6240).
const URL_PLACEHOLDER = 'https://…'

/** Select value of "no value" (reka-ui items cannot use ''). */
const NONE = '__none__'

const controlId = useId()
const labelId = useId()
const descriptionId = useId()
const errorId = useId()

const kind = computed<SchemaFieldKind>(() => schemaFieldKind(props.property))
const error = computed(() => props.errors[0] ?? null)
const describedBy = computed(() => [props.property.description ? descriptionId : null, error.value ? errorId : null].filter(Boolean).join(' ') || undefined)
const invalid = computed(() => (error.value ? true : undefined))

const text = computed(() => (typeof props.modelValue === 'string' ? props.modelValue : props.modelValue == null ? '' : String(props.modelValue)))
const list = computed<string[]>(() => (Array.isArray(props.modelValue) ? props.modelValue.filter((item): item is string => typeof item === 'string') : []))
const enumOptions = computed(() => {
  if (props.property.type === 'string')
    return props.property.enum ?? []
  if (props.property.type === 'array')
    return props.property.items.enum ?? []
  return []
})
/** Optional selects without a default can go back to "no value". */
const allowNone = computed(() => !props.required && props.property.default === undefined)
const selectValue = computed(() => (typeof props.modelValue === 'string' ? props.modelValue : allowNone.value ? NONE : undefined))
const bounds = computed(() => (props.property.type === 'number' || props.property.type === 'integer'
  ? { min: props.property.minimum, max: props.property.maximum }
  : { min: undefined, max: undefined }))

function onText(value: string | number) {
  emit('update:modelValue', String(value))
}

function onNumber(value: string | number) {
  const raw = String(value).trim()
  if (raw === '') {
    emit('update:modelValue', undefined)
    return
  }
  const parsed = Number(raw)
  // Not a number: keep the text so validation can say so.
  emit('update:modelValue', Number.isFinite(parsed) ? parsed : raw)
}

function onSelect(value: AcceptableValue) {
  if (typeof value !== 'string')
    return
  emit('update:modelValue', value === NONE ? undefined : value)
}

function onToggleOption(option: string, checked: boolean | 'indeterminate') {
  const selected = new Set(list.value)
  if (checked === true)
    selected.add(option)
  else
    selected.delete(option)
  emit('update:modelValue', enumOptions.value.filter(value => selected.has(value)))
}
</script>

<template>
  <div
    :data-testid="testIds.schemaField"
    :data-value="name"
    :data-kind="kind"
    :data-invalid="error ? 'true' : undefined"
    :class="cn('flex gap-x-6 gap-y-2 px-4 py-4', kind === 'boolean' ? 'items-start justify-between' : 'flex-col')"
  >
    <div class="flex min-w-0 flex-col gap-1">
      <Label v-if="kind !== 'checkboxes'" :id="labelId" :for="controlId" class="leading-5">
        {{ property.title }}
        <template v-if="required">
          <span aria-hidden="true" class="-ml-1 text-destructive/80">*</span>
          <span class="sr-only">(required)</span>
        </template>
      </Label>
      <span v-else :id="labelId" class="flex items-center gap-2 text-sm leading-5 font-medium select-none">
        {{ property.title }}
        <template v-if="required">
          <span aria-hidden="true" class="-ml-1 text-destructive/80">*</span>
          <span class="sr-only">(required)</span>
        </template>
      </span>
      <p v-if="property.description" :id="descriptionId" class="text-sm/5 whitespace-pre-line text-muted-foreground">
        {{ property.description }}
      </p>
      <p v-if="error && kind === 'boolean'" :id="errorId" role="alert" class="text-xs text-destructive">
        {{ error }}
      </p>
    </div>

    <Switch
      v-if="kind === 'boolean'"
      :id="controlId"
      :model-value="modelValue === true"
      :disabled="disabled"
      :aria-describedby="describedBy"
      :aria-invalid="invalid"
      class="mt-0.5"
      @update:model-value="value => emit('update:modelValue', value)"
    />

    <SchemaSecretInput
      v-else-if="kind === 'secret'"
      :id="controlId"
      :model-value="typeof modelValue === 'string' ? modelValue : undefined"
      :stored="secretStored"
      :hint="secretHint"
      :required="required"
      :disabled="disabled"
      :invalid="!!error"
      :described-by="describedBy"
      :label="property.title"
      @update:model-value="value => emit('update:modelValue', value)"
      @blur="emit('blur')"
    />

    <Select
      v-else-if="kind === 'select'"
      :model-value="selectValue"
      :disabled="disabled"
      @update:model-value="onSelect"
      @update:open="open => !open && emit('blur')"
    >
      <SelectTrigger
        :id="controlId"
        class="w-full sm:w-80"
        :aria-describedby="describedBy"
        :aria-invalid="invalid"
      >
        <SelectValue placeholder="Select…" />
      </SelectTrigger>
      <SelectContent position="popper">
        <SelectItem v-if="allowNone" :value="NONE">
          <span class="text-muted-foreground">None</span>
        </SelectItem>
        <SelectItem v-for="option in enumOptions" :key="option" :value="option">
          {{ option }}
        </SelectItem>
      </SelectContent>
    </Select>

    <Input
      v-else-if="kind === 'number' || kind === 'integer'"
      :id="controlId"
      :model-value="modelValue === undefined || modelValue === null ? '' : String(modelValue)"
      type="number"
      :min="bounds.min"
      :max="bounds.max"
      :step="kind === 'integer' ? 1 : 'any'"
      :inputmode="kind === 'integer' ? 'numeric' : 'decimal'"
      :disabled="disabled"
      :aria-describedby="describedBy"
      :aria-invalid="invalid"
      class="w-full tabular-nums sm:w-48"
      @update:model-value="onNumber"
      @blur="emit('blur')"
    />

    <div
      v-else-if="kind === 'checkboxes'"
      role="group"
      :aria-labelledby="labelId"
      :aria-describedby="describedBy"
      class="flex flex-wrap gap-x-5 gap-y-2.5"
    >
      <Label v-for="option in enumOptions" :key="option" class="font-normal">
        <Checkbox
          :model-value="list.includes(option)"
          :disabled="disabled"
          :data-value="option"
          @update:model-value="checked => onToggleOption(option, checked)"
        />
        {{ option }}
      </Label>
    </div>

    <SchemaTagInput
      v-else-if="kind === 'tags'"
      :id="controlId"
      :model-value="list"
      :disabled="disabled"
      :invalid="!!error"
      :described-by="describedBy"
      :label="property.title"
      @update:model-value="value => emit('update:modelValue', value)"
      @blur="emit('blur')"
    />

    <Textarea
      v-else-if="kind === 'multiline'"
      :id="controlId"
      :model-value="text"
      rows="3"
      :disabled="disabled"
      :aria-describedby="describedBy"
      :aria-invalid="invalid"
      class="max-h-80 min-h-20"
      @update:model-value="onText"
      @blur="emit('blur')"
    />

    <Input
      v-else
      :id="controlId"
      :model-value="text"
      :type="kind === 'url' ? 'url' : 'text'"
      :placeholder="kind === 'url' ? URL_PLACEHOLDER : undefined"
      :inputmode="kind === 'url' ? 'url' : undefined"
      autocomplete="off"
      :spellcheck="kind === 'url' ? 'false' : undefined"
      :disabled="disabled"
      :aria-describedby="describedBy"
      :aria-invalid="invalid"
      :class="cn('w-full', kind === 'url' && 'font-mono text-[13px] placeholder:font-sans placeholder:text-sm')"
      @update:model-value="onText"
      @blur="emit('blur')"
    />

    <p v-if="error && kind !== 'boolean'" :id="errorId" role="alert" class="text-xs text-destructive">
      {{ error }}
    </p>
  </div>
</template>
