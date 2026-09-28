<script setup lang="ts">
// Settings -> Data body (docs/UI.md 2.7, 9.8, ADR-024): the summary, Export, Import, Shared links and the Danger zone.
// W5.5 builds the sections; this Phase 5 skeleton (C9) fixes the component, its root test id and the Shared links
// section (SharesSettingsSection, W5.6), which W5.5 keeps between Import and the Danger zone.
// Contract (docs/UI.md 10.4): no props, no emits; rendered by pages/settings/data.vue inside SettingsPage.
import SharesSettingsSection from '~/components/share/SharesSettingsSection.vue'
import { testIds } from '~/utils/testids'
</script>

<template>
  <div :data-testid="testIds.dataSettings" class="flex flex-col">
    <SharesSettingsSection />
  </div>
</template>
