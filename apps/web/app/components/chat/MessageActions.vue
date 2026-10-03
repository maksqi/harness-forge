<script setup lang="ts">
// Action row under a message (docs/UI.md 7.5, 10.4): Copy (hidden with `canCopy` false: a reply without text), the
// `after-copy` slot (Read aloud), Regenerate (every finished assistant message) or Edit (user messages), both hidden
// while the transcript is busy through its `data-busy`, Delete this version (a message with versions while nothing
// runs), then the meta slot. Fixed 28px height (40px touch targets on coarse pointers) and always laid out, so
// revealing it never moves the transcript. The version switcher sits before this row (ChatMessage), outside its hover
// fade.
// Phase 8 (C20 declares, W8.9 uses; frozen from Gate P8-0b): "Rewind files to here" (message-rewind, History) after Edit
// and before Delete this version, shown with `canRewind` and hidden like Edit while the transcript is busy.
import { HistoryIcon, PencilIcon, RotateCcwIcon, Trash2Icon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import CopyButton from '~/components/common/CopyButton.vue'
import { testIds } from '~/utils/testids'

withDefaults(defineProps<{
  /** Text copied by "Copy" (resolved on click). */
  copyText: () => string
  /** False hides Copy (a reply without text, e.g. images only). */
  canCopy?: boolean
  canRegenerate?: boolean
  canEdit?: boolean
  /** "Delete this version": the message has versions and nothing runs. */
  canDeleteVersion?: boolean
  /** + Phase 8: "Rewind files to here" (a user message followed by agent edits in a project chat); default false. */
  canRewind?: boolean
  align?: 'start' | 'end'
}>(), {
  canCopy: true,
  canRegenerate: false,
  canEdit: false,
  canDeleteVersion: false,
  canRewind: false,
  align: 'start',
})

const emit = defineEmits<{ 'regenerate': [], 'edit': [], 'delete-version': [], 'rewind': [] }>()

defineSlots<{
  /** Right after Copy (ReadAloudButton). */
  'after-copy'?: () => any
  /** The meta (MessageMeta). */
  'default'?: () => any
}>()

const iconButtonClass = 'text-muted-foreground hover:text-foreground pointer-coarse:size-10 group-data-[busy=true]/transcript:hidden'

function deleteVersion() {
  // eslint-disable-next-line vue/custom-event-name-casing -- contract name from docs/UI.md 10.4
  emit('delete-version')
}
</script>

<template>
  <div
    data-slot="message-actions"
    :class="cn('flex h-7 min-w-0 items-center gap-0.5 text-muted-foreground pointer-coarse:h-10', align === 'end' && 'justify-end')"
  >
    <CopyButton v-if="canCopy" :text="copyText" :data-testid="testIds.messageCopy" class="pointer-coarse:size-10" />
    <slot name="after-copy" />
    <Tooltip v-if="canRegenerate">
      <TooltipTrigger as-child>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Regenerate"
          :data-testid="testIds.messageRegenerate"
          :class="iconButtonClass"
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
          :class="iconButtonClass"
          @click="emit('edit')"
        >
          <PencilIcon class="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Edit</TooltipContent>
    </Tooltip>
    <Tooltip v-if="canRewind">
      <TooltipTrigger as-child>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Rewind files to here"
          :data-testid="testIds.messageRewind"
          :class="iconButtonClass"
          @click="emit('rewind')"
        >
          <HistoryIcon class="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Rewind files to here</TooltipContent>
    </Tooltip>
    <Tooltip v-if="canDeleteVersion">
      <TooltipTrigger as-child>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Delete this version"
          :data-testid="testIds.messageDeleteVersion"
          :class="iconButtonClass"
          @click="deleteVersion"
        >
          <Trash2Icon class="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Delete this version</TooltipContent>
    </Tooltip>
    <slot />
  </div>
</template>
