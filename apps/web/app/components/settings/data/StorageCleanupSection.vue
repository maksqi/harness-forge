<script setup lang="ts">
// Settings -> Data, "Storage cleanup" (docs/UI.md 9.8; ADR-035): Check for unused files (data-cleanup-check ->
// data.cleanupPreview()), the summary (data-cleanup-summary), Remove… (data-cleanup-run) and its ConfirmDialog
// (data-cleanup-confirm -> data.cleanup()), the toast and the busy answer.
// Contract (docs/UI.md 10.4): no props, no emits; root data-cleanup-section.
// Stub (C15, P7-0b): implemented by W7.13 in P7-A; the contract is frozen. The stub renders the section heading only.
import { testIds } from '~/utils/testids'
import SettingsSection from '../SettingsSection.vue'
</script>

<template>
  <SettingsSection
    :data-testid="testIds.dataCleanupSection"
    title="Storage cleanup"
    description="Remove uploaded and generated files that no chat, share link, plugin or setting uses anymore. Files from the last 24 hours are kept, and deleting a chat or a version keeps its files until the next cleanup."
  />
</template>
