<script setup lang="ts">
// "Allowed in every project" (docs/UI.md 2.15, 7.23, 9.10; ADR-038): the global shell rules, a SettingsSection that
// pages/settings/projects.vue mounts below ProjectsSettings (also when no project exists), with the explanation as its
// description and AllowlistEditor with `projectId` null.
// Contract (docs/UI.md 10.5; frozen from Gate P8-0b): no props, no emits; root allowlist-section.
import SettingsSection from '~/components/settings/SettingsSection.vue'
import { testIds } from '~/utils/testids'
import { allowlistDescription } from './allowlist'
import AllowlistEditor from './AllowlistEditor.vue'
</script>

<template>
  <SettingsSection
    :data-testid="testIds.allowlistSection"
    title="Allowed in every project"
    :description="allowlistDescription('global')"
  >
    <AllowlistEditor :project-id="null" />
  </SettingsSection>
</template>
