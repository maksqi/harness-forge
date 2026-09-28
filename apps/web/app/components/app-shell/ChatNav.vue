<script setup lang="ts">
// Chat mode sidebar content (docs/UI.md 5.3): "New chat" and "Search" rows, then the chats store's list grouped by
// date (Today, Yesterday, Previous 7 days, Previous 30 days, months) under sticky labels. Rows show the status dot
// (chats.statusOf) and an actions menu (Rename inline, Export, Delete with Undo). The list scrolls on its own
// below the fixed rows and loads the next cursor page when its end scrolls into view. Live `chat.*` / `run.*`
// events reach the rows through the store. Contract: no props, no emits; renders inside <SidebarContent> and never
// renders its own <Sidebar>.
import type { ChatExportFormat, ChatSummary } from '@harness-forge/shared'
import { SearchIcon, SquarePenIcon } from '@lucide/vue'
import { useIntersectionObserver } from '@vueuse/core'
import { computed, h, nextTick, onMounted, ref, useId, useTemplateRef, watch } from 'vue'
import { Button } from '@/components/ui/button'
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from '@/components/ui/sidebar'
import KbdCombo from '~/components/common/KbdCombo.vue'
import { useChatsStore } from '~/stores/chats'
import { useUiStore } from '~/stores/ui'
import { isAbortError } from '~/utils/errors'
import { testIds } from '~/utils/testids'
import { useChatActions } from './chat-nav/chat-actions'
import ChatNavRow from './chat-nav/ChatNavRow.vue'
import { useNewChat } from './chat-nav/new-chat'
import { useRoute } from './nuxt-imports'
import { SIDEBAR_KBD_CLASS, SIDEBAR_ROW_CLASS } from './sidebar-classes'

const CHAT_PATH = /^\/chat\/([^/]+)\/?$/

const chats = useChatsStore()
const ui = useUiStore()
const route = useRoute()
const newChat = useNewChat()
const actions = useChatActions()
const uid = useId()

const root = useTemplateRef<HTMLElement>('root')
const list = useTemplateRef<HTMLElement>('list')
const sentinel = useTemplateRef<HTMLElement>('sentinel')

/** The last page request failed; automatic loading pauses until Retry. */
const loadFailed = ref(false)
const sentinelVisible = ref(false)

/** Id of the chat shown by /chat/[id], if any. */
const activeChatId = computed(() => {
  const id = route.path.match(CHAT_PATH)?.[1]
  if (!id)
    return null
  try {
    return decodeURIComponent(id)
  }
  catch {
    return id
  }
})

const initialLoading = computed(() => !chats.loaded && !loadFailed.value)
const loadingMore = computed(() => chats.loaded && chats.loading)
const empty = computed(() => chats.loaded && !chats.hasMore && chats.items.length === 0)

function tooltip(label: string, keys: string) {
  return () => h('span', { class: 'inline-flex items-center gap-2' }, [label, h(KbdCombo, { keys })])
}

const newChatTooltip = tooltip('New chat', 'mod+shift+o')
const searchTooltip = tooltip('Search', 'mod+k')

/** Plain left clicks also focus the composer; modified clicks keep the browser's own link behavior. */
function onNewChatClick(event: MouseEvent) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
    return
  void newChat()
}

async function loadMore() {
  if (chats.loaded && !chats.hasMore)
    return
  loadFailed.value = false
  try {
    await chats.fetchPage()
  }
  catch (error) {
    if (!isAbortError(error))
      loadFailed.value = true
  }
}

onMounted(() => {
  if (!chats.loaded)
    void loadMore()
})

useIntersectionObserver(sentinel, (entries) => {
  sentinelVisible.value = entries.some(entry => entry.isIntersecting)
}, { root: list, rootMargin: '0px 0px 160px 0px' })

// Also fires again after each page while the end of the list stays visible, so a short list fills the view.
watch(
  () => sentinelVisible.value && chats.loaded && chats.hasMore && !chats.loading && !loadFailed.value,
  (ready) => {
    if (ready)
      void loadMore()
  },
)

function groupLabelId(index: number) {
  return `${uid}-group-${index}`
}

/** Deleting moves focus to the next row, else the previous one, else "New chat" (docs/UI.md 14.1). */
function focusAfterDelete(id: string | undefined) {
  const nav = root.value
  if (!nav)
    return
  const rows = Array.from(nav.querySelectorAll<HTMLElement>(`[data-testid="${testIds.chatRow}"]`))
  const target = (id ? rows.find(row => row.dataset.chatId === id) : undefined)
    ?? nav.querySelector<HTMLElement>(`[data-testid="${testIds.newChat}"]`)
  target?.focus()
}

function onDelete(chat: ChatSummary) {
  const rows = chats.groups.flatMap(group => group.chats)
  const index = rows.findIndex(row => row.id === chat.id)
  const neighbour = rows[index + 1] ?? rows[index - 1]
  actions.remove(chat.id)
  void nextTick(() => focusAfterDelete(neighbour?.id))
}

function onRename(chat: ChatSummary, title: string) {
  void actions.rename(chat.id, title)
}

function onExport(chat: ChatSummary, format: ChatExportFormat) {
  void actions.exportChat(chat.id, format)
}

function retry() {
  loadFailed.value = false
  void loadMore()
}
</script>

<template>
  <nav ref="root" aria-label="Chats" class="flex min-h-0 flex-1 flex-col">
    <SidebarGroup class="shrink-0 pb-1">
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton as-child :tooltip="newChatTooltip" :data-testid="testIds.newChat" :class="SIDEBAR_ROW_CLASS">
            <NuxtLink to="/" @click="onNewChatClick">
              <SquarePenIcon aria-hidden="true" />
              <span>New chat</span>
              <KbdCombo keys="mod+shift+o" :class="SIDEBAR_KBD_CLASS" />
            </NuxtLink>
          </SidebarMenuButton>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuButton
            :tooltip="searchTooltip"
            :data-testid="testIds.searchChats"
            :class="SIDEBAR_ROW_CLASS"
            @click="ui.openPalette()"
          >
            <SearchIcon aria-hidden="true" />
            <span>Search</span>
            <KbdCombo keys="mod+k" :class="SIDEBAR_KBD_CLASS" />
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarGroup>

    <SidebarGroup class="min-h-0 flex-1 p-0 group-data-[collapsible=icon]:hidden">
      <div
        ref="list"
        :data-testid="testIds.chatList"
        :aria-busy="chats.loading || undefined"
        class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3"
      >
        <div
          v-for="(group, index) in chats.groups"
          :key="group.label"
          role="group"
          :aria-labelledby="groupLabelId(index)"
          :data-testid="testIds.chatGroup"
          :data-value="group.label"
        >
          <SidebarGroupLabel :id="groupLabelId(index)" class="sticky top-0 z-10 bg-sidebar">
            {{ group.label }}
          </SidebarGroupLabel>
          <SidebarMenu class="gap-px">
            <ChatNavRow
              v-for="chat in group.chats"
              :key="chat.id"
              :chat="chat"
              :active="chat.id === activeChatId"
              :status="chats.statusOf(chat.id)"
              @rename="onRename(chat, $event)"
              @export="onExport(chat, $event)"
              @delete="onDelete(chat)"
            />
          </SidebarMenu>
        </div>

        <div v-if="initialLoading || loadingMore" aria-hidden="true" class="flex flex-col gap-px pt-2">
          <SidebarMenuSkeleton v-for="n in (initialLoading ? 8 : 3)" :key="n" class="h-(--row-height)" />
        </div>

        <p v-if="empty" class="px-2 py-1.5 text-xs text-muted-foreground">
          No chats yet
        </p>

        <div v-if="loadFailed" class="flex items-center gap-1 py-1 pl-2 text-xs text-muted-foreground">
          <span class="min-w-0 flex-1 truncate">{{ chats.loaded ? 'Couldn\'t load more chats' : 'Couldn\'t load chats' }}</span>
          <Button type="button" variant="ghost" size="xs" class="text-foreground" @click="retry">
            Retry
          </Button>
        </div>

        <div ref="sentinel" aria-hidden="true" class="h-px w-full" />
      </div>
    </SidebarGroup>
  </nav>
</template>
