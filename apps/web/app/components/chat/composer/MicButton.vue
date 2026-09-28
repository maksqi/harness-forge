<script setup lang="ts">
// Dictation toggle of the composer (docs/UI.md 2.11, 7.17, 10.4; ADR-029), right before SendStopButton: a ghost icon
// button (32px, 40px on coarse pointers) with Mic (idle), a spinner (requesting), Stop on bg-destructive/10 with a ring
// that follows `level` (recording, aria-pressed; static under reduced motion) or a spinner + "Transcribing…" (the text
// from `sm`; transcribing). Tooltip: the label + Alt+V (the composer registers the shortcut and calls `activate()`).
// Without a speech-to-text model a click opens the setup popover (composer-mic-setup: "Choose a speech-to-text model to
// dictate messages." + the "Open settings" link composer-mic-setup-link -> /settings/media); on an insecure origin it is
// aria-disabled with the tooltip "Voice input needs HTTPS or localhost". The composer renders it only when
// useVoiceInput().supported is true.
// Contract (docs/UI.md 10.4): props / emits below (frozen since P6-0b); root composer-mic with data-state = setup |
// insecure | the voice input state (an insecure origin wins over a missing model, which wins over the state);
// aria-pressed is always 'true' / 'false'; `toggle` is not emitted while requesting, in the setup state, when insecure
// or disabled. `activate()` (exposed) does what a click does.
import type { VoiceInputState } from '~/composables/useVoiceInput'
import { LoaderCircleIcon, MicIcon, SquareIcon } from '@lucide/vue'
import { computed, ref, useTemplateRef, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import KbdCombo from '~/components/common/KbdCombo.vue'
import { testIds } from '~/utils/testids'
import { DICTATION_SHORTCUT } from './dictation'

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

const INSECURE_HINT = 'Voice input needs HTTPS or localhost'

const button = useTemplateRef<InstanceType<typeof Button>>('button')
const setupOpen = ref(false)

/** An insecure origin wins over a missing model, which wins over the voice input state. */
const displayState = computed<MicDisplayState>(() => {
  if (!props.secure)
    return 'insecure'
  if (!props.configured)
    return 'setup'
  return props.state
})

const recording = computed(() => displayState.value === 'recording')
const transcribing = computed(() => displayState.value === 'transcribing')
const busy = computed(() => displayState.value === 'requesting' || transcribing.value)
const inactive = computed(() => props.disabled || displayState.value === 'insecure')
const tooltip = computed(() => (displayState.value === 'insecure' ? INSECURE_HINT : LABELS[displayState.value]))
/** The level ring grows up to 45% with the input level. */
const ringScale = computed(() => {
  const level = Number.isFinite(props.level) ? Math.min(Math.max(props.level, 0), 1) : 0
  return 1 + level * 0.45
})

function buttonElement(): HTMLElement | null {
  return (button.value?.$el as HTMLElement | undefined) ?? null
}

/** A click, or Alt+V through the composer. */
function activate(): void {
  const current = displayState.value
  if (props.disabled || current === 'insecure' || current === 'requesting')
    return
  if (current === 'setup') {
    setupOpen.value = !setupOpen.value
    return
  }
  emit('toggle')
}

watch(displayState, (value) => {
  if (value !== 'setup')
    setupOpen.value = false
})

let interactedOutside = false

/** The mic's own click toggles the popover, so a press on it is not an outside interaction. */
function onInteractOutside(event: Event) {
  const target = event.target instanceof Node ? event.target : null
  if (target && buttonElement()?.contains(target)) {
    event.preventDefault()
    return
  }
  interactedOutside = true
}

/** Focus goes back to the mic, unless the popover closed because the user went elsewhere. */
function onCloseAutoFocus(event: Event) {
  event.preventDefault()
  if (!interactedOutside)
    buttonElement()?.focus()
  interactedOutside = false
}

defineExpose({ activate })
</script>

<template>
  <!-- The popover root sits inside the tooltip trigger: nested the other way, the popover would anchor to the
       tooltip's popper (reka-ui injects the nearest popper root), see EffortMenu. -->
  <Tooltip :disabled="setupOpen">
    <TooltipTrigger as-child>
      <span class="inline-flex">
        <Popover v-model:open="setupOpen">
          <PopoverAnchor as-child>
            <Button
              ref="button"
              type="button"
              variant="ghost"
              :size="transcribing ? 'sm' : 'icon-sm'"
              :data-testid="testIds.composerMic"
              :data-state="displayState"
              :aria-label="LABELS[displayState]"
              :aria-pressed="recording ? 'true' : 'false'"
              aria-keyshortcuts="Alt+V"
              :aria-disabled="inactive ? 'true' : undefined"
              :aria-haspopup="displayState === 'setup' ? 'dialog' : undefined"
              :aria-expanded="displayState === 'setup' ? setupOpen : undefined"
              :class="cn(
                'relative rounded-full font-normal text-muted-foreground hover:text-foreground aria-disabled:cursor-not-allowed aria-disabled:opacity-50',
                transcribing
                  ? 'gap-1.5 px-2.5 pointer-coarse:h-10 max-sm:w-8 max-sm:px-0 max-sm:pointer-coarse:w-10'
                  : 'pointer-coarse:size-10',
                recording && 'bg-destructive/10 text-destructive hover:bg-destructive/20 hover:text-destructive',
              )"
              @click="activate"
            >
              <span
                v-if="recording"
                aria-hidden="true"
                data-slot="mic-level"
                class="pointer-events-none absolute inset-0 scale-(--mic-level-scale) rounded-full border-2 border-destructive/40 transition-transform duration-100 motion-reduce:scale-100 motion-reduce:transition-none"
                :style="{ '--mic-level-scale': ringScale }"
              />
              <LoaderCircleIcon v-if="busy" aria-hidden="true" class="size-4 animate-spin" />
              <SquareIcon v-else-if="recording" aria-hidden="true" class="size-3 fill-current" />
              <MicIcon v-else aria-hidden="true" class="size-4" />
              <span v-if="transcribing" class="hidden sm:inline">Transcribing…</span>
            </Button>
          </PopoverAnchor>
          <PopoverContent
            :data-testid="testIds.composerMicSetup"
            side="top"
            align="end"
            :side-offset="8"
            :collision-padding="8"
            class="w-72 gap-3 rounded-xl"
            @interact-outside="onInteractOutside"
            @close-auto-focus="onCloseAutoFocus"
          >
            <p class="text-sm">
              Choose a speech-to-text model to dictate messages.
            </p>
            <div class="flex justify-end">
              <Button as-child size="sm">
                <NuxtLink to="/settings/media" :data-testid="testIds.composerMicSetupLink" @click="setupOpen = false">
                  Open settings
                </NuxtLink>
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      </span>
    </TooltipTrigger>
    <TooltipContent side="top">
      {{ tooltip }}
      <KbdCombo v-if="displayState !== 'insecure'" :keys="DICTATION_SHORTCUT" class="max-lg:hidden pointer-coarse:hidden" />
    </TooltipContent>
  </Tooltip>
</template>
