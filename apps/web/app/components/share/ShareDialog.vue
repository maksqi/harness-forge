<script setup lang="ts">
// Share dialog (docs/UI.md 2.8, 7.14, ADR-025): the read-only links of one chat. W5.6 builds the body (link cards, the
// new-link form); this Phase 5 skeleton (C9) fixes the mount and the binding to the ui store.
// Contract (docs/UI.md 10.4): no props, no emits; mounted once by layouts/default.vue; open while ui.shareChatId is
// set (ui.openShare(chatId) from "Share…" in the chat menus); closing calls ui.closeShare().
import { computed } from 'vue'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useUiStore } from '~/stores/ui'
import { testIds } from '~/utils/testids'

const ui = useUiStore()

const open = computed({
  get: () => ui.shareChatId !== null,
  set: (value: boolean) => {
    if (!value)
      ui.closeShare()
  },
})
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent
      :data-testid="testIds.shareDialog"
      :data-chat-id="ui.shareChatId ?? undefined"
      class="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg"
    >
      <DialogHeader>
        <DialogTitle>Share chat</DialogTitle>
        <DialogDescription>
          Anyone with a link can read a snapshot of this chat. Messages you add later are not shared until you update
          the snapshot.
        </DialogDescription>
      </DialogHeader>
    </DialogContent>
  </Dialog>
</template>
