<script setup lang="ts">
// App sidebar (docs/UI.md 5.1, 5.2): brand, Chat | Plugins mode tabs (hidden in settings), the nav of the current
// mode, footer with Settings and the theme toggle. Remembers the last route per mode for the tabs and
// "Back to app". Icon mode (collapsed) keeps icons only; below md the sidebar is a sheet that closes on
// navigation. Contract: no props, no emits.
import { SettingsIcon } from '@lucide/vue'
import { computed, watch } from 'vue'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'
import { testIds } from '~/utils/testids'
import AppBrand from './AppBrand.vue'
import ChatNav from './ChatNav.vue'
import ModeTabs from './ModeTabs.vue'
import { modeOfPath, rememberRoute, sanitizeLastRoutes, useLastRoutes } from './navigation'
import { useRoute } from './nuxt-imports'
import PluginsNav from './PluginsNav.vue'
import SettingsNav from './SettingsNav.vue'
import { SIDEBAR_ROW_CLASS } from './sidebar-classes'
import ThemeToggle from './ThemeToggle.vue'

const route = useRoute()
const lastRoutes = useLastRoutes()
const { state, isMobile, openMobile, setOpenMobile } = useSidebar()

const mode = computed(() => modeOfPath(route.path))
const iconMode = computed(() => state.value === 'collapsed' && !isMobile.value)
const dataState = computed(() => {
  if (isMobile.value)
    return openMobile.value ? 'expanded' : 'collapsed'
  return state.value
})

watch(() => route.fullPath, (fullPath) => {
  lastRoutes.value = rememberRoute(sanitizeLastRoutes(lastRoutes.value), fullPath)
  if (isMobile.value)
    setOpenMobile(false)
}, { immediate: true })
</script>

<template>
  <Sidebar collapsible="icon" variant="sidebar" class="border-sidebar-border">
    <div
      :data-testid="testIds.sidebar"
      :data-state="dataState"
      :data-mode="mode"
      class="flex min-h-0 w-full flex-1 flex-col"
    >
      <SidebarHeader :class="cn('gap-3', iconMode && 'items-center gap-2')">
        <AppBrand />
        <ModeTabs v-if="mode !== 'settings'" />
      </SidebarHeader>

      <SidebarContent class="gap-0">
        <SettingsNav v-if="mode === 'settings'" />
        <PluginsNav v-else-if="mode === 'plugins'" />
        <ChatNav v-else />
      </SidebarContent>

      <SidebarFooter :class="cn('pb-3', iconMode ? 'items-center gap-1' : 'flex-row items-center gap-2')">
        <SidebarMenu v-if="mode !== 'settings'" :class="cn(!iconMode && 'min-w-0 flex-1')">
          <SidebarMenuItem>
            <SidebarMenuButton
              as-child
              tooltip="Settings"
              :data-testid="testIds.settingsLink"
              :class="SIDEBAR_ROW_CLASS"
            >
              <NuxtLink to="/settings/providers">
                <SettingsIcon aria-hidden="true" />
                <span>Settings</span>
              </NuxtLink>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <div :class="cn('flex shrink-0', !iconMode && 'ml-auto')">
          <ThemeToggle :collapsed="iconMode" />
        </div>
      </SidebarFooter>
    </div>
  </Sidebar>
</template>
