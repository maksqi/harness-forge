<script setup lang="ts">
// Settings -> Media body (docs/UI.md 2.10, 9.9; ADR-028, ADR-029): the Images section, then the Voice section. Every
// model here is opt-in (nothing is chosen automatically); each select lists the models of connected providers only.
// Contract (docs/UI.md 10.4): no props, no emits; root media-settings; rendered by pages/settings/media.vue inside
// SettingsPage, which renders the PageHeader "Images and voice".
// Stub (C12, P6-0b): implemented by W6.10 in P6-A; props are frozen.
import { testIds } from '~/utils/testids'
import ImageSettings from '../images/ImageSettings.vue'
import VoiceSettings from '../voice/VoiceSettings.vue'
</script>

<template>
  <div :data-testid="testIds.mediaSettings" class="flex flex-col">
    <ImageSettings />
    <VoiceSettings />
  </div>
</template>
