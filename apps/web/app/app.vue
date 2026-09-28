<script setup lang="ts">
// Root (docs/UI.md 4, 5): tooltip delay, layout + page, route announcer, toasts. The theme itself is applied by
// @nuxtjs/color-mode before first paint; this file keeps the browser chrome (theme-color) and toasts in step and
// suppresses color transitions for the frame in which the theme switches.
import { computed, watch } from 'vue'
import { useColorMode, useHead } from '#imports'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'

const colorMode = useColorMode()
const resolvedTheme = computed(() => (colorMode.value === 'light' ? 'light' : 'dark'))

// sRGB approximations of --background (docs/UI.md 4.1); meta tags cannot read CSS variables.
useHead({
  meta: [{ name: 'theme-color', content: computed(() => (resolvedTheme.value === 'light' ? '#faf9f5' : '#1a1918')) }],
})

// docs/UI.md 4.2: colors swap at once instead of sweeping through every transition.
// `sync` runs before the color-mode plugin swaps the <html> class later in the same tick.
let unlockFrame = 0
watch(() => colorMode.value, () => {
  if (typeof document === 'undefined')
    return
  const root = document.documentElement
  root.classList.add('hf-theme-switching')
  cancelAnimationFrame(unlockFrame)
  unlockFrame = requestAnimationFrame(() => {
    unlockFrame = requestAnimationFrame(() => root.classList.remove('hf-theme-switching'))
  })
}, { flush: 'sync' })
</script>

<template>
  <TooltipProvider :delay-duration="400">
    <NuxtRouteAnnouncer />
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
    <Toaster :theme="resolvedTheme" position="bottom-right" />
  </TooltipProvider>
</template>
