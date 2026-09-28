<script setup lang="ts">
// Settings -> General (docs/UI.md 9.4): display name, chat defaults, custom instructions and the password.
import GeneralSettings from '~/components/settings/GeneralSettings.vue'
import SettingsPage from '~/components/settings/SettingsPage.vue'
</script>

<template>
  <SettingsPage title="General" description="Your name, chat defaults and the password.">
    <GeneralSettings />
  </SettingsPage>
</template>
