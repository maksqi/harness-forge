<script setup lang="ts">
// Model field of Settings -> Models and Settings -> Media (docs/UI.md 9.3, 9.9, 10.4): a select-like trigger with a
// searchable popover of the models of one kind, grouped by connected provider. The composer's ModelPicker (W2.3)
// serves the chat; this field only needs the "field" variant. `kind` decides the list (models.ts
// `modelSelectGroups`): `chat` (default) and `image` list the visible models of that kind, `transcription` and
// `speech` every model of that kind, hidden ones included. `allowNone` adds a first choice that emits null.
// Attributes (data-testid) go to the trigger. Every option carries `model-select-option` with `data-model-ref`
// (empty for the "none" choice, like the trigger's `data-value`). Without any model of the kind the popover says so
// ("No image models from your connected providers.") and has no search field.
import type { SettingsModelKind } from './models'
import { ChevronsUpDownIcon } from '@lucide/vue'
import { computed, ref } from 'vue'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import ModelCaps from '~/components/providers/ModelCaps.vue'
import ModelLabel from '~/components/providers/ModelLabel.vue'
import ProviderIcon from '~/components/providers/ProviderIcon.vue'
import { useModelsStore } from '~/stores/models'
import { useProvidersStore } from '~/stores/providers'
import { testIds } from '~/utils/testids'
import { MODEL_SELECT_EMPTY_TEXT, modelSelectGroups } from './models'

defineOptions({ inheritAttrs: false })

const props = withDefaults(defineProps<{
  modelValue: string | null
  allowNone?: boolean
  noneLabel?: string
  placeholder?: string
  disabled?: boolean
  /** Accessible name of the trigger (the visible label lives outside). */
  label?: string
  /** Which models are listed (docs/UI.md 10.4); default `chat`. */
  kind?: SettingsModelKind
}>(), {
  allowNone: false,
  noneLabel: 'None',
  placeholder: 'Choose a model',
  disabled: false,
  label: undefined,
  kind: 'chat',
})

const emit = defineEmits<{ 'update:modelValue': [value: string | null] }>()

/** Listbox value of the "none" choice (model refs always contain a colon, so they never collide). */
const NONE = 'none'

const models = useModelsStore()
const providers = useProvidersStore()
const open = ref(false)
const groups = computed(() => modelSelectGroups(providers.connected, models.items, props.kind))
/** Nothing of this kind to list: says so once the catalog has arrived, instead of an empty popover. */
const emptyText = computed(() => {
  if (groups.value.length > 0)
    return null
  return models.loaded ? MODEL_SELECT_EMPTY_TEXT[props.kind] : 'Loading models…'
})
const selected = computed(() => props.modelValue ?? NONE)
/** "Default model, Claude Sonnet 5": the field label plus the current choice. */
const accessibleName = computed(() => {
  if (!props.label)
    return undefined
  const current = props.modelValue
    ? models.byRef(props.modelValue)?.name ?? props.modelValue
    : props.allowNone ? props.noneLabel : props.placeholder
  return `${props.label}, ${current}`
})

function choose(value: string | null) {
  open.value = false
  if (value !== props.modelValue)
    emit('update:modelValue', value)
}
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <Button
        type="button"
        variant="outline"
        role="combobox"
        :aria-expanded="open"
        :aria-label="accessibleName"
        :disabled="disabled"
        :data-value="modelValue ?? ''"
        :data-kind="kind"
        class="h-9 w-full min-w-0 justify-between gap-2 px-2.5 font-normal"
        v-bind="$attrs"
      >
        <ModelLabel v-if="modelValue" :model-ref="modelValue" show-provider class="min-w-0" />
        <span v-else class="min-w-0 truncate text-muted-foreground" :title="allowNone ? noneLabel : placeholder">{{ allowNone ? noneLabel : placeholder }}</span>
        <ChevronsUpDownIcon aria-hidden="true" class="size-4 shrink-0 opacity-50" />
      </Button>
    </PopoverTrigger>
    <PopoverContent align="start" class="w-(--reka-popover-trigger-width) min-w-80 p-0">
      <Command :model-value="selected" class="max-h-[min(24rem,var(--reka-popover-content-available-height))]">
        <CommandInput v-if="groups.length > 0" placeholder="Search models…" aria-label="Search models" />
        <CommandList>
          <CommandEmpty class="py-6 text-center text-sm text-muted-foreground">
            No models found.
          </CommandEmpty>
          <CommandGroup v-if="allowNone">
            <CommandItem
              :value="NONE"
              :data-testid="testIds.modelSelectOption"
              data-model-ref=""
              :data-checked="modelValue === null"
              @select="choose(null)"
            >
              <span class="min-w-0 flex-1 truncate">{{ noneLabel }}</span>
            </CommandItem>
          </CommandGroup>
          <CommandGroup v-for="group in groups" :key="group.provider.id" :heading="group.provider.name">
            <CommandItem
              v-for="model in group.models"
              :key="model.ref"
              :value="model.ref"
              :data-testid="testIds.modelSelectOption"
              :data-model-ref="model.ref"
              :data-checked="model.ref === modelValue"
              @select="choose(model.ref)"
            >
              <ProviderIcon :id="group.provider.id" :icon="group.provider.icon" :name="group.provider.name" size="sm" />
              <span class="min-w-0 flex-1 truncate">{{ model.name }}</span>
              <span class="sr-only">{{ model.id }}, {{ group.provider.name }}</span>
              <ModelCaps
                :capabilities="model.capabilities"
                :context-window="model.contextWindow ?? undefined"
                class="shrink-0"
              />
            </CommandItem>
          </CommandGroup>
          <p
            v-if="emptyText"
            data-slot="model-select-empty"
            class="px-3 py-5 text-center text-sm text-balance text-muted-foreground"
          >
            {{ emptyText }}
          </p>
        </CommandList>
      </Command>
    </PopoverContent>
  </Popover>
</template>
