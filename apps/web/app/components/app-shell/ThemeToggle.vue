<script setup lang="ts">
// Dark / Light / System switch (docs/UI.md 4.2). Writes useColorMode().preference (stored in
// localStorage['hf-color-mode'] by @nuxtjs/color-mode). Expanded: a three-item ToggleGroup; `collapsed`: one icon
// button with a dropdown. Clicking the active item keeps it selected (the group is never empty).
// Collapsed, the Tooltip wraps the whole DropdownMenu: a Tooltip inside DropdownMenu would provide the popper
// context nearest to the menu trigger and capture its anchor, leaving the menu unpositioned.
import { computed } from 'vue'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { testIds } from '~/utils/testids'
import { useColorMode } from './nuxt-imports'
import { isThemePreference, normalizeThemePreference, THEME_OPTIONS } from './theme'

withDefaults(defineProps<{ collapsed?: boolean }>(), { collapsed: false })

const colorMode = useColorMode()

const preference = computed(() => normalizeThemePreference(colorMode.preference))
const current = computed(() => THEME_OPTIONS.find(option => option.value === preference.value) ?? THEME_OPTIONS[0]!)

function select(value: unknown) {
  // A single ToggleGroup emits an empty value when the active item is clicked again: ignore it.
  if (!isThemePreference(value) || value === colorMode.preference)
    return
  colorMode.preference = value
}
</script>

<template>
  <Tooltip v-if="collapsed">
    <TooltipTrigger as-child>
      <span class="inline-flex">
        <DropdownMenu>
          <DropdownMenuTrigger
            :data-testid="testIds.themeToggle"
            :aria-label="`Theme: ${current.label}`"
            class="flex size-8 items-center justify-center rounded-md text-sidebar-foreground/70 outline-none transition-colors duration-(--duration-fast) hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring/50 data-[state=open]:bg-sidebar-accent"
          >
            <component :is="current.icon" aria-hidden="true" class="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="end" class="w-40">
            <DropdownMenuLabel class="text-xs text-muted-foreground">
              Theme
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup :model-value="preference" @update:model-value="select">
              <DropdownMenuRadioItem
                v-for="option in THEME_OPTIONS"
                :key="option.value"
                :value="option.value"
                :data-testid="option.testId"
                :data-state="option.value === preference ? 'on' : 'off'"
              >
                <component :is="option.icon" aria-hidden="true" class="text-muted-foreground" />
                {{ option.label }}
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
    </TooltipTrigger>
    <TooltipContent side="right">
      Theme: {{ current.label }}
    </TooltipContent>
  </Tooltip>

  <ToggleGroup
    v-else
    type="single"
    :model-value="preference"
    :spacing="0.5"
    aria-label="Theme"
    :data-testid="testIds.themeToggle"
    class="rounded-lg bg-sidebar-accent/60 p-0.5 dark:bg-sidebar-accent/70"
    @update:model-value="select"
  >
    <Tooltip v-for="option in THEME_OPTIONS" :key="option.value">
      <TooltipTrigger as-child>
        <span class="inline-flex">
          <ToggleGroupItem
            :value="option.value"
            :aria-label="option.label"
            :data-testid="option.testId"
            class="size-7 min-w-7 rounded-md px-0 text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-xs dark:data-[state=on]:bg-muted"
          >
            <component :is="option.icon" aria-hidden="true" class="size-3.5" />
          </ToggleGroupItem>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">
        {{ option.label }}
      </TooltipContent>
    </Tooltip>
  </ToggleGroup>
</template>
