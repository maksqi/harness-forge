<script setup lang="ts">
// Reasoning effort menu (docs/UI.md 7.10): a radio menu with Auto ("Provider default") and the efforts the model
// offers (Off, Low, Medium, High, Max). Hidden for models without effort control; the value still travels with the
// request (an effort the model does not offer counts as Auto, so the trigger shows Auto then). Alt+R opens it.
import type { ReasoningEffort } from '@harness-forge/shared'
import { BrainIcon, ChevronDownIcon } from '@lucide/vue'
import { useVModel } from '@vueuse/core'
import { computed } from 'vue'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import KbdCombo from '~/components/common/KbdCombo.vue'
import { useModelsStore } from '~/stores/models'
import { testIds } from '~/utils/testids'
import { effectiveEffort, EFFORT_AUTO_DESCRIPTION, EFFORT_LABELS, effortOptions } from './effort'

const props = withDefaults(defineProps<{
  modelValue: ReasoningEffort
  modelRef: string | null
  open?: boolean
  /** Receives focus when the menu closes (the composer textarea); default: the trigger. */
  returnFocusTo?: HTMLElement | null
}>(), {
  open: false,
  returnFocusTo: null,
})

const emit = defineEmits<{
  'update:modelValue': [value: ReasoningEffort]
  'update:open': [value: boolean]
}>()

const models = useModelsStore()
const isOpen = useVModel(props, 'open', emit, { passive: true })

const options = computed(() => effortOptions(props.modelRef ? models.byRef(props.modelRef) : undefined))
const current = computed(() => effectiveEffort(props.modelValue, options.value))
const label = computed(() => EFFORT_LABELS[current.value])

function select(value: unknown) {
  const effort = options.value.find(option => option === value)
  if (effort && effort !== props.modelValue)
    emit('update:modelValue', effort)
}

/** Opening focuses the current value, so ↑/↓ start from it (reka-ui focuses the menu itself otherwise). */
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
</script>

<template>
  <!-- The menu root sits inside the tooltip trigger: a menu trigger nested in <Tooltip> would anchor the tooltip's
       popper instead of the menu's (reka-ui injects the nearest popper root). -->
  <Tooltip v-if="options.length > 0">
    <TooltipTrigger as-child>
      <span class="inline-flex">
        <DropdownMenu v-model:open="isOpen">
          <DropdownMenuTrigger as-child>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              :data-testid="testIds.effortMenuTrigger"
              :data-value="current"
              :aria-label="`Reasoning effort: ${label}`"
              class="h-8 gap-1.5 px-2 font-normal text-muted-foreground hover:text-foreground aria-expanded:text-foreground pointer-coarse:h-10"
            >
              <BrainIcon aria-hidden="true" class="size-4" />
              <span class="hidden sm:inline">{{ label }}</span>
              <ChevronDownIcon aria-hidden="true" class="size-3.5 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" :collision-padding="8" class="w-56 rounded-xl" @open-auto-focus="onOpenAutoFocus" @close-auto-focus="onCloseAutoFocus">
            <DropdownMenuLabel>Reasoning effort</DropdownMenuLabel>
            <DropdownMenuRadioGroup :model-value="current" @update:model-value="select">
              <DropdownMenuRadioItem
                v-for="option in options"
                :key="option"
                :value="option"
                :data-testid="testIds.effortOption"
                :data-value="option"
                class="h-auto min-h-(--row-height) rounded-md"
              >
                <span class="flex flex-col">
                  <span>{{ EFFORT_LABELS[option] }}</span>
                  <span v-if="option === 'auto'" class="text-xs text-muted-foreground">{{ EFFORT_AUTO_DESCRIPTION }}</span>
                </span>
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
    </TooltipTrigger>
    <TooltipContent side="top">
      Reasoning effort <KbdCombo keys="alt+code:KeyR" class="max-lg:hidden pointer-coarse:hidden" />
    </TooltipContent>
  </Tooltip>
</template>
