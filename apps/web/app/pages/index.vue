<script setup lang="ts">
// STUB (C5). W2.2 replaces this page: greeting, no-provider callout and the composer of a new chat whose first
// send moves to /chat/<id> (docs/UI.md 2.2, 6, 7.13). Never renders its own <main> (the layout's SidebarInset is).
import { computed } from 'vue'
import BrandMark from '~/components/common/BrandMark.vue'
import { useSettingsStore } from '~/stores/settings'
import { testIds } from '~/utils/testids'

const settings = useSettingsStore()
const greeting = computed(() => {
  const name = settings.resolved.displayName.trim()
  return name ? `What's next, ${name}?` : 'What\'s next?'
})
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col items-center px-4 pt-[30vh] md:px-6">
    <div class="flex w-full max-w-3xl flex-col items-center gap-4">
      <BrandMark :size="28" />
      <h1 :data-testid="testIds.emptyGreeting" class="text-center font-serif text-[32px] leading-tight tracking-tight">
        {{ greeting }}
      </h1>
      <div
        aria-hidden="true"
        class="mt-6 flex h-24 w-full items-start rounded-[20px] border bg-card px-4 py-3 text-[15px] text-muted-foreground shadow-sm"
      >
        Ask anything…
      </div>
    </div>
  </div>
</template>
