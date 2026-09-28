<script setup lang="ts">
// Miniature app window for a ThemeCard (docs/UI.md 9.5), drawn from the design tokens only. Dark renders inside a
// `.dark` scope, so the tokens resolve to their dark values in either mode. main.css has no light scope, so Light
// uses the tokens as they are in light mode and swaps foreground and background roles in dark mode.
import { cn } from '@/lib/utils'

defineProps<{ theme: 'light' | 'dark' }>()
</script>

<template>
  <div
    v-if="theme === 'dark'"
    aria-hidden="true"
    data-slot="theme-preview"
    data-theme="dark"
    class="dark size-full"
  >
    <div class="flex size-full bg-background">
      <div class="flex w-[26%] flex-col gap-1.5 border-r border-sidebar-border bg-sidebar p-2">
        <span class="h-1.5 w-3/4 rounded-full bg-primary/80" />
        <span class="mt-1 h-1 w-full rounded-full bg-foreground/20" />
        <span class="h-1 w-4/5 rounded-full bg-foreground/15" />
        <span class="h-1 w-3/5 rounded-full bg-foreground/15" />
      </div>
      <div class="flex flex-1 flex-col gap-1.5 p-2.5">
        <span class="ml-auto h-3 w-1/2 rounded-full bg-muted" />
        <span class="mt-0.5 h-1 w-5/6 rounded-full bg-foreground/30" />
        <span class="h-1 w-3/4 rounded-full bg-foreground/30" />
        <span class="h-1 w-2/5 rounded-full bg-foreground/30" />
        <div class="mt-auto flex h-4 items-center justify-end rounded-md border border-border bg-card px-1">
          <span class="size-2 rounded-full bg-primary" />
        </div>
      </div>
    </div>
  </div>
  <div v-else aria-hidden="true" data-slot="theme-preview" data-theme="light" class="size-full">
    <div class="flex size-full bg-background dark:bg-foreground">
      <div
        :class="cn(
          'flex w-[26%] flex-col gap-1.5 border-r p-2',
          'border-sidebar-border bg-sidebar',
          'dark:border-background/10 dark:bg-[color-mix(in_oklch,var(--foreground)_93%,var(--background))]',
        )"
      >
        <span class="h-1.5 w-3/4 rounded-full bg-primary/80" />
        <span class="mt-1 h-1 w-full rounded-full bg-foreground/20 dark:bg-background/20" />
        <span class="h-1 w-4/5 rounded-full bg-foreground/15 dark:bg-background/15" />
        <span class="h-1 w-3/5 rounded-full bg-foreground/15 dark:bg-background/15" />
      </div>
      <div class="flex flex-1 flex-col gap-1.5 p-2.5">
        <span class="ml-auto h-3 w-1/2 rounded-full bg-muted dark:bg-background/10" />
        <span class="mt-0.5 h-1 w-5/6 rounded-full bg-foreground/30 dark:bg-background/30" />
        <span class="h-1 w-3/4 rounded-full bg-foreground/30 dark:bg-background/30" />
        <span class="h-1 w-2/5 rounded-full bg-foreground/30 dark:bg-background/30" />
        <div class="mt-auto flex h-4 items-center justify-end rounded-md border border-border bg-card px-1 dark:border-background/15 dark:bg-foreground">
          <span class="size-2 rounded-full bg-primary" />
        </div>
      </div>
    </div>
  </div>
</template>
