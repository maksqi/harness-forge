<script setup lang="ts">
// STUB (C3). W3.1 replaces this file: New plugin menu, Install... (ui.openInstall()), browse filters with counts
// from the plugins store and the installed list with status dots (docs/UI.md 5.4). Contract: no props, no emits;
// renders inside <SidebarContent> and never renders its own <Sidebar>.
import { ChevronDownIcon, DownloadIcon, PackagePlusIcon } from '@lucide/vue'
import { computed } from 'vue'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'
import { testIds } from '~/utils/testids'
import { useRoute } from './nuxt-imports'
import { SIDEBAR_ROW_CLASS } from './sidebar-classes'

const route = useRoute()

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'providers', label: 'Providers' },
  { value: 'tools', label: 'Tools' },
  { value: 'mcp', label: 'MCP servers' },
  { value: 'commands', label: 'Commands' },
  { value: 'disabled', label: 'Disabled' },
] as const

const activeFilter = computed(() => {
  if (route.path !== '/plugins')
    return null
  const filter = route.query.filter
  return typeof filter === 'string' && FILTERS.some(item => item.value === filter) ? filter : 'all'
})

function filterRoute(value: string) {
  return value === 'all' ? '/plugins' : { path: '/plugins', query: { filter: value } }
}
</script>

<template>
  <nav aria-label="Plugins" class="flex min-h-0 flex-1 flex-col">
    <SidebarGroup class="pb-0">
      <SidebarMenu>
        <SidebarMenuItem>
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <SidebarMenuButton tooltip="New plugin" :data-testid="testIds.pluginsNew" :class="SIDEBAR_ROW_CLASS">
                <PackagePlusIcon aria-hidden="true" />
                <span>New plugin</span>
                <ChevronDownIcon aria-hidden="true" class="ml-auto size-3.5! opacity-60 group-data-[collapsible=icon]:hidden" />
              </SidebarMenuButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" class="w-48">
              <DropdownMenuItem as-child :data-testid="testIds.pluginsNewProvider">
                <NuxtLink :to="{ path: '/plugins/new', query: { type: 'provider' } }">
                  Provider
                </NuxtLink>
              </DropdownMenuItem>
              <DropdownMenuItem as-child :data-testid="testIds.pluginsNewCode">
                <NuxtLink :to="{ path: '/plugins/new', query: { type: 'code' } }">
                  Code plugin
                </NuxtLink>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuButton as-child tooltip="Install…" :data-testid="testIds.pluginsInstall" :class="SIDEBAR_ROW_CLASS">
            <NuxtLink to="/plugins">
              <DownloadIcon aria-hidden="true" />
              <span>Install…</span>
            </NuxtLink>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarGroup>

    <SidebarGroup class="group-data-[collapsible=icon]:hidden">
      <SidebarGroupLabel>Browse</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          <SidebarMenuItem v-for="filter in FILTERS" :key="filter.value">
            <SidebarMenuButton
              as-child
              :is-active="activeFilter === filter.value"
              :data-testid="testIds.pluginsFilter"
              :data-value="filter.value"
              :class="SIDEBAR_ROW_CLASS"
            >
              <NuxtLink :to="filterRoute(filter.value)">
                <span>{{ filter.label }}</span>
              </NuxtLink>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  </nav>
</template>
