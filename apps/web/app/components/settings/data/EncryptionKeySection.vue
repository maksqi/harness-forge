<script setup lang="ts">
// Settings -> Data, "Encryption key" (docs/UI.md 9.8; ADR-034): loads keys.get() (KeyStatus) and shows Source,
// Version, Rotated and Secrets, the mismatch alert, "Rotate key…" (data-key-rotate; disabled when canRotate is false,
// with the CLI note for HF_MASTER_KEY) and owns the RotateKeyDialog.
// Contract (docs/UI.md 10.4): no props, no emits; root data-key-section.
// Stub (C15, P7-0b): implemented by W7.13 in P7-A; the contract is frozen. The stub renders the section heading only.
import { testIds } from '~/utils/testids'
import SettingsSection from '../SettingsSection.vue'
</script>

<template>
  <SettingsSection
    :data-testid="testIds.dataKeySection"
    title="Encryption key"
    description="API keys and other secrets are encrypted on this server with a master key."
  />
</template>
