<script setup lang="ts">
// Action row under a message (docs/UI.md 7.5): Copy, Regenerate (last assistant message) or Edit (user messages),
// then the meta slot. Fixed 28px height and always laid out, so revealing it never moves the transcript.
import { PencilIcon, RotateCcwIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import CopyButton from '~/components/common/CopyButton.vue'
import { testIds } from '~/utils/testids'

withDefaults(defineProps<{
  /** Text copied by "Copy" (resolved on click). */
  copyText: () => string
  canRegenerate?: boolean
  canEdit?: boolean
  align?: 'start' | 'end'
}>(), {
  canRegenerate: false,
  canEdit: false,
  align: 'start',
})

const emit = defineEmits<{ regenerate: [], edit: [] }>()

defineSlots<{ default?: () => any }>()
</script>

<template>
  <div
    data-slot="message-actions"
    :class="cn('flex h-7 min-w-0 items-center gap-0.5 text-muted-foreground', align === 'end' && 'justify-end')"
  >
    <CopyButton :text="copyText" :data-testid="testIds.messageCopy" />
    <Tooltip v-if="canRegenerate">
      <TooltipTrigger as-child>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Regenerate"
          :data-testid="testIds.messageRegenerate"
          class="text-muted-foreground hover:text-foreground"
          @click="emit('regenerate')"
        >
          <RotateCcwIcon class="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Regenerate</TooltipContent>
    </Tooltip>
    <Tooltip v-if="canEdit">
      <TooltipTrigger as-child>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Edit"
          :data-testid="testIds.messageEdit"
          class="text-muted-foreground hover:text-foreground"
          @click="emit('edit')"
        >
          <PencilIcon class="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Edit</TooltipContent>
    </Tooltip>
    <slot />
  </div>
</template>
