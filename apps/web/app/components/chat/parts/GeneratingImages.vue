<script setup lang="ts">
// Placeholders of an image turn in flight (docs/UI.md 7.16, 10.4; ADR-028): while metadata.image is set and the
// message has no file part yet, `n` tiles at the requested aspect ratio (Auto = square; one full width, two to four in
// the grid), bg-muted with a shimmer (static under reduced motion), and the caption "Generating image… 12s" /
// "Generating 2 images… 12s" (seconds since startedAt, updated every second, never announced). The gallery replaces
// them once the files arrive.
// Contract (docs/UI.md 10.4): props below; no emits; root image-generating with data-count, aria-busy="true" and the
// sr-only text "Generating images".
// Stub (C12, P6-0b): implemented by W6.8 in P6-A; props are frozen.
import type { ImageAspectRatio } from '@harness-forge/shared'
import { testIds } from '~/utils/testids'

defineProps<{
  /** metadata.image.n: placeholder tiles, 1-4. */
  n: number
  /** metadata.image.aspectRatio; omitted (Auto) = square tiles. */
  aspectRatio?: ImageAspectRatio
  /** metadata.startedAt (epoch ms): the "Generating image… 12s" counter. */
  startedAt: number
}>()
</script>

<template>
  <div :data-testid="testIds.imageGenerating" :data-count="n" aria-busy="true" class="grid gap-2">
    <span class="sr-only">Generating images</span>
  </div>
</template>
