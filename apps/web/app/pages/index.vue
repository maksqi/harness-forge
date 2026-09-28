<script setup lang="ts">
// New chat (docs/UI.md 2.2, 6, 7.13): greeting, the "Connect a provider" callout while nothing is usable, and the
// composer of a fresh chat id. The first send moves to /chat/<id>; the session and its stream stay alive in the
// registry, so the transcript continues there. Never renders its own <main> (the layout's SidebarInset is).
import { computed } from 'vue'
import ChatGreeting from '~/components/chat/ChatGreeting.vue'
import ChatView from '~/components/chat/ChatView.vue'
import NoProviderCallout from '~/components/chat/NoProviderCallout.vue'
import { useRouter } from '~/components/chat/nuxt-imports'
import { releaseDraftChatId, useDraftChatId } from '~/composables/useChatSession'
import { useProvidersStore } from '~/stores/providers'

const router = useRouter()
const providers = useProvidersStore()

const chatId = useDraftChatId()
const showCallout = computed(() => providers.loaded && !providers.hasUsableProvider)

function onCreated(id: string) {
  releaseDraftChatId(id)
  void router.replace(`/chat/${id}`)
}
</script>

<template>
  <ChatView :chat-id="chatId" is-new @created="onCreated">
    <template #empty>
      <ChatGreeting />
      <NoProviderCallout v-if="showCallout" />
    </template>
  </ChatView>
</template>
