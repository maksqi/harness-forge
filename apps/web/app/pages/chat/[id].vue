<script setup lang="ts">
// An existing chat (docs/UI.md 2.1, 5.6-5.9, 6): ChatHeader (with the chat's project, 7.20) + ChatView; "Chat not
// found" for malformed ids (the API would answer 400) and for unknown ones (ChatView shows it on 404). Marks the chat
// as the open one, which clears its unread dot. The document title is the chat title (the route announcer reads it).
// Never renders its own <main> (the layout's SidebarInset is).
// Phase 8 (ADR-037): ChatView sits inside ChatWorkspace, which adds the changes panel of a project chat; its project is
// the session's, the registry lookup the title uses too.
import { chatIdSchema } from '@harness-forge/shared'
import { computed, onBeforeUnmount, watch } from 'vue'
import ChatHeader from '~/components/chat/ChatHeader.vue'
import ChatNotFound from '~/components/chat/ChatNotFound.vue'
import ChatView from '~/components/chat/ChatView.vue'
import { useRoute } from '~/components/chat/nuxt-imports'
import ChatWorkspace from '~/components/workspace/ChatWorkspace.vue'
import { useHead } from '~/components/workspace/nuxt-imports'
import { useChatSessionRegistry } from '~/composables/useChatSession'
import { useChatsStore } from '~/stores/chats'
import { useUiStore } from '~/stores/ui'

const route = useRoute()
const ui = useUiStore()
const chats = useChatsStore()
const sessions = useChatSessionRegistry()

const chatId = computed(() => {
  const id = route.params.id
  return typeof id === 'string' ? id : ''
})
const validId = computed(() => chatIdSchema.safeParse(chatId.value).success)

watch(chatId, () => ui.setActiveChat(validId.value ? chatId.value : null), { immediate: true })

const pageTitle = computed(() => {
  // `ids` makes the title follow a session that registers after this computed first ran.
  void sessions.ids.value
  const session = sessions.get(chatId.value)
  if (!validId.value || session?.notFound.value)
    return 'Chat not found'
  return chats.byId(chatId.value)?.title?.trim() || session?.summary.value?.title?.trim() || 'New chat'
})
useHead({ title: computed(() => `${pageTitle.value} · harness-forge`) })

/** The chat's project for ChatWorkspace (null until the session knows one). */
const projectId = computed(() => {
  void sessions.ids.value
  return sessions.get(chatId.value)?.projectId.value ?? null
})
onBeforeUnmount(() => {
  if (ui.activeChatId === chatId.value)
    ui.setActiveChat(null)
})
</script>

<template>
  <ChatWorkspace v-if="validId" :chat-id="chatId" :project-id="projectId">
    <ChatView :key="chatId" :chat-id="chatId">
      <template #header="{ scrolled, title, loading, projectId: headerProjectId }">
        <ChatHeader :chat-id="chatId" :title="title" :scrolled="scrolled" :loading="loading" :project-id="headerProjectId" />
      </template>
    </ChatView>
  </ChatWorkspace>
  <div v-else class="flex min-h-dvh flex-1 flex-col">
    <ChatNotFound />
  </div>
</template>
