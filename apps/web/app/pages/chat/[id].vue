<script setup lang="ts">
// An existing chat (docs/UI.md 2.1, 5.6-5.9, 6): ChatHeader + ChatView; "Chat not found" for malformed ids (the
// API would answer 400) and for unknown ones (ChatView shows it on 404). Marks the chat as the open one, which
// clears its unread dot. Never renders its own <main> (the layout's SidebarInset is).
import { chatIdSchema } from '@harness-forge/shared'
import { computed, onBeforeUnmount, watch } from 'vue'
import ChatHeader from '~/components/chat/ChatHeader.vue'
import ChatNotFound from '~/components/chat/ChatNotFound.vue'
import ChatView from '~/components/chat/ChatView.vue'
import { useRoute } from '~/components/chat/nuxt-imports'
import { useUiStore } from '~/stores/ui'

const route = useRoute()
const ui = useUiStore()

const chatId = computed(() => {
  const id = route.params.id
  return typeof id === 'string' ? id : ''
})
const validId = computed(() => chatIdSchema.safeParse(chatId.value).success)

watch(chatId, () => ui.setActiveChat(validId.value ? chatId.value : null), { immediate: true })
onBeforeUnmount(() => {
  if (ui.activeChatId === chatId.value)
    ui.setActiveChat(null)
})
</script>

<template>
  <ChatView v-if="validId" :key="chatId" :chat-id="chatId">
    <template #header="{ scrolled, title, loading }">
      <ChatHeader :chat-id="chatId" :title="title" :scrolled="scrolled" :loading="loading" />
    </template>
  </ChatView>
  <div v-else class="flex min-h-dvh flex-1 flex-col">
    <ChatNotFound />
  </div>
</template>
