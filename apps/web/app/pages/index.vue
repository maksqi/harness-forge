<script setup lang="ts">
// New chat (docs/UI.md 2.2, 2.12, 6, 7.13, 7.20): greeting, the project picker under it (the project the first send
// carries; hidden while no project exists), the "Connect a provider" callout while nothing is usable, and the composer
// of a fresh chat id; the header only holds the sidebar trigger (mobile, collapsed sidebar). The first send moves to
// /chat/<id> once the server accepted it (its 2xx answer, ChatView's `created`; not the first chunk), and a message
// the server refused (a prompt hook's 409) leaves the page as it was; the session and its stream stay alive in the
// registry, so the transcript continues there. Never renders its own <main> (the layout's SidebarInset is).
import { computed } from 'vue'
import { useHead } from '#imports'
import ChatGreeting from '~/components/chat/ChatGreeting.vue'
import ChatView from '~/components/chat/ChatView.vue'
import NewChatHeader from '~/components/chat/NewChatHeader.vue'
import NoProviderCallout from '~/components/chat/NoProviderCallout.vue'
import { useRouter } from '~/components/chat/nuxt-imports'
import NewChatProjectPicker from '~/components/projects/NewChatProjectPicker.vue'
import { releaseDraftChatId, useDraftChatId } from '~/composables/useChatSession'
import { useProvidersStore } from '~/stores/providers'

const router = useRouter()
const providers = useProvidersStore()

useHead({ title: 'New chat · harness-forge' })

const chatId = useDraftChatId()
const showCallout = computed(() => providers.loaded && !providers.hasUsableProvider)

function onCreated(id: string) {
  releaseDraftChatId(id)
  void router.replace(`/chat/${id}`)
}
</script>

<template>
  <ChatView :chat-id="chatId" is-new @created="onCreated">
    <template #header>
      <NewChatHeader />
    </template>
    <template #empty="{ projectId, setProject }">
      <ChatGreeting>
        <NewChatProjectPicker :model-value="projectId" @update:model-value="setProject" />
      </ChatGreeting>
      <NoProviderCallout v-if="showCallout" />
    </template>
  </ChatView>
</template>
