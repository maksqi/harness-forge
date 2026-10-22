<script setup lang="ts">
// Settings -> Web search (Phase 14, ADR-062, ADR-063; docs/UI.md 2.20, 9.15): whether chats search the web and how (the
// model's own search, the default of new chats) and the search API of the builtin plugin `core-search` (backend,
// write-only keys, max results, Test search). Nav label "Web search" (5.5). C54 (route frozen from Gate P14-0b); W14.10
// owns WebSearchSettings.
import WebSearchSettings from '~/components/settings/search/WebSearchSettings.vue'
import SettingsPage from '~/components/settings/SettingsPage.vue'
</script>

<template>
  <SettingsPage title="Web search" description="Search the web from the chat, with the model's own search or a search API.">
    <WebSearchSettings />
  </SettingsPage>
</template>
