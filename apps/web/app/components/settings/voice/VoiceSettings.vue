<script setup lang="ts">
// Settings -> Media "Voice" (docs/UI.md 2.10, 9.9; ADR-029). The description is the privacy notice. Controls:
// - "Speech to text" (settings-transcription-model): SettingsModelSelect kind="transcription", none = "Off" ->
//   transcriptionModelRef; on an insecure origin a warning line says "Voice input needs HTTPS or localhost" (the setting
//   still saves; the microphone cannot be used from this address).
// - "Language" (settings-transcription-language): "Detect automatically" + common languages -> transcriptionLanguage;
//   disabled while Speech to text is Off.
// - "Read aloud" (settings-speech-model): SettingsModelSelect kind="speech", none = "Off" -> speechModelRef; a change
//   also clears the voice (a new model has its own voices).
// - "Voice" (settings-speech-voice): a text input with suggestions from the model's `voices` (a popover listbox filtered
//   by the typed text; focus stays in the input: arrows move, Enter picks or saves, Esc closes, then restores); empty =
//   the provider default (null); validated like speechVoiceSchema; saves on blur or Enter -> speechVoice.
// - "Speed" (settings-speech-speed): 0.75x to 2x -> speechSpeed (the browser's playbackRate, never sent to the provider).
// - "Test voice" (settings-speech-test, data-state idle | loading | playing): reads a sample sentence with the chosen
//   model, voice and speed through the app-wide player (useSpeechPlayer, id VOICE_TEST_ID = 'voice-test'); "Stop"
//   while it plays. The player reports a failure itself (toast "Could not play the test voice" with the server
//   message) and never rejects.
// Voice, Speed and Test voice are disabled while Read aloud is Off. Choices save on change (optimistic; a failure
// toasts and rolls back). The catalog and the settings are loaded by MediaSettings.
// Contract (docs/UI.md 10.4): no props, no emits; root voice-settings; rendered by MediaSettings.
import type { Settings } from '@harness-forge/shared'
import type { AcceptableValue } from 'reka-ui'
import { CheckIcon, SquareIcon, TriangleAlertIcon, Volume2Icon } from '@lucide/vue'
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { Field, FieldContent, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { useSpeechPlayer, VOICE_TEST_ID } from '~/composables/useSpeechPlayer'
import { useModelsStore } from '~/stores/models'
import { useSettingsStore } from '~/stores/settings'
import { testIds } from '~/utils/testids'
import { toastError } from '../notify'
import SettingsModelSelect from '../SettingsModelSelect.vue'
import SettingsSection from '../SettingsSection.vue'
import {
  filterVoices,
  isSecureOrigin,
  languageLabel,
  parseLanguage,
  parseSpeed,
  parseVoice,
  SPEECH_SPEEDS,
  speedLabel,
  TEST_VOICE_TEXT,
  TRANSCRIPTION_LANGUAGES,
  VOICE_MAX_LENGTH,
} from './voice-settings'

const settings = useSettingsStore()
const models = useModelsStore()
const player = useSpeechPlayer()
const resolved = computed(() => settings.resolved)

const ids = {
  transcription: useId(),
  insecure: useId(),
  language: useId(),
  speech: useId(),
  voice: useId(),
  voiceError: useId(),
  voiceList: useId(),
  speed: useId(),
}

/** The microphone needs HTTPS or localhost; the setting itself still saves. */
const secure = isSecureOrigin()
const transcriptionOn = computed(() => resolved.value.transcriptionModelRef !== null)
const speechOn = computed(() => resolved.value.speechModelRef !== null)

async function save(patch: Partial<Settings>): Promise<boolean> {
  try {
    await settings.update(patch)
    return true
  }
  catch (error) {
    toastError(error)
    return false
  }
}

// ---------- speech to text ----------

function setTranscriptionModel(transcriptionModelRef: string | null) {
  void save({ transcriptionModelRef })
}

function onLanguage(value: AcceptableValue) {
  const language = parseLanguage(value)
  if (language !== null && language !== resolved.value.transcriptionLanguage)
    void save({ transcriptionLanguage: language })
}

// ---------- read aloud ----------

function setSpeechModel(speechModelRef: string | null) {
  // Voices belong to a model: a new model starts with the provider default.
  void save({ speechModelRef, speechVoice: null })
}

function onSpeed(value: AcceptableValue) {
  const speed = parseSpeed(value)
  if (speed !== null && speed !== resolved.value.speechSpeed)
    void save({ speechSpeed: speed })
}

// ---------- voice (text input with suggestions) ----------

const voiceDraft = ref(resolved.value.speechVoice ?? '')
const voiceFocused = ref(false)
const voiceError = ref<string | null>(null)
// Server values (and a model change clearing the voice) show up unless the user is editing.
watch(() => resolved.value.speechVoice, (value) => {
  if (voiceFocused.value)
    return
  voiceDraft.value = value ?? ''
  voiceError.value = null
})

/** Voices the selected speech model suggests (`CatalogModel.voices`); none when unknown. */
const voiceOptions = computed<readonly string[]>(() => {
  const modelRef = resolved.value.speechModelRef
  return modelRef ? models.byRef(modelRef)?.voices ?? [] : []
})
/** The filter: '' right after focusing (every voice is offered), then the typed text. */
const voiceQuery = ref('')
const suggestionsOpen = ref(false)
/** Index of the highlighted suggestion (aria-activedescendant), -1 for none. */
const highlighted = ref(-1)
const suggestions = computed(() => filterVoices(voiceOptions.value, voiceQuery.value))
const showSuggestions = computed(() => suggestionsOpen.value && speechOn.value && suggestions.value.length > 0)
const hasVoiceOptions = computed(() => voiceOptions.value.length > 0)

function optionId(index: number): string {
  return `${ids.voiceList}-option-${index}`
}

const activeOptionId = computed(() => (showSuggestions.value && highlighted.value >= 0 ? optionId(highlighted.value) : undefined))

watch(highlighted, async (index) => {
  if (index < 0)
    return
  await nextTick()
  document.getElementById(optionId(index))?.scrollIntoView?.({ block: 'nearest' })
})

function closeSuggestions() {
  suggestionsOpen.value = false
  highlighted.value = -1
}

function onVoiceFocus() {
  voiceFocused.value = true
  voiceQuery.value = ''
  highlighted.value = suggestions.value.indexOf(voiceDraft.value.trim())
  suggestionsOpen.value = true
}

/** Typing filters the suggestions (read from the element: the Input's v-model reaches `voiceDraft` a tick later). */
function onVoiceInput(event: Event) {
  voiceQuery.value = (event.target as HTMLInputElement | null)?.value ?? voiceDraft.value
  highlighted.value = -1
  suggestionsOpen.value = true
}

async function commitVoice() {
  const parsed = parseVoice(voiceDraft.value)
  if ('error' in parsed) {
    voiceError.value = parsed.error
    return
  }
  voiceError.value = null
  voiceDraft.value = parsed.value ?? ''
  if (parsed.value !== resolved.value.speechVoice && !(await save({ speechVoice: parsed.value })))
    voiceDraft.value = resolved.value.speechVoice ?? ''
}

function onVoiceBlur() {
  voiceFocused.value = false
  closeSuggestions()
  void commitVoice()
}

/** A suggestion was clicked: saved at once; focus stays in the input (the arrow keys offer every voice again). */
function pickVoice(voice: string) {
  voiceDraft.value = voice
  voiceQuery.value = ''
  closeSuggestions()
  void commitVoice()
}

function onVoiceKeydown(event: KeyboardEvent) {
  if (event.isComposing)
    return
  const input = event.currentTarget as HTMLInputElement | null
  const count = suggestions.value.length
  switch (event.key) {
    case 'ArrowDown':
    case 'ArrowUp': {
      if (!speechOn.value || count === 0)
        return
      event.preventDefault()
      if (!showSuggestions.value) {
        suggestionsOpen.value = true
        highlighted.value = event.key === 'ArrowDown' ? 0 : count - 1
        return
      }
      const step = event.key === 'ArrowDown' ? 1 : -1
      highlighted.value = highlighted.value < 0
        ? (step > 0 ? 0 : count - 1)
        : (highlighted.value + step + count) % count
      return
    }
    case 'Enter': {
      event.preventDefault()
      const choice = showSuggestions.value && highlighted.value >= 0 ? suggestions.value[highlighted.value] : undefined
      if (choice !== undefined)
        voiceDraft.value = choice
      closeSuggestions()
      // Leaving the field saves it (onVoiceBlur).
      input?.blur()
      return
    }
    case 'Escape': {
      event.preventDefault()
      if (showSuggestions.value) {
        closeSuggestions()
        return
      }
      voiceDraft.value = resolved.value.speechVoice ?? ''
      voiceError.value = null
      input?.blur()
    }
  }
}

/** A press on the input itself keeps the suggestions open; anywhere else closes them. */
function onSuggestionsInteractOutside(event: Event) {
  const original = (event as CustomEvent<{ originalEvent?: Event }>).detail?.originalEvent
  const target = (original?.target ?? event.target) as Node | null
  if (target && document.getElementById(ids.voice)?.contains(target))
    event.preventDefault()
}

function onSuggestionsOpenChange(open: boolean) {
  if (!open)
    closeSuggestions()
}

/** Focus stays in the input while the suggestions open and close. */
function keepFocus(event: Event) {
  event.preventDefault()
}

// ---------- test voice ----------

/** The Test voice state: the player's state while it reads the test sentence, else idle. */
const testState = computed(() => (player.activeId.value === VOICE_TEST_ID ? player.state.value : 'idle'))

/**
 * Starts (or stops) the test sentence. Runs inside the click: the player unlocks its audio element synchronously. It
 * reports a failed reading itself ("Could not play the test voice" with the server message) and never rejects.
 */
function testVoice() {
  const modelRef = resolved.value.speechModelRef
  if (!modelRef)
    return
  const voice = resolved.value.speechVoice
  void player.toggle(VOICE_TEST_ID, TEST_VOICE_TEXT, { modelRef, ...(voice ? { voice } : {}) })
}

function stopTestVoice() {
  if (player.activeId.value === VOICE_TEST_ID)
    player.stop()
}

// Read aloud turned off (the button is then disabled) or leaving the page stops the test sentence.
watch(speechOn, (on) => {
  if (!on)
    stopTestVoice()
})
onBeforeUnmount(stopTestVoice)
</script>

<template>
  <SettingsSection
    :data-testid="testIds.voiceSettings"
    title="Voice"
    description="Audio and text go to the provider you choose; harness-forge doesn't store them."
  >
    <FieldGroup class="gap-5">
      <Field orientation="responsive">
        <FieldContent>
          <FieldLabel :for="ids.transcription">
            Speech to text
          </FieldLabel>
          <p
            v-if="!secure"
            :id="ids.insecure"
            data-slot="voice-insecure-note"
            class="flex items-start gap-1.5 text-sm text-warning"
          >
            <TriangleAlertIcon aria-hidden="true" class="mt-0.5 size-3.5 shrink-0" />
            <span>Voice input needs HTTPS or localhost</span>
          </p>
        </FieldContent>
        <SettingsModelSelect
          :id="ids.transcription"
          :model-value="resolved.transcriptionModelRef"
          kind="transcription"
          allow-none
          none-label="Off"
          label="Speech to text"
          :aria-describedby="secure ? undefined : ids.insecure"
          :data-testid="testIds.settingsTranscriptionModel"
          class="@md/field-group:w-96!"
          @update:model-value="setTranscriptionModel"
        />
      </Field>

      <Field orientation="responsive" :data-disabled="!transcriptionOn">
        <FieldContent>
          <FieldLabel :for="ids.language">
            Language
          </FieldLabel>
        </FieldContent>
        <Select
          :model-value="resolved.transcriptionLanguage"
          :disabled="!transcriptionOn"
          @update:model-value="onLanguage"
        >
          <SelectTrigger
            :id="ids.language"
            :data-testid="testIds.settingsTranscriptionLanguage"
            :data-value="resolved.transcriptionLanguage"
            class="w-full @md/field-group:w-96!"
          >
            <span class="truncate">{{ languageLabel(resolved.transcriptionLanguage) }}</span>
          </SelectTrigger>
          <SelectContent position="popper" align="end" class="max-h-72 w-(--reka-select-trigger-width)">
            <SelectItem
              v-for="option in TRANSCRIPTION_LANGUAGES"
              :key="option.value"
              :value="option.value"
              :data-value="option.value"
            >
              <span class="flex-1">{{ option.label }}</span>
              <span v-if="option.value !== 'auto'" class="font-mono text-xs text-muted-foreground">{{ option.value }}</span>
            </SelectItem>
          </SelectContent>
        </Select>
      </Field>

      <Field orientation="responsive">
        <FieldContent>
          <FieldLabel :for="ids.speech">
            Read aloud
          </FieldLabel>
        </FieldContent>
        <SettingsModelSelect
          :id="ids.speech"
          :model-value="resolved.speechModelRef"
          kind="speech"
          allow-none
          none-label="Off"
          label="Read aloud"
          :data-testid="testIds.settingsSpeechModel"
          class="@md/field-group:w-96!"
          @update:model-value="setSpeechModel"
        />
      </Field>

      <Field orientation="responsive" :data-disabled="!speechOn" :data-invalid="voiceError ? true : undefined">
        <FieldContent>
          <FieldLabel :for="ids.voice">
            Voice
          </FieldLabel>
        </FieldContent>
        <div class="grid gap-1.5 @md/field-group:w-96!">
          <Popover :open="showSuggestions" @update:open="onSuggestionsOpenChange">
            <PopoverAnchor as-child>
              <Input
                :id="ids.voice"
                v-model="voiceDraft"
                :role="hasVoiceOptions ? 'combobox' : undefined"
                :aria-autocomplete="hasVoiceOptions ? 'list' : undefined"
                :aria-expanded="hasVoiceOptions ? showSuggestions : undefined"
                :aria-controls="showSuggestions ? ids.voiceList : undefined"
                :aria-activedescendant="activeOptionId"
                :aria-invalid="voiceError ? true : undefined"
                :aria-describedby="voiceError ? ids.voiceError : undefined"
                :maxlength="VOICE_MAX_LENGTH"
                :disabled="!speechOn"
                placeholder="Provider default"
                autocomplete="off"
                autocapitalize="off"
                autocorrect="off"
                spellcheck="false"
                :data-testid="testIds.settingsSpeechVoice"
                @focus="onVoiceFocus"
                @input="onVoiceInput"
                @blur="onVoiceBlur"
                @keydown="onVoiceKeydown"
              />
            </PopoverAnchor>
            <PopoverContent
              align="start"
              :side-offset="4"
              class="w-(--reka-popover-trigger-width) min-w-48 gap-0 p-1"
              @open-auto-focus="keepFocus"
              @close-auto-focus="keepFocus"
              @interact-outside="onSuggestionsInteractOutside"
            >
              <div
                :id="ids.voiceList"
                role="listbox"
                aria-label="Voices"
                data-slot="voice-suggestions"
                class="max-h-60 overflow-y-auto"
              >
                <div
                  v-for="(voice, index) in suggestions"
                  :id="optionId(index)"
                  :key="voice"
                  role="option"
                  :aria-selected="index === highlighted"
                  :data-highlighted="index === highlighted ? '' : undefined"
                  :data-value="voice"
                  class="relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-highlighted:bg-muted data-highlighted:text-foreground"
                  @pointerdown.prevent
                  @pointermove="highlighted = index"
                  @click="pickVoice(voice)"
                >
                  <span class="min-w-0 flex-1 truncate">{{ voice }}</span>
                  <CheckIcon v-if="voice === resolved.speechVoice" aria-hidden="true" class="size-4 shrink-0" />
                </div>
              </div>
            </PopoverContent>
          </Popover>
          <FieldError v-if="voiceError" :id="ids.voiceError" class="text-xs">
            {{ voiceError }}
          </FieldError>
        </div>
      </Field>

      <Field orientation="responsive" :data-disabled="!speechOn">
        <FieldContent>
          <FieldLabel :for="ids.speed">
            Speed
          </FieldLabel>
        </FieldContent>
        <Select :model-value="String(resolved.speechSpeed)" :disabled="!speechOn" @update:model-value="onSpeed">
          <SelectTrigger
            :id="ids.speed"
            :data-testid="testIds.settingsSpeechSpeed"
            :data-value="String(resolved.speechSpeed)"
            class="w-full tabular-nums @md/field-group:w-96!"
          >
            <span>{{ speedLabel(resolved.speechSpeed) }}</span>
          </SelectTrigger>
          <SelectContent position="popper" align="end" class="w-(--reka-select-trigger-width)">
            <SelectItem
              v-for="speed in SPEECH_SPEEDS"
              :key="speed"
              :value="String(speed)"
              :data-value="String(speed)"
              class="tabular-nums"
            >
              {{ speedLabel(speed) }}
            </SelectItem>
          </SelectContent>
        </Select>
      </Field>

      <div class="flex justify-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          :disabled="!speechOn"
          :aria-pressed="testState === 'playing'"
          :aria-busy="testState === 'loading' || undefined"
          :data-testid="testIds.settingsSpeechTest"
          :data-state="testState"
          class="pointer-coarse:h-10"
          @click="testVoice"
        >
          <Spinner v-if="testState === 'loading'" data-icon="inline-start" />
          <SquareIcon v-else-if="testState === 'playing'" aria-hidden="true" data-icon="inline-start" />
          <Volume2Icon v-else aria-hidden="true" data-icon="inline-start" />
          {{ testState === 'playing' ? 'Stop' : 'Test voice' }}
        </Button>
      </div>
    </FieldGroup>
  </SettingsSection>
</template>
