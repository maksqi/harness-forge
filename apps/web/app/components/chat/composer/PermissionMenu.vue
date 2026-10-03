<script setup lang="ts">
// Permission mode menu (docs/UI.md 7.11): a radio menu bound to `ToolMode` — Ask (default), Auto (shown in ember:
// tools run without asking), Off. The composer renders it only when a usable tool exists and the model can call
// tools. Alt+P opens it.
import type { ToolMode } from '@harness-forge/shared'
import { toolModeSchema } from '@harness-forge/shared'
import { ChevronDownIcon } from '@lucide/vue'
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
import { cn } from '@/lib/utils'
import KbdCombo from '~/components/common/KbdCombo.vue'
import { testIds } from '~/utils/testids'
import { TOOL_MODE_OPTIONS, toolModeOption } from './permission'

const props = withDefaults(defineProps<{
  modelValue: ToolMode
  open?: boolean
  /** Receives focus when the menu closes (the composer textarea); default: the trigger. */
  returnFocusTo?: HTMLElement | null
  /**
   * + Phase 7 (C15 declares it, W7.12 uses it): the modes offered; default every mode. ChatComposer passes ask, auto,
   * off, plus edits in a project chat or while edits is selected.
   */
  modes?: readonly ToolMode[]
}>(), {
  open: false,
  returnFocusTo: null,
  modes: () => [...toolModeSchema.options],
})

const emit = defineEmits<{
  'update:modelValue': [value: ToolMode]
  'update:open': [value: boolean]
}>()

const isOpen = useVModel(props, 'open', emit, { passive: true })
const current = computed(() => toolModeOption(props.modelValue))

function select(value: unknown) {
  const option = TOOL_MODE_OPTIONS.find(item => item.value === value)
  if (option && option.value !== props.modelValue)
    emit('update:modelValue', option.value)
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
  <!-- The menu root sits inside the tooltip trigger (see EffortMenu). -->
  <Tooltip>
    <TooltipTrigger as-child>
      <span class="inline-flex">
        <DropdownMenu v-model:open="isOpen">
          <DropdownMenuTrigger as-child>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              :data-testid="testIds.permissionMenuTrigger"
              :data-value="current.value"
              :aria-label="`Permission mode: ${current.label}`"
              :class="cn(
                'h-8 gap-1.5 px-2 font-normal pointer-coarse:h-10',
                current.value === 'auto'
                  ? 'text-primary hover:text-primary aria-expanded:text-primary'
                  : 'text-muted-foreground hover:text-foreground aria-expanded:text-foreground',
              )"
            >
              <component :is="current.icon" aria-hidden="true" class="size-4" />
              <span class="hidden sm:inline">{{ current.label }}</span>
              <ChevronDownIcon aria-hidden="true" class="size-3.5 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="end" :collision-padding="8" class="w-72 max-w-[calc(100vw-1rem)] rounded-xl" @open-auto-focus="onOpenAutoFocus" @close-auto-focus="onCloseAutoFocus">
            <DropdownMenuLabel>Permission mode</DropdownMenuLabel>
            <DropdownMenuRadioGroup :model-value="current.value" @update:model-value="select">
              <DropdownMenuRadioItem
                v-for="option in TOOL_MODE_OPTIONS"
                :key="option.value"
                :value="option.value"
                :data-testid="testIds.permissionOption"
                :data-value="option.value"
                class="h-auto items-start rounded-md py-2"
              >
                <component
                  :is="option.icon"
                  aria-hidden="true"
                  :class="cn('mt-0.5 size-4', option.value === 'auto' ? 'text-primary' : 'text-muted-foreground')"
                />
                <span class="flex min-w-0 flex-col">
                  <span :class="option.value === 'auto' && 'text-primary'">{{ option.label }}</span>
                  <span class="text-xs text-muted-foreground">{{ option.description }}</span>
                </span>
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
    </TooltipTrigger>
    <TooltipContent side="top">
      Permission mode <KbdCombo keys="alt+code:KeyP" class="max-lg:hidden pointer-coarse:hidden" />
    </TooltipContent>
  </Tooltip>
</template>
