<script setup lang="ts">
// Output style menu of the composer (Phase 11, ADR-051; docs/UI.md 7.32, 10.8): a ghost h-8 trigger with `Feather`
// (the effective style's label from `sm` when it is not Default, a dot below `sm`), named "Output style: {name}" plus
// " (automatic)" without a choice of the chat's own; a radio menu "Output style" with Automatic ("Uses {name}, set for
// {project}" / "Uses {name}, your default in Settings"), the built-ins, then the personal, project and plugin styles,
// and the footer "Manage output styles". ChatComposer renders it after EffortMenu (hidden for image models).
// `modelValue` = the chat's own choice (null = Automatic); `automatic` = what Automatic resolves to. Props, emits and the
// root test id are frozen from Gate P11-0b (C39 stub); W11.10 implements the menu in P11-A. The project and the plugin
// names come from `OUTPUT_STYLE_SCOPE` (provided by ChatComposer; without it the menu reads as a chat without a
// project). A chosen style that is no longer offered stays checked with "Not available". Opening focuses the checked
// option; closing returns focus to `returnFocusTo` (the textarea, desktop), else to the trigger.
import type { OutputStyleOption } from './output-style'
import { ArrowRightIcon, ChevronDownIcon, FeatherIcon } from '@lucide/vue'
import { useVModel } from '@vueuse/core'
import { computed, inject } from 'vue'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { testIds } from '~/utils/testids'
import { navigateTo } from './nuxt-imports'
import {
  automaticStyleLine,
  isDefaultStyle,
  manageStylesHref,
  missingStyle,
  NO_OUTPUT_STYLE_SCOPE,
  OUTPUT_STYLE_SCOPE,
  styleSourceText,
  styleTriggerName,
} from './output-style'

const props = withDefaults(defineProps<{
  open: boolean
  /** The chat's own choice; null = Automatic. */
  modelValue: string | null
  options: readonly OutputStyleOption[]
  /** What Automatic resolves to (the project's style, else the default). */
  automatic: OutputStyleOption | null
  /** Receives focus when the menu closes (the composer textarea); default: the trigger. */
  returnFocusTo?: HTMLElement | null
}>(), {
  returnFocusTo: null,
})

const emit = defineEmits<{
  'update:open': [open: boolean]
  'update:modelValue': [value: string | null]
}>()

const isOpen = useVModel(props, 'open', emit, { passive: true })
const injectedScope = inject(OUTPUT_STYLE_SCOPE, null)
const scope = computed(() => injectedScope?.value ?? NO_OUTPUT_STYLE_SCOPE)

const chosen = computed(() => (props.modelValue === null ? null : props.options.find(option => option.name === props.modelValue) ?? null))
/** The chat's choice when it is no longer offered: it stays checked, "Not available". */
const missing = computed(() => missingStyle(props.modelValue, props.options))
const effective = computed(() => (props.modelValue === null ? props.automatic?.name ?? 'default' : props.modelValue))
const label = computed(() => (props.modelValue === null ? props.automatic?.label : chosen.value?.label) ?? effective.value)
const triggerName = computed(() => styleTriggerName(label.value, props.modelValue === null))
/** The tooltip names the style without " (automatic)" (docs/UI.md 7.32). */
const tooltip = computed(() => styleTriggerName(label.value, false))
const notDefault = computed(() => !isDefaultStyle(effective.value))
const automaticLine = computed(() => automaticStyleLine(props.automatic, scope.value))

/** The radio rows after Automatic: the offered styles, then a chosen style that is no longer offered. */
const rows = computed(() => (missing.value ? [...props.options, missing.value] : [...props.options]))

/** The radio group's value: '' = Automatic. */
const checkedValue = computed(() => props.modelValue ?? '')

function sourceText(option: OutputStyleOption): string {
  return option.available ? styleSourceText(option, scope.value.pluginNames) : 'Not available'
}

function select(value: unknown) {
  if (typeof value !== 'string')
    return
  const next = value === '' ? null : value
  if (next !== null && !rows.value.some(option => option.name === next))
    return
  if (next !== props.modelValue)
    emit('update:modelValue', next)
}

function manage() {
  void navigateTo(manageStylesHref(scope.value.projectId))
}

/** Opening focuses the checked option, so ↑/↓ start from it (reka-ui focuses the menu itself otherwise). */
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
      <span class="inline-flex shrink-0">
        <DropdownMenu v-model:open="isOpen">
          <DropdownMenuTrigger as-child>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              :data-testid="testIds.outputStyleTrigger"
              :data-value="effective"
              :data-source="modelValue === null ? 'automatic' : 'chat'"
              :aria-label="triggerName"
              class="relative h-8 shrink-0 gap-1.5 px-2 font-normal text-muted-foreground hover:text-foreground aria-expanded:text-foreground pointer-coarse:h-10 pointer-coarse:min-w-10"
            >
              <FeatherIcon aria-hidden="true" class="size-4" />
              <template v-if="notDefault">
                <span data-slot="output-style-label" class="hidden max-w-[14ch] truncate sm:inline">{{ label }}</span>
                <ChevronDownIcon aria-hidden="true" class="hidden size-3.5 opacity-60 sm:inline" />
                <span
                  data-slot="output-style-dot"
                  aria-hidden="true"
                  class="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-primary sm:hidden pointer-coarse:top-2 pointer-coarse:right-2"
                />
              </template>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="top"
            align="start"
            :collision-padding="8"
            class="max-h-[min(60dvh,var(--reka-dropdown-menu-content-available-height))] w-80 max-w-[calc(100vw-1rem)] rounded-xl"
            @open-auto-focus="onOpenAutoFocus"
            @close-auto-focus="onCloseAutoFocus"
          >
            <DropdownMenuLabel>Output style</DropdownMenuLabel>
            <DropdownMenuRadioGroup :model-value="checkedValue" aria-label="Output style" @update:model-value="select">
              <DropdownMenuRadioItem
                value=""
                :data-testid="testIds.outputStyleOption"
                data-value=""
                class="h-auto min-h-(--row-height) rounded-md py-2 pointer-coarse:min-h-10"
              >
                <span class="flex min-w-0 flex-1 flex-col">
                  <span>Automatic</span>
                  <span data-slot="output-style-automatic" class="truncate text-xs text-muted-foreground">{{ automaticLine }}</span>
                </span>
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem
                v-for="option in rows"
                :key="option.name"
                :value="option.name"
                :data-testid="testIds.outputStyleOption"
                :data-value="option.name"
                class="h-auto min-h-(--row-height) gap-3 rounded-md py-2 pointer-coarse:min-h-10"
              >
                <span class="flex min-w-0 flex-1 flex-col">
                  <span class="truncate">{{ option.label }}</span>
                  <span v-if="option.description" class="truncate text-xs text-muted-foreground">{{ option.description }}</span>
                </span>
                <span data-slot="output-style-source" class="max-w-[40%] shrink-0 truncate text-xs text-muted-foreground">{{ sourceText(option) }}</span>
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              :data-testid="testIds.outputStyleManage"
              class="rounded-md pointer-coarse:min-h-10"
              @select="manage"
            >
              <span class="flex-1">Manage output styles</span>
              <ArrowRightIcon aria-hidden="true" class="text-muted-foreground" />
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
    </TooltipTrigger>
    <TooltipContent side="top">
      {{ tooltip }}
    </TooltipContent>
  </Tooltip>
</template>
