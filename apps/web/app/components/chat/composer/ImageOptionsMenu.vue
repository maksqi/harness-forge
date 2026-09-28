<script setup lang="ts">
// Image options of the composer (docs/UI.md 2.11, 7.7, 10.4; ADR-028), after EffortMenu. An image model offers
// "Aspect ratio" (Auto + 7 ratios, image-aspect-option), "Images" 1-4 (image-count-option) and the checkbox "Edit the
// previous image" (image-edit-previous, only when previousImages > 0, checked by default); a chat model with
// capabilities.imageOutput offers the aspect ratio only; any other model renders nothing. The trigger
// (image-options-trigger) is a ghost h-8 button with the Image icon and a summary ("16:9 · 2", "Auto"; the label hides
// below sm), 40px on coarse pointers.
// Contract (docs/UI.md 10.4): props / emits below; v-model = useImageOptions().options, v-model:open.
// Stub (C12, P6-0b): implemented by W6.9 in P6-A; props are frozen. The stub renders the trigger for image-capable
// models and only toggles `open`.
import type { ImageOptions } from '@harness-forge/shared'
import { ImageIcon } from '@lucide/vue'
import { computed } from 'vue'
import { Button } from '@/components/ui/button'
import { imageOptionsScope } from '~/composables/useImageOptions'
import { useModelsStore } from '~/stores/models'
import { testIds } from '~/utils/testids'

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

const scope = computed(() => imageOptionsScope(props.modelRef ? models.byRef(props.modelRef) : undefined))
</script>

<template>
  <Button
    v-if="scope"
    type="button"
    variant="ghost"
    size="sm"
    :data-testid="testIds.imageOptionsTrigger"
    aria-label="Image options"
    aria-haspopup="menu"
    :aria-expanded="open"
    class="h-8 gap-1.5 px-2 font-normal text-muted-foreground hover:text-foreground pointer-coarse:h-10"
    @click="emit('update:open', !open)"
  >
    <ImageIcon aria-hidden="true" class="size-4" />
  </Button>
</template>
