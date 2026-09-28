<script setup lang="ts">
// Placeholders of an image turn in flight (docs/UI.md 7.16, 10.4; ADR-028): while metadata.image is set and the
// message has no file part yet, `n` tiles at the requested aspect ratio (Auto = square; one full width, at most 70dvh
// tall like a single generated image, two to four in the two-column grid), bg-muted with a shimmer (static under
// reduced motion), and the caption "Generating image… 12s" / "Generating 2 images… 12s" (seconds since startedAt,
// updated every second, never announced). The gallery replaces them once the files arrive. Store-free.
// Contract (docs/UI.md 10.4): props below; no emits; root image-generating with data-count, aria-busy="true" and the
// sr-only text "Generating images".
import type { ImageAspectRatio } from '@harness-forge/shared'
import { LIMITS } from '@harness-forge/shared'
import { computed, onBeforeUnmount, ref } from 'vue'
import { cn } from '@/lib/utils'
import { testIds } from '~/utils/testids'
import { aspectRatioCss, generatingCaption } from './image-gallery'

const props = defineProps<{
  /** metadata.image.n: placeholder tiles, 1-4. */
  n: number
  /** metadata.image.aspectRatio; omitted (Auto) = square tiles. */
  aspectRatio?: ImageAspectRatio
  /** metadata.startedAt (epoch ms): the "Generating image… 12s" counter. */
  startedAt: number
}>()

const count = computed(() => Math.min(LIMITS.imagesPerTurnMax, Math.max(1, Math.round(props.n) || 1)))
const ratio = computed(() => aspectRatioCss(props.aspectRatio))

const now = ref(Date.now())
const timer = setInterval(() => {
  now.value = Date.now()
}, 1000)
onBeforeUnmount(() => clearInterval(timer))

const caption = computed(() => generatingCaption(count.value, now.value - props.startedAt))
</script>

<template>
  <div
    :data-testid="testIds.imageGenerating"
    :data-count="count"
    aria-busy="true"
    class="flex min-w-0 flex-col gap-2"
  >
    <span class="sr-only">Generating images</span>
    <p aria-live="off" data-slot="generating-caption" class="hf-shimmer-text text-sm tabular-nums">
      {{ caption }}
    </p>
    <div :class="cn('grid gap-2', count > 1 && 'grid-cols-2')">
      <div
        v-for="index in count"
        :key="index"
        data-slot="generating-tile"
        :style="{ aspectRatio: ratio }"
        :class="cn(
          'relative w-full min-w-0 overflow-hidden rounded-lg border bg-muted',
          count === 1 && 'max-h-[70dvh]',
        )"
      >
        <div
          aria-hidden="true"
          class="absolute inset-0 animate-hf-shimmer bg-linear-to-r from-transparent via-foreground/5 to-transparent bg-size-[200%_100%] motion-reduce:hidden"
        />
      </div>
    </div>
  </div>
</template>
