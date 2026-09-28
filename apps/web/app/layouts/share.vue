<script setup lang="ts">
// Public share layout (docs/UI.md 2.9, 5, 7.15): /share/[token] only. A header bar with the brand as plain text (not a
// link: visitors cannot use the app) and the theme menu, then the page, which fills the rest of the viewport. No
// sidebar, command palette, shortcuts dialog or Share dialog, and nothing that loads a store. The dark default still
// applies: @nuxtjs/color-mode sets the theme on <html> for every layout.
import ThemeToggle from '~/components/app-shell/ThemeToggle.vue'
import BrandMark from '~/components/common/BrandMark.vue'
</script>

<template>
  <div class="flex min-h-dvh flex-col bg-background">
    <header class="flex h-(--header-height) shrink-0 items-center gap-2 border-b border-border px-4 md:px-6">
      <BrandMark :size="16" />
      <span class="truncate font-mono text-[13px] font-medium tracking-tight text-foreground">harness-forge</span>
      <div class="ml-auto flex shrink-0 items-center">
        <ThemeToggle collapsed />
      </div>
    </header>
    <main class="flex min-w-0 flex-1 flex-col bg-background">
      <slot />
    </main>
  </div>
</template>
