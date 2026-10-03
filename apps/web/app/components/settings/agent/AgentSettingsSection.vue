<script setup lang="ts">
// Settings -> General -> Agent (docs/UI.md 2.16, 9.11, 10.6): mounted by GeneralSettings between the Chat fields and
// Custom instructions. No props, no emits; it reads and writes the settings store. Frozen from Gate P9-0b (C25); W9.12
// adds the fields: Automatic compaction (`settings-auto-compact`, `autoCompact`), Compaction model
// (`settings-compaction-model`, `compactModelRef`), Sub-agent model (`settings-subagent-model`, `subagentModelRef`) and
// Sub-agent max steps (`settings-subagent-max-steps`, `subagentMaxSteps`). The Shift+Tab switch
// (`settings-shift-tab-modes`) belongs to GeneralSettings.
import SettingsSection from '../SettingsSection.vue'
</script>

<template>
  <SettingsSection title="Agent" description="Long chats and sub-agents." />
</template>
