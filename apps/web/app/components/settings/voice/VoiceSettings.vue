<script setup lang="ts">
// Settings -> Media "Voice" (docs/UI.md 2.10, 9.9; ADR-029): "Speech to text" (settings-transcription-model, Off),
// "Language" (settings-transcription-language, Detect automatically), "Read aloud" (settings-speech-model, Off; a
// change clears the voice), "Voice" (settings-speech-voice, suggestions from the model's voices), "Speed"
// (settings-speech-speed, 0.75x to 2x), "Test voice" (settings-speech-test, through useSpeechPlayer) and the
// insecure-origin note. The description is the privacy notice.
// Contract (docs/UI.md 10.4): no props, no emits; root voice-settings; rendered by MediaSettings.
// Stub (C12, P6-0b): implemented by W6.10 in P6-A; props are frozen.
import { testIds } from '~/utils/testids'
import SettingsSection from '../SettingsSection.vue'
</script>

<template>
  <SettingsSection
    :data-testid="testIds.voiceSettings"
    title="Voice"
    description="Audio and text go to the provider you choose; harness-forge doesn't store them."
  />
</template>
