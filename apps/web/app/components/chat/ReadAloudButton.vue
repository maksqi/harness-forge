<script setup lang="ts">
// Read aloud (docs/UI.md 7.5, 7.18, 10.4; ADR-029): a ghost icon button right after Copy on a finished assistant reply
// with text (the after-copy slot of MessageActions), shown only while a speech model is set (settings.speechModelRef).
// Volume2 "Read aloud"; a spinner while this reply loads; Square "Stop reading" with aria-pressed while it plays. One
// app-wide player (useSpeechPlayer): starting another reply stops this one; the row stays visible while it plays.
// Contract (docs/UI.md 10.4): props below; no emits; renders nothing while settings.speechModelRef is null; root
// message-read-aloud with data-state = idle | loading | playing (for this message).
// Stub (C12, P6-0b): implemented by W6.8 in P6-A; props are frozen. The stub wires the button to the (inert) player.
import { LoaderCircleIcon, SquareIcon, Volume2Icon } from '@lucide/vue'
import { computed } from 'vue'
import { Button } from '@/components/ui/button'
import { useSpeechPlayer } from '~/composables/useSpeechPlayer'
import { useSettingsStore } from '~/stores/settings'
import { testIds } from '~/utils/testids'

const props = defineProps<{
  /** The reply; compared with useSpeechPlayer().activeId. */
  messageId: string
  /** The reply's text parts as markdown (speech-text.ts decides what is read). */
  markdown: string
}>()

const settings = useSettingsStore()
const player = useSpeechPlayer()

const enabled = computed(() => Boolean(settings.resolved.speechModelRef))
const state = computed(() => (player.activeId.value === props.messageId ? player.state.value : 'idle'))
const playing = computed(() => state.value === 'playing')

function onClick() {
  void player.toggle(props.messageId, props.markdown)
}
</script>

<template>
  <Button
    v-if="enabled"
    type="button"
    variant="ghost"
    size="icon-xs"
    :data-testid="testIds.messageReadAloud"
    :data-state="state"
    :aria-label="playing ? 'Stop reading' : 'Read aloud'"
    :aria-pressed="playing ? 'true' : 'false'"
    class="text-muted-foreground hover:text-foreground pointer-coarse:size-10"
    @click="onClick"
  >
    <LoaderCircleIcon v-if="state === 'loading'" aria-hidden="true" class="size-3.5 animate-spin" />
    <SquareIcon v-else-if="playing" aria-hidden="true" class="size-3 fill-current" />
    <Volume2Icon v-else aria-hidden="true" class="size-3.5" />
  </Button>
</template>
