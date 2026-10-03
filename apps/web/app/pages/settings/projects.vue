<script setup lang="ts">
// Settings -> Projects (docs/UI.md 2.13, 9.10; ADR-031): folders on the server that chats can belong to. Nav label
// "Projects" (5.5); `?add=1` opens the Add project dialog.
// Stub (C15, P7-0b): W7.9 adds the header action Add project (project-add, FolderPlus) in P7-A.
import ProjectsSettings from '~/components/settings/projects/ProjectsSettings.vue'
import SettingsPage from '~/components/settings/SettingsPage.vue'
</script>

<template>
  <SettingsPage title="Projects" description="Folders on the server that chats can read and edit.">
    <ProjectsSettings />
  </SettingsPage>
</template>
