<script setup lang="ts">
// /plugins/[id]?tab=overview|configuration|source|logs (docs/UI.md 2.4, 6, 8.7-8.11): one plugin. The content lives in
// PluginDetailView (testable without Nuxt). Never renders its own <main>.
import { computed } from 'vue'
import { useRoute } from '#imports'
import PluginDetailView from '~/components/plugins/detail/PluginDetailView.vue'

const route = useRoute()

const pluginId = computed(() => {
  const id = route.params.id
  return typeof id === 'string' ? id : ''
})
</script>

<template>
  <PluginDetailView :plugin-id="pluginId" />
</template>
