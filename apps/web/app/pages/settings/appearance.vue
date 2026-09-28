<script setup lang="ts">
// Settings -> Appearance (docs/UI.md 9.5): theme cards, reading font, text size, density, expand thinking.
import AppearanceSettings from '~/components/settings/AppearanceSettings.vue'
import SettingsPage from '~/components/settings/SettingsPage.vue'
</script>

<template>
  <SettingsPage title="Appearance" description="Theme, reading font, text size and density.">
    <AppearanceSettings />
  </SettingsPage>
</template>
