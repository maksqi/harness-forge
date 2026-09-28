<script setup lang="ts">
// Settings -> Media "Images" (docs/UI.md 2.10, 9.9; ADR-028): "Image model" (settings-image-model: SettingsModelSelect
// kind="image", allowNone "None (the generate_image tool is off)") -> settings.update({ imageModelRef }), with the help
// text "The generate_image tool uses this model. To generate images directly, pick an image model in the composer."
// Contract (docs/UI.md 10.4): no props, no emits; root image-settings; rendered by MediaSettings.
// Stub (C12, P6-0b): implemented by W6.10 in P6-A; props are frozen.
import { testIds } from '~/utils/testids'
import SettingsSection from '../SettingsSection.vue'
</script>

<template>
  <SettingsSection
    :data-testid="testIds.imageSettings"
    title="Images"
    description="Generate pictures with your own providers."
  />
</template>
