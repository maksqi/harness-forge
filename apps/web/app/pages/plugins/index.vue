<script setup lang="ts">
// /plugins?filter=&q= (docs/UI.md 2.3, 6, 8.2): the plugin list. The content lives in PluginListView (testable
// without Nuxt). Never renders its own <main>.
import PluginListView from '~/components/plugins/list/PluginListView.vue'
</script>

<template>
  <PluginListView />
</template>
