<script setup lang="ts">
// "Allowed in every project" (docs/UI.md 2.15, 7.23, 9.10; ADR-038): the global shell rules, a SettingsSection that
// pages/settings/projects.vue mounts below ProjectsSettings, holding AllowlistEditor with `projectId` null.
// Contract (docs/UI.md 10.5; frozen from Gate P8-0b): no props, no emits; root allowlist-section. Stub (C20, P8-0b):
// the section and the editor stub (W8.11).
import SettingsSection from '~/components/settings/SettingsSection.vue'
import { testIds } from '~/utils/testids'
import AllowlistEditor from './AllowlistEditor.vue'
</script>

<template>
  <SettingsSection
    :data-testid="testIds.allowlistSection"
    title="Allowed in every project"
    description="Shell commands that start with one of these run without asking in every project."
  >
    <AllowlistEditor :project-id="null" />
  </SettingsSection>
</template>
