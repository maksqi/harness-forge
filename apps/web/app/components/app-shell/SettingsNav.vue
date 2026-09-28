<script setup lang="ts">
// Settings mode sidebar content (docs/UI.md 5.5): "Back to app" (to the last non-settings route), then the
// settings pages. Rendered inside <SidebarContent> by AppSidebar.
import { ArrowLeftIcon } from '@lucide/vue'
import { computed } from 'vue'
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'
import { testIds } from '~/utils/testids'
import { sanitizeLastRoutes, SETTINGS_LINKS, useLastRoutes } from './navigation'
import { useRoute } from './nuxt-imports'
import { SIDEBAR_ROW_CLASS } from './sidebar-classes'

const route = useRoute()
const lastRoutes = useLastRoutes()
const backTo = computed(() => sanitizeLastRoutes(lastRoutes.value).app)

function isActive(to: string) {
  return route.path === to || route.path.startsWith(`${to}/`)
}
</script>

<template>
  <nav aria-label="Settings" class="flex flex-col">
    <SidebarGroup class="pb-3">
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            as-child
            tooltip="Back to app"
            :data-testid="testIds.backToApp"
            :class="SIDEBAR_ROW_CLASS"
          >
            <NuxtLink :to="backTo">
              <ArrowLeftIcon aria-hidden="true" />
              <span>Back to app</span>
            </NuxtLink>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarGroup>
    <SidebarGroup class="pt-1">
      <SidebarGroupContent>
        <SidebarMenu>
          <SidebarMenuItem v-for="link in SETTINGS_LINKS" :key="link.key">
            <SidebarMenuButton
              as-child
              :is-active="isActive(link.to)"
              :tooltip="link.label"
              :data-testid="link.testId"
              :data-state="isActive(link.to) ? 'active' : 'inactive'"
              :class="SIDEBAR_ROW_CLASS"
            >
              <NuxtLink :to="link.to">
                <component :is="link.icon" aria-hidden="true" />
                <span>{{ link.label }}</span>
              </NuxtLink>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  </nav>
</template>
