<script setup lang="ts">
// Read aloud (docs/UI.md 7.5, 7.18, 10.4; ADR-029): a ghost icon button right after Copy on a finished assistant reply
// with text (the after-copy slot of MessageActions), shown only while a speech model is set (settings.speechModelRef).
// Volume2 "Read aloud"; a spinner while this reply loads; Square while it plays. While this reply is being read
// (loading or playing) the button is pressed (aria-pressed) and reads "Stop reading": a click, or Esc outside inputs,
// stops it. One app-wide player (useSpeechPlayer): starting another reply stops this one.
// Contract (docs/UI.md 10.4): props below; no emits; renders nothing while settings.speechModelRef is null; root
// message-read-aloud with data-state = idle | loading | playing (for this message). Attributes go to the button.
import { LoaderCircleIcon, SquareIcon, Volume2Icon } from '@lucide/vue'
import { computed } from 'vue'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import KbdCombo from '~/components/common/KbdCombo.vue'
import { useSpeechPlayer } from '~/composables/useSpeechPlayer'
import { useSettingsStore } from '~/stores/settings'
import { testIds } from '~/utils/testids'

defineOptions({ inheritAttrs: false })

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
const active = computed(() => state.value !== 'idle')
const label = computed(() => (active.value ? 'Stop reading' : 'Read aloud'))

function onClick() {
  // Synchronous inside the click: the player unlocks its audio element here.
  void player.toggle(props.messageId, props.markdown)
}
</script>

<template>
  <Tooltip v-if="enabled">
    <TooltipTrigger as-child>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        :data-testid="testIds.messageReadAloud"
        :data-state="state"
        :aria-label="label"
        :aria-pressed="active ? 'true' : 'false'"
        :aria-busy="state === 'loading' ? 'true' : undefined"
        class="text-muted-foreground hover:text-foreground aria-pressed:text-foreground pointer-coarse:size-10"
        v-bind="$attrs"
        @click="onClick"
      >
        <LoaderCircleIcon v-if="state === 'loading'" aria-hidden="true" class="size-3.5 animate-spin" />
        <SquareIcon v-else-if="state === 'playing'" aria-hidden="true" class="size-3 fill-current" />
        <Volume2Icon v-else aria-hidden="true" class="size-3.5" />
      </Button>
    </TooltipTrigger>
    <TooltipContent>
      {{ label }}
      <KbdCombo v-if="active" keys="escape" class="max-lg:hidden pointer-coarse:hidden" />
    </TooltipContent>
  </Tooltip>
</template>
