<script setup lang="ts">
// The chat page's workspace frame (docs/UI.md 2.15, 7.21; ADR-037): `pages/chat/[id].vue` wraps ChatView in it. W8.8
// makes it a horizontal ResizablePanelGroup that always holds the chat panel (so opening or closing the changes panel
// never remounts ChatView), plus, at >= 1024px with the panel open and a project, the handle changes-resize and an
// <aside> with ChangesPanel variant="pane"; below 1024px a right Sheet with ChangesPanel variant="sheet". Without a
// project only the chat panel renders. It registers Alt+C (toggle-changes, docs/UI.md 12).
// Contract (docs/UI.md 10.5; frozen from Gate P8-0b): props and slot below, no emits; no root test id
// (data-slot="chat-workspace"). Stub (C20, P8-0b): renders the slot only, in a `display: contents` wrapper, so the
// chat page lays out exactly as before.
defineProps<{
  chatId: string
  /** The chat's project; null: only the chat panel renders. */
  projectId: string | null
}>()

defineSlots<{
  /** The ChatView. */
  default: () => any
}>()
</script>

<template>
  <div data-slot="chat-workspace" class="contents">
    <slot />
  </div>
</template>
