<script setup lang="ts">
// STUB (C3). W2.4 replaces this file: date-grouped chat list from the chats store, status dots, row menu,
// inline rename, delete with undo, infinite scroll (docs/UI.md 5.3). Contract: no props, no emits; renders
// inside <SidebarContent> and never renders its own <Sidebar>.
import { SearchIcon, SquarePenIcon } from '@lucide/vue'
import { h } from 'vue'
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'
import KbdCombo from '~/components/common/KbdCombo.vue'
import { testIds } from '~/utils/testids'
import { SIDEBAR_KBD_CLASS, SIDEBAR_ROW_CLASS } from './sidebar-classes'

function tooltip(label: string, keys: string) {
  return () => h('span', { class: 'inline-flex items-center gap-2' }, [label, h(KbdCombo, { keys })])
}

const newChatTooltip = tooltip('New chat', 'mod+shift+o')
const searchTooltip = tooltip('Search', 'mod+k')

// Stub wiring until the ui store exists: the CommandPalette stub listens for this event.
function openSearch() {
  window.dispatchEvent(new CustomEvent('hf:open-command-palette'))
}
</script>

<template>
  <nav aria-label="Chats" class="flex min-h-0 flex-1 flex-col">
    <SidebarGroup class="pb-0">
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton as-child :tooltip="newChatTooltip" :data-testid="testIds.newChat" :class="SIDEBAR_ROW_CLASS">
            <NuxtLink to="/">
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
            @click="openSearch"
          >
            <SearchIcon aria-hidden="true" />
            <span>Search</span>
            <KbdCombo keys="mod+k" :class="SIDEBAR_KBD_CLASS" />
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarGroup>

    <SidebarGroup class="min-h-0 flex-1 group-data-[collapsible=icon]:hidden">
      <SidebarGroupContent :data-testid="testIds.chatList" class="px-2 py-1.5">
        <p class="text-xs text-muted-foreground">
          No chats yet
        </p>
      </SidebarGroupContent>
    </SidebarGroup>
  </nav>
</template>
