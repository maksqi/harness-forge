<script setup lang="ts">
// Settings -> Data (docs/UI.md 2.7, 9.8, ADR-024): backup export, import, shared links and delete-all.
import DataSettings from '~/components/settings/data/DataSettings.vue'
import SettingsPage from '~/components/settings/SettingsPage.vue'
</script>

<template>
  <SettingsPage title="Data" description="Back up and restore your chats, or delete them all.">
    <DataSettings />
  </SettingsPage>
</template>
