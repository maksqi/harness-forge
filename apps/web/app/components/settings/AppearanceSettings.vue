<script setup lang="ts">
// Settings -> Appearance body (docs/UI.md 4.2, 9.5): theme cards bound to `useColorMode().preference` (the same
// value as the sidebar ThemeToggle), reading font, text size, density and "Expand thinking by default". The
// appearance keys apply instantly through `settings.update()` -> `ui.applyAppearance()`; a live sample shows them.
import type { Settings } from '@harness-forge/shared'
import { computed, onMounted, useId } from 'vue'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { RadioGroup } from '@/components/ui/radio-group'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { isThemePreference, normalizeThemePreference, THEME_OPTIONS } from '~/components/app-shell/theme'
import { useSettingsStore } from '~/stores/settings'
import { testIds } from '~/utils/testids'
import {
  DENSITY_OPTIONS,
  isChoice,
  READING_FONT_OPTIONS,
  READING_SAMPLE,
  TEXT_SIZE_OPTIONS,
} from './appearance'
import { toastError } from './notify'
import { useColorMode } from './nuxt-imports'
import SettingsSection from './SettingsSection.vue'
import ThemeCard from './ThemeCard.vue'

const colorMode = useColorMode()
const settings = useSettingsStore()
const resolved = computed(() => settings.resolved)

const ids = { readingFont: useId(), textSize: useId(), density: useId(), showThinking: useId() }

onMounted(() => {
  if (!settings.loaded)
    settings.fetch().catch(() => {})
})

const preference = computed(() => normalizeThemePreference(colorMode.preference))

function selectTheme(value: unknown) {
  if (isThemePreference(value) && value !== colorMode.preference)
    colorMode.preference = value
}

async function save(patch: Partial<Settings>) {
  try {
    await settings.update(patch)
  }
  catch (error) {
    toastError(error)
  }
}

function onReadingFont(value: unknown) {
  if (isChoice(READING_FONT_OPTIONS, value) && value !== resolved.value.readingFont)
    void save({ readingFont: value })
}

function onTextSize(value: unknown) {
  if (isChoice(TEXT_SIZE_OPTIONS, value) && value !== resolved.value.textSize)
    void save({ textSize: value })
}

function onDensity(value: unknown) {
  if (isChoice(DENSITY_OPTIONS, value) && value !== resolved.value.density)
    void save({ density: value })
}
</script>

<template>
  <SettingsSection title="Theme" description="Dark is the default. System follows your device.">
    <RadioGroup
      :model-value="preference"
      aria-label="Theme"
      class="grid-cols-1 gap-3 min-[480px]:grid-cols-3"
      @update:model-value="selectTheme"
    >
      <ThemeCard
        v-for="option in THEME_OPTIONS"
        :key="option.value"
        :value="option.value"
        :label="option.label"
        :icon="option.icon"
        :checked="preference === option.value"
      />
    </RadioGroup>
  </SettingsSection>

  <SettingsSection title="Reading" description="How responses read in the transcript. The interface keeps its size.">
    <FieldGroup>
      <Field>
        <FieldLabel :id="ids.readingFont">
          Reading font
        </FieldLabel>
        <ToggleGroup
          type="single"
          :model-value="resolved.readingFont"
          :spacing="3"
          :aria-labelledby="ids.readingFont"
          :data-testid="testIds.appearanceReadingFont"
          class="grid w-full grid-cols-2"
          @update:model-value="onReadingFont"
        >
          <ToggleGroupItem
            v-for="option in READING_FONT_OPTIONS"
            :key="option.value"
            :value="option.value"
            :data-value="option.value"
            class="h-auto w-full flex-col items-start gap-1 rounded-xl border bg-card px-3.5 py-3 text-left whitespace-normal hover:bg-card hover:text-foreground data-[state=on]:border-primary/70 data-[state=on]:bg-card data-[state=on]:ring-3 data-[state=on]:ring-primary/15"
          >
            <span class="text-xs font-medium text-muted-foreground">{{ option.label }}</span>
            <span class="text-[15px] leading-snug font-normal text-foreground" :class="[option.fontClass]">{{ READING_SAMPLE }}</span>
          </ToggleGroupItem>
        </ToggleGroup>
      </Field>

      <Field orientation="responsive">
        <FieldContent>
          <FieldLabel :id="ids.textSize">
            Text size
          </FieldLabel>
          <FieldDescription>Size of messages in the transcript.</FieldDescription>
        </FieldContent>
        <ToggleGroup
          type="single"
          variant="outline"
          :model-value="resolved.textSize"
          :aria-labelledby="ids.textSize"
          :data-testid="testIds.appearanceTextSize"
          @update:model-value="onTextSize"
        >
          <ToggleGroupItem
            v-for="option in TEXT_SIZE_OPTIONS"
            :key="option.value"
            :value="option.value"
            :data-value="option.value"
            class="px-3"
          >
            {{ option.label }}
          </ToggleGroupItem>
        </ToggleGroup>
      </Field>

      <Field orientation="responsive">
        <FieldContent>
          <FieldLabel :id="ids.density">
            Density
          </FieldLabel>
          <FieldDescription>Compact tightens rows and the space between messages.</FieldDescription>
        </FieldContent>
        <ToggleGroup
          type="single"
          variant="outline"
          :model-value="resolved.density"
          :aria-labelledby="ids.density"
          :data-testid="testIds.appearanceDensity"
          @update:model-value="onDensity"
        >
          <ToggleGroupItem
            v-for="option in DENSITY_OPTIONS"
            :key="option.value"
            :value="option.value"
            :data-value="option.value"
            class="px-3"
          >
            {{ option.label }}
          </ToggleGroupItem>
        </ToggleGroup>
      </Field>

      <div data-slot="appearance-sample" aria-hidden="true" class="rounded-xl border bg-background p-4">
        <p class="mb-2 text-xs font-medium text-muted-foreground">
          Preview
        </p>
        <div class="hf-transcript flex flex-col gap-(--message-gap)">
          <p class="ml-auto max-w-[85%] rounded-2xl bg-muted px-4 py-2.5">
            How should I name the settings components?
          </p>
          <p class="font-reading">
            Name them after what they show: <strong class="font-semibold">ProviderList</strong> renders the providers,
            <strong class="font-semibold">ThemeCard</strong> one theme. Short, specific names read well in a file tree.
          </p>
        </div>
      </div>
    </FieldGroup>
  </SettingsSection>

  <SettingsSection title="Thinking">
    <Field orientation="horizontal">
      <FieldContent>
        <FieldLabel :for="ids.showThinking">
          Expand thinking by default
        </FieldLabel>
        <FieldDescription>Show the model's reasoning open instead of as a one-line summary.</FieldDescription>
      </FieldContent>
      <Switch
        :id="ids.showThinking"
        :model-value="resolved.showThinking"
        :data-testid="testIds.appearanceShowThinking"
        @update:model-value="value => save({ showThinking: value })"
      />
    </Field>
  </SettingsSection>
</template>
