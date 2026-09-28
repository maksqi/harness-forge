<script setup lang="ts">
// Dictation toggle of the composer (docs/UI.md 2.11, 7.17, 10.4; ADR-029), right before SendStopButton: a ghost icon
// button (32px, 40px on coarse pointers) with Mic (idle), a spinner (requesting), Stop on bg-destructive/10 with a ring
// that follows `level` (recording, aria-pressed; static under reduced motion) or a spinner + "Transcribing…"
// (transcribing). Tooltip "Dictate" + Alt+V (the composer registers the shortcut). Without a speech-to-text model a
// click opens the setup popover (composer-mic-setup: "Choose a speech-to-text model to dictate messages." + the
// "Open settings" button composer-mic-setup-link -> /settings/media); on an insecure origin it is aria-disabled with the
// tooltip "Voice input needs HTTPS or localhost". The composer renders it only when useVoiceInput().supported is true.
// Contract (docs/UI.md 10.4): props / emits below; root composer-mic with data-state = setup | insecure | the state;
// `toggle` is not emitted while requesting, in the setup state or when insecure.
// Stub (C12, P6-0b): implemented by W6.9 in P6-A; props are frozen. The stub has no tooltip, popover or level ring yet.
import type { VoiceInputState } from '~/composables/useVoiceInput'
import { LoaderCircleIcon, MicIcon, SquareIcon } from '@lucide/vue'
import { computed } from 'vue'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { testIds } from '~/utils/testids'

const props = withDefaults(defineProps<{
  /** useVoiceInput().state. */
  state: VoiceInputState
  /** settings.transcriptionModelRef is set; false = a click opens the setup popover. */
  configured: boolean
  /** useVoiceInput().secure; false = aria-disabled + "Voice input needs HTTPS or localhost". */
  secure: boolean
  /** The 0-1 input level drawn as a ring while recording. */
  level?: number
  /** The composer is disabled. */
  disabled?: boolean
}>(), {
  level: 0,
  disabled: false,
})

const emit = defineEmits<{ toggle: [] }>()

type MicDisplayState = VoiceInputState | 'setup' | 'insecure'

const LABELS: Record<MicDisplayState, string> = {
  idle: 'Dictate',
  requesting: 'Dictate',
  recording: 'Stop and transcribe',
  transcribing: 'Cancel transcription',
  setup: 'Dictate',
  insecure: 'Dictate',
}

/** An insecure origin wins over a missing model, which wins over the voice input state. */
const displayState = computed<MicDisplayState>(() => {
  if (!props.secure)
    return 'insecure'
  if (!props.configured)
    return 'setup'
  return props.state
})

const recording = computed(() => displayState.value === 'recording')
const busy = computed(() => displayState.value === 'requesting' || displayState.value === 'transcribing')

function onClick() {
  const current = displayState.value
  if (props.disabled || current === 'insecure' || current === 'setup' || current === 'requesting')
    return
  emit('toggle')
}
</script>

<template>
  <Button
    type="button"
    variant="ghost"
    size="icon-sm"
    :data-testid="testIds.composerMic"
    :data-state="displayState"
    :aria-label="LABELS[displayState]"
    :aria-pressed="recording ? 'true' : 'false'"
    aria-keyshortcuts="Alt+V"
    :aria-disabled="disabled || displayState === 'insecure' ? 'true' : undefined"
    :class="cn(
      'rounded-full text-muted-foreground hover:text-foreground aria-disabled:cursor-not-allowed aria-disabled:opacity-50 pointer-coarse:size-10',
      recording && 'bg-destructive/10 text-destructive hover:bg-destructive/20 hover:text-destructive',
    )"
    @click="onClick"
  >
    <LoaderCircleIcon v-if="busy" aria-hidden="true" class="size-4 animate-spin" />
    <SquareIcon v-else-if="recording" aria-hidden="true" class="size-3 fill-current" />
    <MicIcon v-else aria-hidden="true" class="size-4" />
  </Button>
</template>
