<script setup lang="ts">
// Model picker (docs/UI.md 7.9, 10.4): a 22rem popover (a bottom drawer below `md`) with the searchable model list.
// `composer` variant: ghost trigger in the composer toolbar; picking a model also records it in the recent models.
// `field` variant: full-width select-like trigger (Settings -> Models; `allowNone` adds a first item that emits null).
// Opened by click, Alt+M or `/model` (the composer binds `v-model:open`). Attributes (data-testid, aria-*) go to the
// trigger. Loads the providers and models stores when they are not loaded yet.
import { useMediaQuery, useVModel } from '@vueuse/core'
import { onMounted } from 'vue'
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle, DrawerTrigger } from '@/components/ui/drawer'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { loadModelCatalog } from '~/composables/useComposerModel'
import { useModelsStore } from '~/stores/models'
import { testIds } from '~/utils/testids'
import ModelPickerList from './ModelPickerList.vue'
import ModelPickerTrigger from './ModelPickerTrigger.vue'
import { navigateTo } from './nuxt-imports'

defineOptions({ inheritAttrs: false })

const props = withDefaults(defineProps<{
  modelValue: string | null
  open?: boolean
  variant?: 'composer' | 'field'
  allowNone?: boolean
  noneLabel?: string
  disabled?: boolean
  /** Receives focus when the picker closes (the composer textarea); default: the trigger. */
  returnFocusTo?: HTMLElement | null
}>(), {
  open: false,
  variant: 'composer',
  allowNone: false,
  noneLabel: 'None',
  disabled: false,
  returnFocusTo: null,
})

const emit = defineEmits<{
  'update:modelValue': [value: string | null]
  'update:open': [value: boolean]
}>()

const models = useModelsStore()
const isOpen = useVModel(props, 'open', emit, { passive: true })
const isMobile = useMediaQuery('(max-width: 767.98px)')

onMounted(loadModelCatalog)

function choose(value: string | null) {
  if (value !== props.modelValue)
    emit('update:modelValue', value)
  if (value && props.variant === 'composer')
    models.touchRecent(value)
  isOpen.value = false
}

function close() {
  isOpen.value = false
}

function openPath(path: string) {
  isOpen.value = false
  void navigateTo(path)
}

function onCloseAutoFocus(event: Event) {
  if (!props.returnFocusTo)
    return
  event.preventDefault()
  props.returnFocusTo.focus()
}
</script>

<template>
  <Drawer v-if="isMobile" v-model:open="isOpen">
    <DrawerTrigger as-child>
      <ModelPickerTrigger
        v-bind="$attrs"
        :model-value="modelValue"
        :variant="variant"
        :none-label="noneLabel"
        :disabled="disabled"
      />
    </DrawerTrigger>
    <DrawerContent :data-testid="testIds.modelPicker" class="pb-[max(12px,env(safe-area-inset-bottom))]" @close-auto-focus="onCloseAutoFocus">
      <DrawerHeader class="sr-only">
        <DrawerTitle>Choose a model</DrawerTitle>
        <DrawerDescription>Search the models of your connected providers.</DrawerDescription>
      </DrawerHeader>
      <ModelPickerList
        :model-value="modelValue"
        :allow-none="allowNone"
        :none-label="noneLabel"
        list-class="max-h-[55vh]"
        @select="choose"
        @navigate="openPath"
        @close="close"
      />
    </DrawerContent>
  </Drawer>
  <Popover v-else v-model:open="isOpen">
    <PopoverTrigger as-child>
      <ModelPickerTrigger
        v-bind="$attrs"
        :model-value="modelValue"
        :variant="variant"
        :none-label="noneLabel"
        :disabled="disabled"
      />
    </PopoverTrigger>
    <PopoverContent
      :data-testid="testIds.modelPicker"
      :side="variant === 'composer' ? 'top' : 'bottom'"
      align="start"
      :collision-padding="8"
      :side-offset="6"
      class="w-[22rem] max-w-[calc(100vw-2rem)] gap-0 overflow-hidden rounded-xl p-0"
      @close-auto-focus="onCloseAutoFocus"
    >
      <ModelPickerList
        :model-value="modelValue"
        :allow-none="allowNone"
        :none-label="noneLabel"
        @select="choose"
        @navigate="openPath"
        @close="close"
      />
    </PopoverContent>
  </Popover>
</template>
