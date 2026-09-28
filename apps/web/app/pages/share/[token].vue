<script setup lang="ts">
// /share/[token] (docs/UI.md 2.9, 6, 7.15, ADR-025): the public, read-only snapshot of a shared chat in the `share`
// layout (no sidebar, no stores). The content lives in SharedChatView (testable without Nuxt), which receives the
// token route param. Never renders its own <main> (the share layout does).
import { computed } from 'vue'
import { useRoute } from '~/components/share/nuxt-imports'
import SharedChatView from '~/components/share/SharedChatView.vue'

definePageMeta({ layout: 'share' })

const route = useRoute()

const token = computed(() => {
  const value = route.params.token
  return typeof value === 'string' ? value : ''
})
</script>

<template>
  <SharedChatView :token="token" />
</template>
