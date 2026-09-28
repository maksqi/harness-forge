<script setup lang="ts">
// Recording indicator of the composer (docs/UI.md 2.11, 7.17, 10.4; ADR-029): replaces the left tools (+, model,
// effort, image options) while dictation records or transcribes: a red dot (bg-destructive, pulsing unless reduced
// motion; still while transcribing), the m:ss timer (composer-recording-time; not in a live region, so it is never
// announced; it stops while transcribing) and Cancel (composer-mic-cancel, 40px on coarse pointers), which drops the
// recording or aborts the transcription. Fits 390px.
// Contract (docs/UI.md 10.4): props / emits below (frozen since P6-0b); root composer-recording.
import { computed } from 'vue'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { testIds } from '~/utils/testids'

const props = withDefaults(defineProps<{
  /** useVoiceInput().elapsedMs: the timer "0:07" (m:ss). */
  elapsedMs: number
  /** The clip is being transcribed: the timer is stopped (the mic shows "Transcribing…"). */
  transcribing?: boolean
}>(), {
  transcribing: false,
})

const emit = defineEmits<{ cancel: [] }>()

/** m:ss of whole seconds; negative or non-finite values read 0:00. */
const time = computed(() => {
  const seconds = Number.isFinite(props.elapsedMs) && props.elapsedMs > 0 ? Math.floor(props.elapsedMs / 1000) : 0
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
})
</script>

<template>
  <div
    :data-testid="testIds.composerRecording"
    :data-state="transcribing ? 'transcribing' : 'recording'"
    role="group"
    :aria-label="transcribing ? 'Transcribing' : 'Recording'"
    class="flex min-w-0 items-center gap-2 pl-2.5"
  >
    <span
      aria-hidden="true"
      :class="cn('size-2 shrink-0 rounded-full bg-destructive', !transcribing && 'motion-safe:animate-pulse')"
    />
    <span :data-testid="testIds.composerRecordingTime" class="text-sm text-muted-foreground tabular-nums">{{ time }}</span>
    <Button
      type="button"
      variant="ghost"
      size="sm"
      :data-testid="testIds.composerMicCancel"
      class="h-8 font-normal text-muted-foreground hover:text-foreground pointer-coarse:h-10"
      @click="emit('cancel')"
    >
      Cancel
    </Button>
  </div>
</template>
