<script setup lang="ts">
// Settings → Web search, the page body (Phase 14, ADR-062, ADR-063; docs/UI.md 2.20, 9.15, 10.10): "Web search in chats"
// ("Use the model's own web search when it has one" → `webSearchNative`, "Turn on web search in new chats" →
// `webSearchDefault`, through the settings store) and "Search API" (the backend select Brave Search · Tavily · Exa, one
// write-only key row per backend, Max results, Test search and its result line, through the web-search store, which
// writes `core-search`'s settings). Every Switch keeps the 40 px coarse-pointer hit area. Mounted by
// `pages/settings/search.vue` inside SettingsPage.
// No props, no emits; the root test id is frozen from Gate P14-0b (C54 stub); W14.10 implements the page in P14-A.
import { testIds } from '~/utils/testids'
</script>

<template>
  <div :data-testid="testIds.webSearchSettings" class="flex flex-col gap-8" />
</template>
