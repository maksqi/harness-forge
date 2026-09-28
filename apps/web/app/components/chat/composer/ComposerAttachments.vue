<script setup lang="ts">
// Attachment chips of the composer (docs/UI.md 7.7): image thumbnails and file chips with upload states (spinner,
// destructive + Retry, X to remove), then the capability warnings ("… can't see images") under the chips.
import type { ComposerAttachment } from '~/composables/useComposerAttachments'
import { TriangleAlertIcon } from '@lucide/vue'
import FileChip from '~/components/common/FileChip.vue'
import { testIds } from '~/utils/testids'

defineProps<{
  items: ComposerAttachment[]
  warnings: string[]
}>()

const emit = defineEmits<{
  remove: [id: string]
  retry: [id: string]
}>()
</script>

<template>
  <div class="flex w-full flex-col gap-2">
    <div v-if="items.length > 0" class="flex flex-wrap items-end gap-2">
      <FileChip
        v-for="item in items"
        :key="item.id"
        :data-testid="testIds.composerAttachment"
        :data-mime="item.mime"
        :name="item.name"
        :size="item.size"
        :mime="item.mime"
        :url="item.previewUrl"
        :state="item.state"
        removable
        @remove="emit('remove', item.id)"
        @retry="emit('retry', item.id)"
      />
    </div>
    <p
      v-for="warning in warnings"
      :key="warning"
      role="status"
      class="flex items-start gap-1.5 text-xs text-muted-foreground"
    >
      <TriangleAlertIcon aria-hidden="true" class="mt-px size-3.5 shrink-0 text-warning" />
      <span>{{ warning }}</span>
    </p>
  </div>
</template>
