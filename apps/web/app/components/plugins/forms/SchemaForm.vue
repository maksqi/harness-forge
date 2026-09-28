<script setup lang="ts">
// Schema-driven settings form (docs/UI.md 8.9, 10.4; docs/PLUGINS.md section 7): one SchemaField per property of the
// plugin's SettingsSchema, in key order. TanStack Form holds the values; one form-level validator runs
// `settingsValuesSchema(schema, { secretsSet })` of @harness-forge/plugin-sdk (the validator the server uses) on every
// change and on submit. Messages show once a field was left or changed, and for every field after a submit attempt
// (focus moves to the first invalid one). Save is enabled only when something changed; "Reset to defaults" puts
// every non-secret property back to its default. Secret properties are write-only (SchemaSecretInput).
//
// v-model carries the values. A new `modelValue` object from the parent (e.g. the saved settings) becomes the new
// starting point; `reset()` (and "Discard") goes back to the starting point.
import type { SettingsSchema } from '@harness-forge/shared'
import type { SchemaFieldKind, SettingsValues } from './schema-form'
import { RotateCcwIcon } from '@lucide/vue'
import { useForm } from '@tanstack/vue-form'
import { computed, nextTick, ref, shallowRef, toRaw, useTemplateRef, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { testIds } from '~/utils/testids'
import {
  cloneValues,
  hasDefaultValues,
  sameValue,
  schemaFieldKind,
  schemaKeys,
  settingsChanged,
  validateSettingsValues,
  valuesWithDefaults,
} from './schema-form'
import SchemaField from './SchemaField.vue'

const props = withDefaults(defineProps<{
  schema: SettingsSchema
  modelValue: Record<string, unknown>
  /** Keys of secret properties that already have a stored value. */
  secretsSet?: string[]
  /** Masked hints of stored secrets by key ("sk-…9fQ2"), shown instead of the value. */
  secretHints?: Record<string, string | null>
  disabled?: boolean
  /** The parent is saving the submitted values (Save shows a spinner). */
  saving?: boolean
}>(), {
  secretsSet: () => [],
  secretHints: () => ({}),
  disabled: false,
  saving: false,
})

const emit = defineEmits<{
  'update:modelValue': [value: Record<string, unknown>]
  'submit': [value: Record<string, unknown>]
}>()

/** Controls whose message shows as soon as the value changed (they have no typing phase). */
const CHANGE_KINDS: ReadonlySet<SchemaFieldKind> = new Set(['select', 'boolean', 'checkboxes', 'tags', 'secret'])

const root = useTemplateRef<HTMLFormElement>('root')
/** The values the form started from: Save compares against them. */
const baseline = shallowRef<SettingsValues>(cloneValues(props.modelValue))

const keys = computed(() => schemaKeys(props.schema))
const requiredKeys = computed(() => new Set(props.schema.required ?? []))

const form = useForm({
  defaultValues: cloneValues(props.modelValue) as SettingsValues,
  // Every submit runs the validator, so all problems show at once.
  canSubmitWhenInvalid: true,
  validators: {
    onChange: ({ value }: { value: SettingsValues }) => {
      const result = validateSettingsValues(props.schema, value, props.secretsSet)
      return result ? { form: result.form, fields: result.fields } : undefined
    },
  },
  onSubmit: ({ value }) => {
    emit('submit', cloneValues(value))
  },
  onSubmitInvalid: () => {
    void focusFirstInvalid()
  },
})

const values = form.useSelector(state => state.values)
const submitted = form.useSelector(state => state.submissionAttempts > 0)
/** `validate()` was called: every message shows, as after a submit. */
const validated = ref(false)
const attempted = computed(() => submitted.value || validated.value)
const formError = form.useSelector((state) => {
  const error = state.errorMap.onChange as { form?: unknown } | undefined
  return typeof error?.form === 'string' ? error.form : null
})

const dirty = computed(() => settingsChanged(props.schema, values.value, baseline.value))
const atDefaults = computed(() => hasDefaultValues(props.schema, values.value))
const locked = computed(() => props.disabled || props.saving)

/** The last object sent through `update:modelValue`; when it comes back as `modelValue` it is the form's own edit. */
let emitted: object | null = null

// Form -> v-model.
watch(values, (next) => {
  if (sameValue(next, props.modelValue))
    return
  const copy = cloneValues(next)
  emitted = copy
  emit('update:modelValue', copy)
})

/** Starts from `start`: the values, the baseline Save compares against, and no messages. */
function startFrom(start: SettingsValues) {
  baseline.value = cloneValues(start)
  validated.value = false
  form.reset(cloneValues(start))
}

// v-model -> form: any object other than the form's own edit is a new starting point (e.g. the saved settings).
watch(() => props.modelValue, (next) => {
  if (toRaw(next) !== emitted)
    startFrom(next)
})
watch(() => props.schema, () => startFrom(props.modelValue))

/** Discards the edits: back to the values the form started from, without messages. */
function reset() {
  validated.value = false
  form.reset(cloneValues(baseline.value))
}

function resetToDefaults() {
  const next = valuesWithDefaults(props.schema, values.value)
  for (const key of keys.value)
    form.setFieldValue(key, cloneValues(next[key]))
}

/** Messages of a field once it was left, changed (for pickers and switches) or a submit was tried. */
function visibleErrors(key: string, meta: { errors: ReadonlyArray<unknown>, isBlurred: boolean, isDirty: boolean }): string[] {
  const property = props.schema.properties[key]
  const shown = attempted.value
    || meta.isBlurred
    || (property !== undefined && CHANGE_KINDS.has(schemaFieldKind(property)) && meta.isDirty)
  if (!shown)
    return []
  return meta.errors
    .map(error => (typeof error === 'string' ? error : (error as { message?: unknown } | undefined)?.message))
    .filter((message): message is string => typeof message === 'string' && message !== '')
}

async function focusFirstInvalid() {
  await nextTick()
  const field = root.value?.querySelector<HTMLElement>('[data-invalid="true"]')
  const control = field?.querySelector<HTMLElement>('input:not([type="hidden"]), textarea, button[role="switch"], button[role="combobox"], button[role="checkbox"], button')
  control?.focus()
}

/** Runs the validator and shows every message; resolves to true when the values are valid. */
async function validate(): Promise<boolean> {
  await form.validate('submit')
  validated.value = true
  const valid = validateSettingsValues(props.schema, form.state.values, props.secretsSet) === null
  if (!valid)
    await focusFirstInvalid()
  return valid
}

defineExpose({ validate, reset })
</script>

<template>
  <form
    ref="root"
    :data-testid="testIds.schemaForm"
    :data-dirty="dirty || undefined"
    novalidate
    class="flex flex-col"
    @submit.prevent.stop="form.handleSubmit()"
  >
    <div class="divide-y divide-border overflow-hidden rounded-xl border bg-card">
      <form.Field v-for="key in keys" :key="key" :name="key">
        <template #default="{ field, state }">
          <SchemaField
            :name="key"
            :property="schema.properties[key]!"
            :required="requiredKeys.has(key)"
            :model-value="state.value"
            :errors="visibleErrors(key, state.meta)"
            :secret-stored="secretsSet.includes(key)"
            :secret-hint="secretHints[key] ?? null"
            :disabled="locked"
            @update:model-value="(value: unknown) => field.handleChange(value)"
            @blur="field.handleBlur()"
          />
        </template>
      </form.Field>
    </div>

    <p v-if="formError && attempted" role="alert" class="mt-3 text-sm text-destructive">
      {{ formError }}
    </p>

    <div class="sticky bottom-0 z-10 mt-4 flex flex-wrap items-center gap-2 bg-background/90 py-3 backdrop-blur-sm supports-[backdrop-filter]:bg-background/75">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        :disabled="locked || atDefaults"
        :data-testid="testIds.schemaFormReset"
        class="-ml-2.5 text-muted-foreground hover:text-foreground"
        @click="resetToDefaults"
      >
        <RotateCcwIcon aria-hidden="true" data-icon="inline-start" />
        Reset to defaults
      </Button>
      <div class="ml-auto flex items-center gap-2">
        <span v-if="dirty && !saving" class="hidden text-xs text-muted-foreground sm:inline">Unsaved changes</span>
        <Button v-if="dirty" type="button" variant="ghost" size="sm" :disabled="locked" @click="reset">
          Discard
        </Button>
        <Button
          type="submit"
          size="sm"
          :disabled="locked || !dirty"
          :aria-busy="saving || undefined"
          :data-testid="testIds.schemaFormSave"
        >
          <Spinner v-if="saving" data-icon="inline-start" />
          Save
        </Button>
      </div>
    </div>
  </form>
</template>
