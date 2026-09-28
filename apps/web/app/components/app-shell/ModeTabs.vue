<script setup lang="ts">
// Chat | Plugins switch driven by the route (docs/UI.md 5.1, 5.2). The tabs are links to the last route of each
// mode, so middle-click works. Expanded sidebar: segmented Tabs; icon mode: two stacked icon buttons. On touch
// devices (coarse pointer) the list grows to 44px, so the tabs inside its 2px padding are 40px targets (UI.md 14.5).
import { BlocksIcon, MessageSquareIcon } from '@lucide/vue'
import { computed } from 'vue'
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { testIds } from '~/utils/testids'
import { modeOfPath, sanitizeLastRoutes, useLastRoutes } from './navigation'
import { navigateTo, useRoute } from './nuxt-imports'
import { SIDEBAR_ROW_CLASS } from './sidebar-classes'

const route = useRoute()
const lastRoutes = useLastRoutes()
const { state, isMobile } = useSidebar()

const mode = computed(() => modeOfPath(route.path))
const routes = computed(() => sanitizeLastRoutes(lastRoutes.value))
const iconMode = computed(() => state.value === 'collapsed' && !isMobile.value)

const tabs = computed(() => [
  { value: 'chat' as const, label: 'Chat', icon: MessageSquareIcon, to: routes.value.chat, testId: testIds.modeTabChat },
  { value: 'plugins' as const, label: 'Plugins', icon: BlocksIcon, to: routes.value.plugins, testId: testIds.modeTabPlugins },
])

// Enter follows the link natively; Space is the other tab activation key.
function onSpace(to: string) {
  void navigateTo(to)
}
</script>

<template>
  <SidebarMenu v-if="iconMode" aria-label="Sidebar mode">
    <SidebarMenuItem v-for="tab in tabs" :key="tab.value">
      <SidebarMenuButton
        as-child
        :is-active="mode === tab.value"
        :tooltip="tab.label"
        :data-testid="tab.testId"
        :data-state="mode === tab.value ? 'active' : 'inactive'"
        :class="SIDEBAR_ROW_CLASS"
      >
        <NuxtLink :to="tab.to" :aria-current="mode === tab.value ? 'page' : undefined">
          <component :is="tab.icon" aria-hidden="true" />
          <span>{{ tab.label }}</span>
        </NuxtLink>
      </SidebarMenuButton>
    </SidebarMenuItem>
  </SidebarMenu>

  <Tabs v-else :model-value="mode" activation-mode="manual" class="w-full gap-0">
    <TabsList aria-label="Sidebar mode" class="h-8 w-full rounded-lg bg-sidebar-accent/60 p-0.5 dark:bg-sidebar-accent/70 pointer-coarse:h-11">
      <TabsTrigger
        v-for="tab in tabs"
        :key="tab.value"
        :value="tab.value"
        as-child
        class="h-full rounded-md border-0 text-[13px] font-medium text-muted-foreground hover:text-foreground data-active:bg-background data-active:text-foreground data-active:shadow-xs dark:text-muted-foreground dark:data-active:border-transparent dark:data-active:bg-muted dark:data-active:text-foreground"
      >
        <NuxtLink :to="tab.to" :data-testid="tab.testId" @keydown.space.prevent="onSpace(tab.to)">
          {{ tab.label }}
        </NuxtLink>
      </TabsTrigger>
    </TabsList>
  </Tabs>
</template>
