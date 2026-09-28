<script setup lang="ts">
// Public, read-only transcript of a share snapshot (docs/UI.md 2.9, 7.15, ADR-025): the content of /share/[token] in
// the `share` layout. W5.6 builds it (states loading / ready / unavailable / error on the root's data-state); this
// Phase 5 skeleton (C9) fixes the component, its prop and its root test id.
// Contract (docs/UI.md 10.4): `token` is the route param. Store-free: the component calls only shares.view and never
// loads the auth status, settings, models, providers or chats.
import { testIds } from '~/utils/testids'

defineProps<{ token: string }>()
</script>

<template>
  <div :data-testid="testIds.sharePage" data-state="loading" class="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 md:px-6" />
</template>
