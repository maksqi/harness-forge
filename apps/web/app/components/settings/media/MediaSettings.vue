<script setup lang="ts">
// Settings -> Media body (docs/UI.md 2.10, 9.9; ADR-028, ADR-029): the Images section, then the Voice section. Every
// model here is opt-in (nothing is chosen automatically); each select lists the models of connected providers only.
// Loads what both sections read: the providers (which ones are connected), the model catalog (hidden models included:
// speech-to-text and text-to-speech models are hidden from the chat picker) and the settings. The sections render
// right away; a failed load says so above them, with Retry.
// Contract (docs/UI.md 10.4): no props, no emits; root media-settings; rendered by pages/settings/media.vue inside
// SettingsPage, which renders the PageHeader "Images and voice".
import { onMounted, ref } from 'vue'
import { useModelsStore } from '~/stores/models'
import { useProvidersStore } from '~/stores/providers'
import { useSettingsStore } from '~/stores/settings'
import { testIds } from '~/utils/testids'
import ImageSettings from '../images/ImageSettings.vue'
import SettingsLoadError from '../SettingsLoadError.vue'
import VoiceSettings from '../voice/VoiceSettings.vue'

const providers = useProvidersStore()
const models = useModelsStore()
const settings = useSettingsStore()

const loading = ref(false)
const loadError = ref<unknown>(null)

async function load() {
  loading.value = true
  loadError.value = null
  try {
    await Promise.all([
      providers.fetchAll(),
      models.fetchAll(),
      settings.loaded ? Promise.resolve() : settings.fetch(),
    ])
  }
  catch (error) {
    loadError.value = error
  }
  finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <div :data-testid="testIds.mediaSettings" class="flex flex-col">
    <SettingsLoadError
      v-if="loadError"
      title="Could not load the media settings"
      :error="loadError"
      :pending="loading"
      class="mt-4"
      @retry="load"
    />
    <ImageSettings />
    <VoiceSettings />
  </div>
</template>
