<script setup lang="ts">
// Attachment chip (docs/UI.md 7.1, 7.7): images with a URL render a 64px thumbnail, everything else a chip with
// name and size. Upload states: `uploading` (spinner), `error` (destructive border + Retry), `done`.
// Pass data-testid (file-chip / composer-attachment) through attributes; the root carries data-state.
import { CircleAlertIcon, FileTextIcon, ImageIcon, XIcon } from '@lucide/vue'
import { computed } from 'vue'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { formatBytes, safeAssetUrl } from './format'

const props = withDefaults(defineProps<{
  name: string
  size?: number
  mime?: string
  url?: string
  state?: 'uploading' | 'error' | 'done'
  removable?: boolean
}>(), {
  state: 'done',
  removable: false,
})

const emit = defineEmits<{
  remove: []
  retry: []
  open: []
}>()

const isImageType = computed(() => props.mime?.startsWith('image/') ?? false)
const imageUrl = computed(() => (isImageType.value ? safeAssetUrl(props.url) : null))
const sizeLabel = computed(() => (props.size === undefined ? '' : formatBytes(props.size)))
</script>

<template>
  <div
    v-if="imageUrl"
    data-slot="file-chip"
    :data-state="state"
    :class="cn(
      'group/file relative size-16 shrink-0 rounded-md',
      state === 'error' && 'ring-2 ring-destructive/70',
    )"
  >
    <button
      type="button"
      :aria-label="`Open ${name}`"
      :disabled="state !== 'done'"
      class="block size-full overflow-hidden rounded-md border bg-muted outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      @click="emit('open')"
    >
      <img
        :src="imageUrl"
        :alt="name"
        loading="lazy"
        decoding="async"
        referrerpolicy="no-referrer"
        class="size-full object-cover"
      >
    </button>
    <div
      v-if="state === 'uploading'"
      class="pointer-events-none absolute inset-0 grid place-items-center rounded-md bg-background/60"
    >
      <Spinner class="text-muted-foreground" />
    </div>
    <div
      v-else-if="state === 'error'"
      class="absolute inset-0 grid place-items-center rounded-md bg-background/75"
    >
      <Button type="button" size="xs" variant="ghost" class="text-destructive" @click="emit('retry')">
        Retry
      </Button>
    </div>
    <button
      v-if="removable"
      type="button"
      :aria-label="`Remove ${name}`"
      class="absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full border bg-popover text-muted-foreground opacity-0 shadow-sm outline-none transition-opacity duration-(--duration-fast) group-hover/file:opacity-100 group-focus-within/file:opacity-100 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:opacity-100"
      @click="emit('remove')"
    >
      <XIcon class="size-3" />
    </button>
  </div>
  <div
    v-else
    data-slot="file-chip"
    :data-state="state"
    :class="cn(
      'inline-flex h-9 max-w-64 min-w-0 items-center gap-2 rounded-md border bg-card pr-1 pl-2.5 text-sm',
      state === 'error' && 'border-destructive/70',
      !removable && state !== 'error' && 'pr-2.5',
    )"
  >
    <Spinner v-if="state === 'uploading'" class="text-muted-foreground" />
    <CircleAlertIcon v-else-if="state === 'error'" aria-hidden="true" class="size-4 shrink-0 text-destructive" />
    <ImageIcon v-else-if="isImageType" aria-hidden="true" class="size-4 shrink-0 text-muted-foreground" />
    <FileTextIcon v-else aria-hidden="true" class="size-4 shrink-0 text-muted-foreground" />
    <button
      type="button"
      :disabled="state !== 'done'"
      class="min-w-0 truncate rounded-sm text-left outline-none enabled:hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
      :title="name"
      @click="emit('open')"
    >
      {{ name }}
    </button>
    <span v-if="sizeLabel" class="shrink-0 text-xs text-muted-foreground tabular-nums">{{ sizeLabel }}</span>
    <Button v-if="state === 'error'" type="button" size="xs" variant="ghost" class="text-destructive" @click="emit('retry')">
      Retry
    </Button>
    <Button
      v-if="removable"
      type="button"
      size="icon-xs"
      variant="ghost"
      :aria-label="`Remove ${name}`"
      class="text-muted-foreground hover:text-foreground"
      @click="emit('remove')"
    >
      <XIcon />
    </Button>
  </div>
</template>
