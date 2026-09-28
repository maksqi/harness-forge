<script setup lang="ts">
// Settings -> About (docs/UI.md 9.6): versions from GET /api/health, license and "Copy diagnostics".
import AboutPanel from '~/components/settings/AboutPanel.vue'
import SettingsPage from '~/components/settings/SettingsPage.vue'
</script>

<template>
  <SettingsPage title="About" description="Versions, license and diagnostics.">
    <AboutPanel />
  </SettingsPage>
</template>
