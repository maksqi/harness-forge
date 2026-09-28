<script setup lang="ts">
// Version switcher of a message (docs/UI.md 7.5, 10.4, 14.1; ADR-023): "‹ 2/3 ›", first in the message's action row
// and always visible. The buttons are aria-disabled (never natively disabled, so a focused button keeps its focus)
// at the first / last version and while `disabled` (a request or a switch is in flight). ArrowLeft / ArrowRight
// anywhere inside the group select the enabled neighbor. `select` names the version to show, never the current one.
import { ChevronLeftIcon, ChevronRightIcon } from '@lucide/vue'
import { computed } from 'vue'
import { Button } from '@/components/ui/button'
import { testIds } from '~/utils/testids'

const props = withDefaults(defineProps<{
  /** `MessageBranch.siblings`: every version of the message (at least 2), in `seq` order. */
  siblings: readonly string[]
  /** `MessageBranch.index`: position of the shown version (0-based). */
  index: number
  /** A request or a switch is in flight: both buttons are aria-disabled. */
  disabled?: boolean
}>(), {
  disabled: false,
})

const emit = defineEmits<{ select: [messageId: string] }>()

const count = computed(() => props.siblings.length)
const position = computed(() => Math.min(Math.max(props.index, 0), Math.max(count.value - 1, 0)))
const canPrevious = computed(() => !props.disabled && position.value > 0)
const canNext = computed(() => !props.disabled && position.value < count.value - 1)

function select(step: -1 | 1) {
  if (!(step < 0 ? canPrevious.value : canNext.value))
    return
  const target = props.siblings[position.value + step]
  if (target)
    emit('select', target)
}

function onKeydown(event: KeyboardEvent) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
    return
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')
    return
  event.preventDefault()
  select(event.key === 'ArrowLeft' ? -1 : 1)
}

const buttonClass = 'text-muted-foreground hover:text-foreground aria-disabled:pointer-events-none aria-disabled:opacity-50 pointer-coarse:size-10'
</script>

<template>
  <div
    role="group"
    aria-label="Message versions"
    :data-testid="testIds.messageBranch"
    :data-message-id="siblings[position]"
    :data-index="position"
    :data-count="count"
    class="flex shrink-0 items-center text-muted-foreground"
    @keydown="onKeydown"
  >
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label="Previous version"
      :aria-disabled="canPrevious ? undefined : true"
      :data-testid="testIds.messageBranchPrevious"
      :class="buttonClass"
      @click="select(-1)"
    >
      <ChevronLeftIcon class="size-3.5" />
    </Button>
    <span
      :data-testid="testIds.messageBranchCounter"
      aria-hidden="true"
      class="min-w-7 px-0.5 text-center text-xs tabular-nums select-none"
    >{{ position + 1 }}/{{ count }}</span>
    <span class="sr-only">Version {{ position + 1 }} of {{ count }}</span>
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label="Next version"
      :aria-disabled="canNext ? undefined : true"
      :data-testid="testIds.messageBranchNext"
      :class="buttonClass"
      @click="select(1)"
    >
      <ChevronRightIcon class="size-3.5" />
    </Button>
  </div>
</template>
