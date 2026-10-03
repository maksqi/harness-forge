<script setup lang="ts">
// Settings -> Projects body (docs/UI.md 2.13, 9.10; ADR-031): the project rows sorted by name (project-row,
// data-project-id) with the path, "{n} chats", "Folder not found" (project-missing) and "Uses AGENTS.md" /
// "Uses CLAUDE.md"; the row `⋯` menu (project-row-menu): Rename (project-rename, project-rename-input) · Edit
// instructions… (project-instructions -> ProjectInstructionsDialog) · Delete… (project-delete -> ConfirmDialog,
// project-delete-confirm); the empty state (projects-empty) with Add project (project-add); `?add=1` opens the
// AddProjectDialog.
// Contract (docs/UI.md 10.4): no props, no emits; root projects-settings; rendered by pages/settings/projects.vue
// inside SettingsPage, which renders the PageHeader "Projects" with the Add project action.
// Stub (C15, P7-0b): implemented by W7.9 in P7-A; the contract is frozen.
import { testIds } from '~/utils/testids'
</script>

<template>
  <div :data-testid="testIds.projectsSettings" class="flex flex-col" />
</template>
