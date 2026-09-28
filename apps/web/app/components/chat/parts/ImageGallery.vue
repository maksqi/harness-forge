<script setup lang="ts">
// Generated images of an assistant message (docs/UI.md 2.11, 7.16, 10.4; ADR-028): one gallery block of consecutive
// image/* file parts (chat-format.ts block 'gallery'), also rendered by SharedMessage on the share page, so it uses no
// store. One image spans the column (at most 70dvh, object-contain); two to four sit in a two-column grid. Each tile
// (image-tile, data-index) is a button "Open image {n} of {m}" that opens the lightbox (image-lightbox, data-index)
// with Previous image / Next image and the same-origin Download link (image-download); URLs go through safeAssetUrl.
// Contract (docs/UI.md 10.4): props below; no emits; root image-gallery with data-message-id and data-count.
// Stub (C12, P6-0b): implemented by W6.8 in P6-A; props are frozen.
import type { FileUIPart } from 'ai'
import { testIds } from '~/utils/testids'

defineProps<{
  /**
   * Consecutive image/* file parts in part order; url /api/files/<id> (share page: /api/share/<token>/files/<id>);
   * filename optional.
   */
  images: readonly FileUIPart[]
  /** The message holding them (share page: its generated key). */
  messageId: string
}>()
</script>

<template>
  <div
    :data-testid="testIds.imageGallery"
    :data-message-id="messageId"
    :data-count="images.length"
    class="grid gap-2"
  />
</template>
