<script setup lang="ts">
// Settings -> Media "Images" (docs/UI.md 2.10, 9.9; ADR-028): "Image model" (settings-image-model: SettingsModelSelect
// kind="image", allowNone "None (the generate_image tool is off)") -> settings.update({ imageModelRef }), with the help
// text "The generate_image tool uses this model. To generate images directly, pick an image model in the composer."
// Opt-in: nothing is chosen automatically; the select lists the visible image models of connected providers. Saves on
// change (optimistic); a failure toasts and rolls back. The catalog and the settings are loaded by MediaSettings.
// Contract (docs/UI.md 10.4): no props, no emits; root image-settings; rendered by MediaSettings.
import { useId } from 'vue'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { useSettingsStore } from '~/stores/settings'
import { testIds } from '~/utils/testids'
import { toastError } from '../notify'
import SettingsModelSelect from '../SettingsModelSelect.vue'
import SettingsSection from '../SettingsSection.vue'

const settings = useSettingsStore()
const imageModelId = useId()

async function setImageModel(imageModelRef: string | null) {
  try {
    await settings.update({ imageModelRef })
  }
  catch (error) {
    toastError(error)
  }
}
</script>

<template>
  <SettingsSection
    :data-testid="testIds.imageSettings"
    title="Images"
    description="Generate pictures with your own providers."
  >
    <FieldGroup>
      <Field orientation="responsive">
        <FieldContent>
          <FieldLabel :for="imageModelId">
            Image model
          </FieldLabel>
          <FieldDescription>
            The generate_image tool uses this model. To generate images directly, pick an image model in the composer.
          </FieldDescription>
        </FieldContent>
        <SettingsModelSelect
          :id="imageModelId"
          :model-value="settings.resolved.imageModelRef"
          kind="image"
          allow-none
          none-label="None (the generate_image tool is off)"
          label="Image model"
          :data-testid="testIds.settingsImageModel"
          class="@md/field-group:w-96!"
          @update:model-value="setImageModel"
        />
      </Field>
    </FieldGroup>
  </SettingsSection>
</template>
