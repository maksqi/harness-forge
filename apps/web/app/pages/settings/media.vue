<script setup lang="ts">
// Settings -> Media (docs/UI.md 2.10, 9.9; ADR-028, ADR-029): the image model of the generate_image tool and the voice
// settings (speech to text, language, read aloud, voice, speed, test voice). Nav label "Media" (5.5).
import MediaSettings from '~/components/settings/media/MediaSettings.vue'
import SettingsPage from '~/components/settings/SettingsPage.vue'
</script>

<template>
  <SettingsPage title="Images and voice" description="Models for generated images, dictation and reading replies aloud.">
    <MediaSettings />
  </SettingsPage>
</template>
