<script setup lang="ts">
// Empty-state greeting (docs/UI.md 2.2, 7.13): ember mark and "What's next, {displayName}?" in Source Serif. The default
// slot sits right under the heading (the new-chat project picker, docs/UI.md 2.12, 7.20).
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
  <div data-slot="chat-greeting" class="flex flex-col items-center gap-4">
    <BrandMark :size="28" />
    <h1
      :data-testid="testIds.emptyGreeting"
      class="text-center font-serif text-2xl leading-tight font-normal tracking-tight text-balance sm:text-[32px]"
    >
      {{ greeting }}
    </h1>
    <slot />
  </div>
</template>
