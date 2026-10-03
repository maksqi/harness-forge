<script setup lang="ts">
// The lazy diff of an open changes row (docs/UI.md 7.21): `GET /api/chats/:id/changes/diff?source={view}&path=` through
// workspace.fileDiff (aborted on unmount; a 3-line skeleton meanwhile), then DiffView with the diff's hunks, its
// added / removed as `stats` and line numbers; the notes for a binary file, a file too large for a diff and a base
// that is no longer stored; "Couldn't load the diff" with Retry (data-slot="changes-diff-error") on a failure.
// Contract (docs/UI.md 10.5; frozen from Gate P8-0b): props below, no emits; no root test id (data-slot="changes-diff",
// data-state = loading | ready | error). Stub (C20, P8-0b): the loading state only; nothing is fetched yet.
import type { ChangesView } from './changes-rows'

defineProps<{
  chatId: string
  view: ChangesView
  path: string
}>()
</script>

<template>
  <div data-slot="changes-diff" data-state="loading" class="flex min-w-0 flex-col" />
</template>
