<script setup lang="ts">
// Add a model id the provider does not list (docs/UI.md 9.3): model id (required, mono), display name, context window
// and capabilities -> `POST /api/custom-models` for the provider of the section. TanStack Form + zod (AGENT.md).
import type { CatalogModel, CustomModelInput } from '@harness-forge/shared'
import { customModelInputSchema, modelIdSchema } from '@harness-forge/shared'
import { useForm } from '@tanstack/vue-form'
import { ref, useId, watch } from 'vue'
import { toast } from 'vue-sonner'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
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
import { useModelsStore } from '~/stores/models'
import { toHarnessError } from '~/utils/errors'
import { testIds } from '~/utils/testids'
import { CAPABILITY_OPTIONS, contextWindowRule, customModelInput, modelNameRule } from './custom-model'

const props = defineProps<{ open: boolean, providerId: string, providerName: string }>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  'saved': [model: CatalogModel]
}>()

const models = useModelsStore()
const submitError = ref<string | null>(null)
const ids = { modelId: useId(), name: useId(), contextWindow: useId() }

const modelIdRule = z.string().refine(value => value.trim() !== '', 'Enter the model id the provider expects.').refine(
  value => value.trim() === '' || modelIdSchema.safeParse(value.trim()).success,
  'Use up to 256 characters without line breaks.',
)

const form = useForm({
  // Every submit runs every validator, so all problems show at once.
  canSubmitWhenInvalid: true,
  defaultValues: {
    modelId: '',
    name: '',
    contextWindow: '',
    tools: true,
    vision: false,
    reasoning: false,
    pdf: false,
  },
  onSubmit: async ({ value }) => {
    submitError.value = null
    const input: CustomModelInput = customModelInput(props.providerId, value)
    const parsed = customModelInputSchema.safeParse(input)
    if (!parsed.success) {
      submitError.value = parsed.error.issues[0]?.message ?? 'Some values are not valid.'
      return
    }
    try {
      const model = await models.addCustom(parsed.data)
      toast.success(`Added ${model.name}`)
      emit('saved', model)
      emit('update:open', false)
    }
    catch (error) {
      submitError.value = toHarnessError(error).message
    }
  },
})

const submitting = form.useSelector(state => state.isSubmitting)
const attempted = form.useSelector(state => state.submissionAttempts > 0)

watch(() => props.open, (open) => {
  if (open) {
    form.reset()
    submitError.value = null
  }
})

function onOpenChange(value: boolean) {
  if (!value && submitting.value)
    return
  emit('update:open', value)
}

/** Validation messages of a field once it was left or a submit was tried. */
function errorsOf(meta: { errors: ReadonlyArray<unknown>, isBlurred: boolean }): string[] {
  if (!meta.isBlurred && !attempted.value)
    return []
  return meta.errors
    .map(error => (typeof error === 'string' ? error : (error as { message?: unknown } | undefined)?.message))
    .filter((message): message is string => typeof message === 'string' && message !== '')
}
</script>

<template>
  <Dialog :open="open" @update:open="onOpenChange">
    <DialogContent :data-testid="testIds.customModelDialog" class="sm:max-w-md">
      <form class="grid gap-5" novalidate @submit.prevent.stop="form.handleSubmit()">
        <DialogHeader>
          <DialogTitle>Add a custom model</DialogTitle>
          <DialogDescription>
            For a model {{ providerName }} serves but does not list. It appears in the model picker right away.
          </DialogDescription>
        </DialogHeader>

        <form.Field name="modelId" :validators="{ onChange: modelIdRule }">
          <template #default="{ field, state }">
            <div class="grid gap-2">
              <Label :for="ids.modelId">Model id</Label>
              <Input
                :id="ids.modelId"
                :model-value="state.value"
                :data-testid="testIds.customModelId"
                :aria-invalid="errorsOf(state.meta).length > 0 || undefined"
                placeholder="Exact model id…"
                autocomplete="off"
                autocapitalize="off"
                spellcheck="false"
                autofocus
                class="font-mono text-[13px] placeholder:font-sans placeholder:text-sm"
                @update:model-value="value => field.handleChange(String(value))"
                @blur="field.handleBlur"
              />
              <FieldError :errors="errorsOf(state.meta)" class="text-xs" />
            </div>
          </template>
        </form.Field>

        <div class="grid gap-4 sm:grid-cols-[1fr_9rem]">
          <form.Field name="name" :validators="{ onChange: modelNameRule }">
            <template #default="{ field, state }">
              <div class="grid content-start gap-2">
                <Label :for="ids.name">Display name <span class="font-normal text-muted-foreground">(optional)</span></Label>
                <Input
                  :id="ids.name"
                  :model-value="state.value"
                  :aria-invalid="errorsOf(state.meta).length > 0 || undefined"
                  autocomplete="off"
                  @update:model-value="value => field.handleChange(String(value))"
                  @blur="field.handleBlur"
                />
                <FieldError :errors="errorsOf(state.meta)" class="text-xs" />
              </div>
            </template>
          </form.Field>
          <form.Field name="contextWindow" :validators="{ onChange: contextWindowRule }">
            <template #default="{ field, state }">
              <div class="grid content-start gap-2">
                <Label :for="ids.contextWindow">Context window</Label>
                <Input
                  :id="ids.contextWindow"
                  :model-value="state.value"
                  :aria-invalid="errorsOf(state.meta).length > 0 || undefined"
                  inputmode="numeric"
                  placeholder="Tokens"
                  autocomplete="off"
                  class="tabular-nums"
                  @update:model-value="value => field.handleChange(String(value))"
                  @blur="field.handleBlur"
                />
                <FieldError :errors="errorsOf(state.meta)" class="text-xs" />
              </div>
            </template>
          </form.Field>
        </div>

        <fieldset class="grid gap-2.5">
          <legend class="mb-2.5 text-sm font-medium">
            Capabilities
          </legend>
          <div class="grid grid-cols-2 gap-x-4 gap-y-2.5">
            <form.Field v-for="option in CAPABILITY_OPTIONS" :key="option.key" :name="option.key">
              <template #default="{ field, state }">
                <Label class="font-normal">
                  <Checkbox
                    :model-value="state.value === true"
                    @update:model-value="value => field.handleChange(value === true)"
                  />
                  {{ option.label }}
                </Label>
              </template>
            </form.Field>
          </div>
        </fieldset>

        <p v-if="submitError" role="alert" class="text-sm text-destructive">
          {{ submitError }}
        </p>

        <DialogFooter>
          <Button type="button" variant="outline" :disabled="submitting" @click="onOpenChange(false)">
            Cancel
          </Button>
          <Button type="submit" :disabled="submitting" :data-testid="testIds.customModelSave">
            <Spinner v-if="submitting" data-icon="inline-start" />
            Add model
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
