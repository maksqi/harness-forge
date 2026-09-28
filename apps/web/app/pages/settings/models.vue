<script setup lang="ts">
// Settings -> Models (docs/UI.md 9.3): default and title model, per-provider model tables and custom models.
import ModelsSettings from '~/components/settings/ModelsSettings.vue'
import SettingsPage from '~/components/settings/SettingsPage.vue'
</script>

<template>
  <SettingsPage title="Models" description="Default and title models, favorites and visibility.">
    <ModelsSettings />
  </SettingsPage>
</template>
