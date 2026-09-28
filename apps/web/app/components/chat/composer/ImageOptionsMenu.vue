<script setup lang="ts">
// Image options of the composer (docs/UI.md 2.11, 7.7, 10.4; ADR-028), after EffortMenu. An image model offers
// "Aspect ratio" (Auto + 7 ratios as shape tiles, image-aspect-option), "Images" 1-4 (image-count-option) and the checkbox
// "Edit the previous image" (image-edit-previous, only when previousImages > 0, checked by default); a chat model with
// capabilities.imageOutput offers the aspect ratio only; any other model renders nothing. The trigger
// (image-options-trigger) is a ghost h-8 button (40px on coarse pointers) with the Image icon and a summary ("16:9 · 2",
// "Auto"; the text hides below sm). Picking an option emits the whole new value (the composer stores it through
// useImageOptions().set: 1 image, Auto and "edit" are stored as the defaults, i.e. left out).
// Contract (docs/UI.md 10.4): props / emits below (frozen since P6-0b); v-model = useImageOptions().options,
// v-model:open.
import type { ImageOptions } from '@harness-forge/shared'
import type { AspectChoice } from './image-options'
import { ChevronDownIcon, ImageIcon } from '@lucide/vue'
import { useVModel } from '@vueuse/core'
import { computed, watch } from 'vue'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { imageOptionsScope } from '~/composables/useImageOptions'
import { useModelsStore } from '~/stores/models'
import { testIds } from '~/utils/testids'
import { ASPECT_CHOICES, aspectChoiceLabel, aspectShape, IMAGE_COUNTS, imageOptionsLabel, imageOptionsSummary, isAspectRatio } from './image-options'

const props = withDefaults(defineProps<{
  /** v-model: useImageOptions().options ({ n?, aspectRatio?, editPrevious? }). */
  modelValue: ImageOptions
  /** The composer's model: decides which options show (see above). */
  modelRef: string | null
  /** Images of the parent reply; "Edit the previous image" shows only when > 0. */
  previousImages?: number
  /** v-model:open. */
  open?: boolean
  /** Receives focus when the menu closes (the composer textarea); default: the trigger. */
  returnFocusTo?: HTMLElement | null
}>(), {
  previousImages: 0,
  open: false,
  returnFocusTo: null,
})

const emit = defineEmits<{
  'update:modelValue': [value: ImageOptions]
  'update:open': [value: boolean]
}>()

const models = useModelsStore()
const isOpen = useVModel(props, 'open', emit, { passive: true })

const scope = computed(() => imageOptionsScope(props.modelRef ? models.byRef(props.modelRef) : undefined))
const aspect = computed<AspectChoice>(() => props.modelValue.aspectRatio ?? 'auto')
const count = computed(() => String(props.modelValue.n ?? 1))
const editPrevious = computed(() => props.modelValue.editPrevious !== false)
const showCount = computed(() => scope.value === 'image')
const showEdit = computed(() => scope.value === 'image' && props.previousImages > 0)
const summary = computed(() => imageOptionsSummary(props.modelValue, scope.value ?? 'image'))
const label = computed(() => imageOptionsLabel(props.modelValue, scope.value ?? 'image'))

// Another kind of model hides the menu: it must not come back open with the next image model.
watch(scope, (value) => {
  if (!value && isOpen.value)
    isOpen.value = false
})

/** The whole new value; `undefined` marks an option that goes back to its default. */
function update(patch: Partial<ImageOptions>) {
  emit('update:modelValue', {
    n: props.modelValue.n,
    aspectRatio: props.modelValue.aspectRatio,
    editPrevious: props.modelValue.editPrevious,
    ...patch,
  })
}

function selectAspect(value: unknown) {
  if (value === 'auto' && props.modelValue.aspectRatio !== undefined)
    update({ aspectRatio: undefined })
  else if (isAspectRatio(value) && value !== props.modelValue.aspectRatio)
    update({ aspectRatio: value })
}

function selectCount(value: unknown) {
  const next = Number(value)
  if (!IMAGE_COUNTS.includes(next) || next === (props.modelValue.n ?? 1))
    return
  update({ n: next === 1 ? undefined : next })
}

function setEditPrevious(checked: boolean) {
  update({ editPrevious: checked ? undefined : false })
}

function shapeStyle(choice: AspectChoice) {
  const { width, height } = aspectShape(choice, 18)
  return { width: `${width}px`, height: `${height}px` }
}

/** Opening focuses the current aspect ratio, so the arrow keys start from it. */
function onOpenAutoFocus(event: Event) {
  const container = event.target instanceof HTMLElement ? event.target : null
  const checked = container?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]')
  if (!checked)
    return
  event.preventDefault()
  checked.focus({ preventScroll: true })
}

function onCloseAutoFocus(event: Event) {
  if (!props.returnFocusTo)
    return
  event.preventDefault()
  props.returnFocusTo.focus()
}

/** A choice tile (the menu's radio items restyled); the selected one gets the primary border. */
const TILE_CLASS = 'h-auto justify-center rounded-md border border-transparent px-1 data-[state=checked]:border-primary data-[state=checked]:font-medium'
</script>

<template>
  <!-- The menu root sits inside the tooltip trigger (see EffortMenu). -->
  <Tooltip v-if="scope">
    <TooltipTrigger as-child>
      <span class="inline-flex">
        <DropdownMenu v-model:open="isOpen">
          <DropdownMenuTrigger as-child>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              :data-testid="testIds.imageOptionsTrigger"
              :aria-label="label"
              class="h-8 gap-1.5 px-2 font-normal text-muted-foreground hover:text-foreground aria-expanded:text-foreground pointer-coarse:h-10"
            >
              <ImageIcon aria-hidden="true" class="size-4" />
              <span class="hidden tabular-nums sm:inline">{{ summary }}</span>
              <ChevronDownIcon aria-hidden="true" class="size-3.5 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="top"
            align="start"
            :collision-padding="8"
            class="w-64 rounded-xl"
            @open-auto-focus="onOpenAutoFocus"
            @close-auto-focus="onCloseAutoFocus"
          >
            <DropdownMenuLabel>Aspect ratio</DropdownMenuLabel>
            <DropdownMenuRadioGroup :model-value="aspect" class="grid grid-cols-4 gap-1 px-1 pb-1" @update:model-value="selectAspect">
              <DropdownMenuRadioItem
                v-for="choice in ASPECT_CHOICES"
                :key="choice"
                :value="choice"
                :data-testid="testIds.imageAspectOption"
                :data-value="choice"
                class="flex-col gap-1.5 py-2 text-xs"
                :class="TILE_CLASS"
              >
                <template #indicator-icon />
                <span aria-hidden="true" class="flex size-[18px] items-center justify-center">
                  <span
                    :class="choice === 'auto' ? 'rounded-[3px] border-[1.5px] border-dashed border-current' : 'rounded-[3px] border-[1.5px] border-current'"
                    :style="shapeStyle(choice)"
                  />
                </span>
                <span class="tabular-nums">{{ aspectChoiceLabel(choice) }}</span>
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <template v-if="showCount">
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Images</DropdownMenuLabel>
              <DropdownMenuRadioGroup :model-value="count" class="grid grid-cols-4 gap-1 px-1 pb-1" @update:model-value="selectCount">
                <DropdownMenuRadioItem
                  v-for="option in IMAGE_COUNTS"
                  :key="option"
                  :value="String(option)"
                  :data-testid="testIds.imageCountOption"
                  :data-value="String(option)"
                  class="py-1.5 text-sm tabular-nums"
                  :class="TILE_CLASS"
                >
                  <template #indicator-icon />
                  {{ option }}
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </template>
            <template v-if="showEdit">
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem
                :model-value="editPrevious"
                :data-testid="testIds.imageEditPrevious"
                class="rounded-md"
                @update:model-value="setEditPrevious"
              >
                Edit the previous image
              </DropdownMenuCheckboxItem>
            </template>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
    </TooltipTrigger>
    <TooltipContent side="top">
      Image options
    </TooltipContent>
  </Tooltip>
</template>
