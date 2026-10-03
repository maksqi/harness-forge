<script setup lang="ts">
// Attachment chips of the composer (docs/UI.md 7.7): image thumbnails and file chips with upload states (spinner,
// destructive + Retry, X to remove), then the capability warnings ("… can't see images") under the chips.
// Phase 9 (ADR-042; UI.md 7.26, 10.6): every chip carries `data-kind`: `upload`, or `project` for a file attached
// through an `@` mention, which also carries `data-path` and shows `FileCode`, the base name and the full path in a
// tooltip. A project chip and its `@path` text are independent (removing one keeps the other).
import type { ComposerAttachment } from '~/composables/useComposerAttachments'
import { CircleAlertIcon, FileCodeIcon, TriangleAlertIcon, XIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
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
      <template v-for="item in items" :key="item.id">
        <div
          v-if="item.source === 'project'"
          :data-testid="testIds.composerAttachment"
          data-kind="project"
          :data-path="item.path"
          :data-mime="item.mime || undefined"
          data-slot="file-chip"
          :data-state="item.state"
          :class="cn(
            'inline-flex h-9 max-w-64 min-w-0 items-center gap-2 rounded-md border bg-card pr-1 pl-2.5 text-sm',
            item.state === 'error' && 'border-destructive/70',
          )"
        >
          <Spinner v-if="item.state === 'uploading'" class="text-muted-foreground" />
          <CircleAlertIcon v-else-if="item.state === 'error'" aria-hidden="true" class="size-4 shrink-0 text-destructive" />
          <FileCodeIcon v-else aria-hidden="true" class="size-4 shrink-0 text-muted-foreground" />
          <Tooltip>
            <TooltipTrigger as-child>
              <span class="min-w-0 truncate" data-slot="file-chip-name">{{ item.name }}</span>
            </TooltipTrigger>
            <TooltipContent side="top">
              {{ item.path }}
            </TooltipContent>
          </Tooltip>
          <span class="sr-only">, {{ item.path }}</span>
          <Button
            v-if="item.state === 'error'"
            type="button"
            size="xs"
            variant="ghost"
            class="text-destructive"
            @click="emit('retry', item.id)"
          >
            Retry
          </Button>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            :aria-label="`Remove ${item.name}`"
            class="text-muted-foreground hover:text-foreground"
            @click="emit('remove', item.id)"
          >
            <XIcon />
          </Button>
        </div>
        <FileChip
          v-else
          :data-testid="testIds.composerAttachment"
          :data-mime="item.mime"
          data-kind="upload"
          :name="item.name"
          :size="item.size > 0 ? item.size : undefined"
          :mime="item.mime"
          :url="item.previewUrl"
          :state="item.state"
          removable
          @remove="emit('remove', item.id)"
          @retry="emit('retry', item.id)"
        />
      </template>
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
