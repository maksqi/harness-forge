<script setup lang="ts">
// `file` part (docs/UI.md 7.1): images as a 64px thumbnail that opens a lightbox, other files as a chip that opens
// the file (`/api/files/<id>`) in a new tab. Only same-origin and http(s) URLs are used (FileChip / safeAssetUrl).
import type { FileUIPart, ReasoningFileUIPart } from 'ai'
import { computed, ref } from 'vue'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import FileChip from '~/components/common/FileChip.vue'
import { safeAssetUrl } from '~/components/common/format'
import { testIds } from '~/utils/testids'

const props = defineProps<{ part: FileUIPart | ReasoningFileUIPart }>()

const lightboxOpen = ref(false)
const name = computed(() => ('filename' in props.part && props.part.filename) || 'Attachment')
const url = computed(() => safeAssetUrl(props.part.url))
const isImage = computed(() => props.part.mediaType.startsWith('image'))

function open() {
  if (!url.value)
    return
  if (isImage.value) {
    lightboxOpen.value = true
    return
  }
  window.open(url.value, '_blank', 'noopener,noreferrer')
}
</script>

<template>
  <FileChip
    :data-testid="testIds.fileChip"
    :name="name"
    :mime="part.mediaType"
    :url="url ?? undefined"
    @open="open"
  />
  <Dialog v-if="isImage && url" v-model:open="lightboxOpen">
    <DialogContent class="max-h-[90dvh] max-w-[min(90vw,64rem)] p-3 sm:max-w-[min(90vw,64rem)]">
      <DialogTitle class="sr-only">
        {{ name }}
      </DialogTitle>
      <DialogDescription class="sr-only">
        Attachment preview
      </DialogDescription>
      <img
        :src="url"
        :alt="name"
        referrerpolicy="no-referrer"
        class="mx-auto max-h-[80dvh] w-auto max-w-full rounded-md object-contain"
      >
    </DialogContent>
  </Dialog>
</template>
