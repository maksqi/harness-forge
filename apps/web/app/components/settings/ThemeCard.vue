<script setup lang="ts">
// One theme choice of Settings -> Appearance (docs/UI.md 9.5): a card with a miniature preview (System shows light
// and dark side by side), the label and a radio. Must be placed inside a RadioGroup bound to
// `useColorMode().preference`. The whole card is the radio's label, so clicking anywhere selects it.
import type { Component } from 'vue'
import type { ThemePreference } from '~/components/app-shell/theme'
import { useId } from 'vue'
import { RadioGroupItem } from '@/components/ui/radio-group'
import { testIds } from '~/utils/testids'
import ThemePreview from './ThemePreview.vue'

defineProps<{
  value: ThemePreference
  label: string
  icon: Component
  checked: boolean
}>()

const id = useId()
</script>

<template>
  <label
    :for="id"
    :data-testid="testIds.appearanceThemeCard"
    :data-value="value"
    :data-state="checked ? 'on' : 'off'"
    class="group/theme flex cursor-pointer flex-col gap-2.5 rounded-xl border bg-card p-2 transition-[border-color,box-shadow] duration-(--duration-fast) hover:border-foreground/20 has-focus-visible:ring-3 has-focus-visible:ring-ring/50 data-[state=on]:border-primary/70 data-[state=on]:ring-3 data-[state=on]:ring-primary/15"
  >
    <span class="relative block aspect-[16/10] overflow-hidden rounded-lg border border-border/80">
      <ThemePreview v-if="value !== 'dark'" theme="light" />
      <span
        v-if="value !== 'light'"
        :class="value === 'system' ? 'absolute inset-0 [clip-path:polygon(58%_0,100%_0,100%_100%,42%_100%)]' : 'absolute inset-0'"
      >
        <ThemePreview theme="dark" />
      </span>
    </span>
    <span class="flex items-center gap-2 px-1 pb-0.5">
      <component :is="icon" aria-hidden="true" class="size-4 text-muted-foreground" />
      <span class="text-sm font-medium">{{ label }}</span>
      <RadioGroupItem :id="id" :value="value" :aria-label="label" class="ml-auto" />
    </span>
  </label>
</template>
