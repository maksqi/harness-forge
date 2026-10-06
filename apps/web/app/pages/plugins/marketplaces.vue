<script setup lang="ts">
// /plugins/marketplaces?m=&q=&category= (Phase 12, ADR-054; docs/UI.md 2.19, 6, 8.13): the Claude Code marketplaces. The
// static route wins over `[id].vue` (and `marketplaces` is a reserved plugin id). The content lives in MarketplacesView
// (testable without Nuxt). Never renders its own <main>.
import MarketplacesView from '~/components/plugins/marketplaces/MarketplacesView.vue'
</script>

<template>
  <MarketplacesView />
</template>
