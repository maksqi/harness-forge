<script setup lang="ts">
// STUB (C5). W2.2 replaces this page: ChatHeader + ChatView of an existing chat, "Chat not found" on 404
// (docs/UI.md 2.1, 5.6-5.9, 6). Never renders its own <main> (the layout's SidebarInset is).
import { chatIdSchema } from '@harness-forge/shared'
import { MessageSquareOffIcon } from '@lucide/vue'
import { computed, onBeforeUnmount, watch } from 'vue'
import { useRoute } from '#imports'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { SidebarTrigger, useSidebar } from '@/components/ui/sidebar'
import { useChatsStore } from '~/stores/chats'
import { useUiStore } from '~/stores/ui'
import { testIds } from '~/utils/testids'

const route = useRoute()
const chats = useChatsStore()
const ui = useUiStore()
const sidebar = useSidebar(null)

const chatId = computed(() => {
  const id = route.params.id
  return typeof id === 'string' ? id : ''
})
// A malformed id can never exist (the API answers 400): show the not-found state right away.
const validId = computed(() => chatIdSchema.safeParse(chatId.value).success)
const title = computed(() => chats.byId(chatId.value)?.title ?? 'New chat')
const showTrigger = computed(() => !!sidebar && (sidebar.isMobile.value || sidebar.state.value === 'collapsed'))

watch(chatId, () => ui.setActiveChat(validId.value ? chatId.value : null), { immediate: true })
onBeforeUnmount(() => {
  if (ui.activeChatId === chatId.value)
    ui.setActiveChat(null)
})
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <template v-if="validId">
      <header
        :data-testid="testIds.chatHeader"
        class="sticky top-0 z-10 flex h-(--header-height) shrink-0 items-center gap-2 border-b border-transparent bg-background px-4"
      >
        <SidebarTrigger
          v-if="showTrigger"
          :data-testid="testIds.sidebarTrigger"
          aria-label="Toggle sidebar"
          class="-ml-2 text-muted-foreground hover:text-foreground"
        />
        <h1 :data-testid="testIds.chatTitle" class="min-w-0 truncate text-base font-medium">
          {{ title }}
        </h1>
      </header>
      <div
        :data-testid="testIds.transcript"
        role="log"
        aria-live="off"
        class="hf-scroll-stable flex min-h-0 flex-1 flex-col overflow-y-auto"
      >
        <div class="hf-transcript mx-auto w-full max-w-3xl px-4 py-6 text-muted-foreground md:px-6">
          Messages appear here.
        </div>
      </div>
    </template>

    <Empty v-else :data-testid="testIds.chatNotFound" class="flex-1">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <MessageSquareOffIcon aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>Chat not found</EmptyTitle>
        <EmptyDescription>It may have been deleted.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button as-child variant="outline" size="sm">
          <NuxtLink to="/">
            New chat
          </NuxtLink>
        </Button>
      </EmptyContent>
    </Empty>
  </div>
</template>
