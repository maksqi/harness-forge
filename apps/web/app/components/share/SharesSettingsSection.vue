<script setup lang="ts">
// Settings -> Data "Shared links" (docs/UI.md 2.7, 9.8, ADR-025): every share link of every chat, newest first. W5.6
// builds the list; this Phase 5 skeleton (C9) fixes the component and its root test id.
// Contract (docs/UI.md 10.4): no props, no emits; rendered by DataSettings; lists the shares with shares.list() and
// refetches when the Share dialog closes (ui.shareChatId back to null).
import { testIds } from '~/utils/testids'
</script>

<template>
  <div :data-testid="testIds.sharesSection" />
</template>
