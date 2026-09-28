<script setup lang="ts">
// Generated images of an assistant message (docs/UI.md 2.11, 7.16, 10.4; ADR-028): one gallery block of consecutive
// image/* file parts (chat-format.ts block 'gallery'), also rendered by SharedMessage on the share page, so it uses no
// store. One image spans the column (at most 70dvh, object-contain); two to four sit in a two-column grid, each tile at
// its image's aspect ratio. Each tile (image-tile, data-index) is a button "Open image {n} of {m}" that opens the
// lightbox (image-lightbox, data-index; the FilePart dialog pattern, at most 90vw x 85dvh) with Previous image / Next
// image (ArrowLeft / ArrowRight, aria-disabled at the ends), the counter "2 / 4" and the same-origin Download link
// (image-download, named by the part's filename, else image-<n>.<ext>). Esc closes; focus returns to the tile the
// lightbox was opened from. URLs go through safeAssetUrl; images whose URL is not safe are left out.
// Contract (docs/UI.md 10.4): props below; no emits; root image-gallery with data-message-id and data-count.
import type { FileUIPart } from 'ai'
import { ChevronLeftIcon, ChevronRightIcon, DownloadIcon, XIcon } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { testIds } from '~/utils/testids'
import { galleryImages } from './image-gallery'

const props = defineProps<{
  /**
   * Consecutive image/* file parts in part order; url /api/files/<id> (share page: /api/share/<token>/files/<id>);
   * filename optional.
   */
  images: readonly FileUIPart[]
  /** The message holding them (share page: its generated key). */
  messageId: string
}>()

const tiles = computed(() => galleryImages(props.images))
const count = computed(() => tiles.value.length)
const single = computed(() => count.value === 1)

const open = ref(false)
const index = ref(0)
/** The tile the lightbox was opened from: focus goes back to it on close. */
const openedFrom = ref(0)
const tileElements: Array<HTMLElement | null> = []

const shown = computed(() => tiles.value[index.value] ?? null)
const canPrevious = computed(() => index.value > 0)
const canNext = computed(() => index.value < count.value - 1)

function setTile(element: unknown, position: number) {
  tileElements[position] = element instanceof HTMLElement ? element : null
}

function openAt(position: number) {
  index.value = position
  openedFrom.value = position
  open.value = true
}

function previous() {
  if (canPrevious.value)
    index.value -= 1
}

function next() {
  if (canNext.value)
    index.value += 1
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'ArrowLeft') {
    event.preventDefault()
    previous()
  }
  else if (event.key === 'ArrowRight') {
    event.preventDefault()
    next()
  }
}

/** Opening lands on Next image (or Download) rather than on a Previous image that cannot be used yet. */
function onOpenAutoFocus(event: Event) {
  const content = event.target instanceof HTMLElement ? event.target : null
  const target = content?.querySelector<HTMLElement>(canNext.value ? '[data-action="next"]' : '[data-action="download"]')
  if (target) {
    event.preventDefault()
    target.focus()
  }
}

function onCloseAutoFocus(event: Event) {
  const tile = tileElements[openedFrom.value]
  if (tile) {
    event.preventDefault()
    tile.focus()
  }
}

// Images can change while the lightbox is open (a streaming turn adds them, a version switch replaces them).
watch(count, (value) => {
  if (value === 0)
    open.value = false
  else if (index.value >= value)
    index.value = value - 1
})

const NAV_BUTTON_CLASS = 'text-muted-foreground hover:text-foreground aria-disabled:pointer-events-none aria-disabled:opacity-50 pointer-coarse:size-10'
</script>

<template>
  <div
    :data-testid="testIds.imageGallery"
    :data-message-id="messageId"
    :data-count="count"
    :class="cn('grid min-w-0 gap-2', !single && 'grid-cols-2')"
  >
    <button
      v-for="(tile, position) in tiles"
      :key="position"
      :ref="element => setTile(element, position)"
      type="button"
      :data-testid="testIds.imageTile"
      :data-index="position"
      :aria-label="tile.label"
      class="relative block w-full min-w-0 cursor-zoom-in self-start overflow-hidden rounded-lg border bg-muted outline-none transition-shadow duration-(--duration-fast) hover:ring-2 hover:ring-ring/40 focus-visible:ring-2 focus-visible:ring-ring/60"
      @click="openAt(position)"
    >
      <img
        :src="tile.url"
        :alt="tile.alt"
        loading="lazy"
        decoding="async"
        referrerpolicy="no-referrer"
        :class="single ? 'block h-auto max-h-[70dvh] w-full object-contain' : 'block h-auto w-full'"
      >
    </button>

    <Dialog v-if="count > 0" v-model:open="open">
      <DialogContent
        :data-testid="testIds.imageLightbox"
        :data-index="index"
        :show-close-button="false"
        class="flex max-h-[85dvh] w-auto max-w-[90vw] min-w-72 flex-col gap-2 p-2 sm:max-w-[90vw] sm:p-3"
        @keydown="onKeydown"
        @open-auto-focus="onOpenAutoFocus"
        @close-auto-focus="onCloseAutoFocus"
      >
        <DialogTitle class="sr-only">
          {{ shown?.alt }}
        </DialogTitle>
        <DialogDescription class="sr-only">
          {{ count > 1 ? 'Use the arrow keys to see the other images.' : 'A generated image.' }}
        </DialogDescription>
        <div class="flex min-w-0 items-center gap-1">
          <template v-if="count > 1">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              data-action="previous"
              aria-label="Previous image"
              :aria-disabled="canPrevious ? undefined : 'true'"
              :class="NAV_BUTTON_CLASS"
              @click="previous"
            >
              <ChevronLeftIcon aria-hidden="true" />
            </Button>
            <span aria-live="polite" class="min-w-12 text-center text-sm text-muted-foreground tabular-nums">
              <span aria-hidden="true">{{ index + 1 }} / {{ count }}</span>
              <span class="sr-only">Image {{ index + 1 }} of {{ count }}</span>
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              data-action="next"
              aria-label="Next image"
              :aria-disabled="canNext ? undefined : 'true'"
              :class="NAV_BUTTON_CLASS"
              @click="next"
            >
              <ChevronRightIcon aria-hidden="true" />
            </Button>
          </template>
          <Button v-if="shown?.downloadUrl" as-child variant="outline" size="sm" class="ml-auto pointer-coarse:h-10">
            <a
              :href="shown.downloadUrl"
              :download="shown.downloadName"
              :data-testid="testIds.imageDownload"
              data-action="download"
            >
              <DownloadIcon aria-hidden="true" data-icon="inline-start" />
              Download
            </a>
          </Button>
          <DialogClose as-child>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Close"
              :class="cn('text-muted-foreground hover:text-foreground pointer-coarse:size-10', !shown?.downloadUrl && 'ml-auto')"
            >
              <XIcon aria-hidden="true" />
            </Button>
          </DialogClose>
        </div>
        <img
          v-if="shown"
          :key="shown.url"
          :src="shown.url"
          :alt="shown.alt"
          referrerpolicy="no-referrer"
          class="mx-auto block max-h-[calc(85dvh-4.5rem)] min-h-0 w-auto max-w-full rounded-md object-contain"
        >
      </DialogContent>
    </Dialog>
  </div>
</template>
