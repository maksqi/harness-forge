<script setup lang="ts">
// Add a model id the provider does not list (docs/UI.md 9.3): model id (required, mono), display name, kind (Chat,
// Image, Speech to text, Text to speech), then for chat models the context window and the capabilities ->
// `POST /api/custom-models` for the provider of the section (`kind` is always sent). TanStack Form + zod (AGENT.md).
import type { CatalogModel, CustomModelInput } from '@harness-forge/shared'
import type { AcceptableValue } from 'reka-ui'
import type { CustomModelKind } from './custom-model'
import { customModelInputSchema, modelIdSchema } from '@harness-forge/shared'
import { useForm } from '@tanstack/vue-form'
import { computed, ref, useId, watch } from 'vue'
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
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { useModelsStore } from '~/stores/models'
import { toHarnessError } from '~/utils/errors'
import { testIds } from '~/utils/testids'
import {
  CAPABILITY_OPTIONS,
  contextWindowError,
  CUSTOM_MODEL_KINDS,
  customModelInput,
  isCustomModelKind,
  modelNameRule,
} from './custom-model'

const props = defineProps<{ open: boolean, providerId: string, providerName: string }>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  'saved': [model: CatalogModel]
}>()

const models = useModelsStore()
const submitError = ref<string | null>(null)
const ids = { modelId: useId(), name: useId(), kind: useId(), contextWindow: useId() }

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
    kind: 'chat' as CustomModelKind,
    contextWindow: '',
    tools: true,
    vision: false,
    reasoning: false,
    pdf: false,
    imageOutput: false,
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
const kind = form.useSelector(state => state.values.kind)
/** The context window and the capabilities apply to chat models only (docs/UI.md 9.3). */
const isChat = computed(() => kind.value === 'chat')
const kindLabel = computed(() => CUSTOM_MODEL_KINDS.find(option => option.value === kind.value)?.label ?? 'Chat')
/** Where the model shows up once added. */
const placementText = computed(() => {
  switch (kind.value) {
    case 'image':
      return 'Image models appear in the model picker when the provider can generate images.'
    case 'transcription':
    case 'speech':
      return 'Choose it in Settings → Media.'
    default:
      return 'It appears in the model picker right away.'
  }
})

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

function onKind(value: AcceptableValue, handleChange: (value: CustomModelKind) => void) {
  if (isCustomModelKind(value))
    handleChange(value)
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
    <DialogContent :data-testid="testIds.customModelDialog" class="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md">
      <form class="grid gap-5" novalidate @submit.prevent.stop="form.handleSubmit()">
        <DialogHeader>
          <DialogTitle>Add a custom model</DialogTitle>
          <DialogDescription>
            For a model {{ providerName }} serves but does not list. {{ placementText }}
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

        <form.Field name="name" :validators="{ onChange: modelNameRule }">
          <template #default="{ field, state }">
            <div class="grid gap-2">
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

        <div :class="cn('grid gap-4', isChat && 'sm:grid-cols-[1fr_9rem]')">
          <form.Field name="kind">
            <template #default="{ field, state }">
              <div class="grid content-start gap-2">
                <Label :for="ids.kind">Kind</Label>
                <Select :model-value="state.value" @update:model-value="value => onKind(value, field.handleChange)">
                  <SelectTrigger :id="ids.kind" :data-value="state.value" class="w-full">
                    <span class="truncate">{{ kindLabel }}</span>
                  </SelectTrigger>
                  <SelectContent position="popper" align="start">
                    <SelectItem
                      v-for="option in CUSTOM_MODEL_KINDS"
                      :key="option.value"
                      :value="option.value"
                      :data-value="option.value"
                    >
                      {{ option.label }}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </template>
          </form.Field>
          <form.Field
            name="contextWindow"
            :validators="{
              onChangeListenTo: ['kind'],
              onChange: ({ value, fieldApi }) => contextWindowError(value, fieldApi.form.getFieldValue('kind')),
            }"
          >
            <template #default="{ field, state }">
              <div v-show="isChat" class="grid content-start gap-2">
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

        <fieldset v-show="isChat" class="grid gap-2.5">
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
