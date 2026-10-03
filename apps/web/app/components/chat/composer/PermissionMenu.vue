<script setup lang="ts">
// Permission mode menu (docs/UI.md 7.11): a radio menu bound to `ToolMode` — Ask (default), Accept edits (Phase 7,
// project chats), Plan (Phase 9, project chats; shown in `text-info`), Auto (shown in ember: tools run without
// asking), Off. `modes` limits the options (menu order is always that of TOOL_MODE_OPTIONS); the composer passes Accept
// edits and Plan only for a project chat or while selected. The composer renders the menu only when a usable tool
// exists and the model can call tools. Alt+P opens it; + Phase 9: Shift+Tab in the composer cycles the mode
// (`useModeCycle`), so the trigger's `aria-keyshortcuts` lists Shift+Tab while the `shiftTabModes` setting is on (and
// Alt+P while `altShortcuts` is on).
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
import { useSettingsStore } from '~/stores/settings'
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
const settings = useSettingsStore()
const current = computed(() => toolModeOption(props.modelValue))
/** The trigger's shortcuts: Alt+P (with Alt shortcuts on) and Shift+Tab (the mode cycle, with `shiftTabModes` on). */
const keyShortcuts = computed(() => {
  const keys = [
    settings.resolved.altShortcuts ? 'Alt+P' : null,
    settings.resolved.shiftTabModes ? 'Shift+Tab' : null,
  ].filter(key => key !== null)
  return keys.length > 0 ? keys.join(' ') : undefined
})

/** The accent of a mode: Auto in ember (primary), Plan in info; null = the muted default. */
function accentClass(value: ToolMode): string | null {
  if (value === 'auto')
    return 'text-primary'
  if (value === 'plan')
    return 'text-info'
  return null
}

/** The trigger's colors: Auto in ember, Plan in info, the rest muted. */
const triggerClass = computed(() => {
  switch (current.value.value) {
    case 'auto':
      return 'text-primary hover:text-primary aria-expanded:text-primary'
    case 'plan':
      return 'text-info hover:text-info aria-expanded:text-info'
    default:
      return 'text-muted-foreground hover:text-foreground aria-expanded:text-foreground'
  }
})
/** The offered options in menu order; the current mode always shows, so the radio group never loses its value. */
const options = computed(() => TOOL_MODE_OPTIONS.filter(option =>
  props.modes.includes(option.value) || option.value === current.value.value))

function select(value: unknown) {
  const option = options.value.find(item => item.value === value)
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
              :aria-keyshortcuts="keyShortcuts"
              :class="cn('h-8 gap-1.5 px-2 font-normal pointer-coarse:h-10', triggerClass)"
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
                v-for="option in options"
                :key="option.value"
                :value="option.value"
                :data-testid="testIds.permissionOption"
                :data-value="option.value"
                class="h-auto items-start rounded-md py-2"
              >
                <component
                  :is="option.icon"
                  aria-hidden="true"
                  :class="cn('mt-0.5 size-4', accentClass(option.value) ?? 'text-muted-foreground')"
                />
                <span class="flex min-w-0 flex-col">
                  <span :class="accentClass(option.value) ?? undefined">{{ option.label }}</span>
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
