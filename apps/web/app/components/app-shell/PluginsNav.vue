<script setup lang="ts">
// Plugins mode sidebar content (docs/UI.md 5.4): "New plugin" (Provider / Code plugin), "Install…" (opens the
// single InstallDialog of pages/plugins.vue through ui.openInstall()), the Browse filters with counts from the
// plugins store (`/plugins?filter=`), and every installed plugin (builtins first, then by name) with its icon and
// state dot. Browse and Installed scroll together below the fixed rows and are hidden in icon mode. Contract: no
// props, no emits; renders inside <SidebarContent> and never renders its own <Sidebar>.
import { ChevronDownIcon, DownloadIcon, PackagePlusIcon } from '@lucide/vue'
import { computed, onMounted, ref } from 'vue'
import { Button } from '@/components/ui/button'
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  useSidebar,
} from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'
import StatusDot from '~/components/common/StatusDot.vue'
import {
  PLUGIN_FILTER_OPTIONS,
  PLUGIN_STATE_LABELS,
  pluginDetailRoute,
  pluginFilterRoute,
  pluginStateDot,
  sortPluginsByName,
} from '~/components/plugins/list/plugin-display'
import PluginIcon from '~/components/plugins/list/PluginIcon.vue'
import PluginNewMenu from '~/components/plugins/list/PluginNewMenu.vue'
import { parsePluginFilter, usePluginsStore } from '~/stores/plugins'
import { useUiStore } from '~/stores/ui'
import { isAbortError } from '~/utils/errors'
import { testIds } from '~/utils/testids'
import { useRoute } from './nuxt-imports'
import { SIDEBAR_ROW_CLASS } from './sidebar-classes'

const plugins = usePluginsStore()
const ui = useUiStore()
const route = useRoute()
const { isMobile, state, setOpenMobile } = useSidebar()

const loading = ref(false)
const loadFailed = ref(false)

const iconMode = computed(() => state.value === 'collapsed' && !isMobile.value)
const installed = computed(() => sortPluginsByName(plugins.items))

/** The filter of the list page, or null on other plugin pages. */
const activeFilter = computed(() => (route.path === '/plugins' ? parsePluginFilter(route.query.filter) : null))

/** Id of the plugin shown by /plugins/[id], if any (never the `new` page). */
const activePluginId = computed(() => {
  const match = route.path.match(/^\/plugins\/([^/]+)\/?$/)
  if (!match?.[1] || match[1] === 'new')
    return null
  try {
    return decodeURIComponent(match[1])
  }
  catch {
    return match[1]
  }
})

async function load() {
  loading.value = true
  loadFailed.value = false
  try {
    await plugins.fetchAll()
  }
  catch (error) {
    if (!isAbortError(error))
      loadFailed.value = true
  }
  finally {
    loading.value = false
  }
}

onMounted(() => {
  if (!plugins.loaded)
    void load()
})

function openInstall() {
  // On phones the sidebar is a sheet: close it so the dialog is the only layer.
  if (isMobile.value)
    setOpenMobile(false)
  ui.openInstall()
}
</script>

<template>
  <nav aria-label="Plugins" class="flex min-h-0 flex-1 flex-col">
    <SidebarGroup class="shrink-0 pb-1">
      <SidebarMenu>
        <SidebarMenuItem>
          <PluginNewMenu :side="iconMode ? 'right' : 'bottom'" align="start">
            <SidebarMenuButton tooltip="New plugin" :data-testid="testIds.pluginsNew" :class="SIDEBAR_ROW_CLASS">
              <PackagePlusIcon aria-hidden="true" />
              <span>New plugin</span>
              <ChevronDownIcon aria-hidden="true" class="ml-auto size-3.5! opacity-60 group-data-[collapsible=icon]:hidden" />
            </SidebarMenuButton>
          </PluginNewMenu>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuButton
            tooltip="Install…"
            :data-testid="testIds.pluginsInstall"
            :class="SIDEBAR_ROW_CLASS"
            @click="openInstall"
          >
            <DownloadIcon aria-hidden="true" />
            <span>Install…</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarGroup>

    <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-3 group-data-[collapsible=icon]:hidden">
      <SidebarGroup class="py-1">
        <SidebarGroupLabel>Browse</SidebarGroupLabel>
        <SidebarMenu class="gap-px">
          <SidebarMenuItem v-for="option in PLUGIN_FILTER_OPTIONS" :key="option.value">
            <SidebarMenuButton
              as-child
              :is-active="activeFilter === option.value"
              :data-testid="testIds.pluginsFilter"
              :data-value="option.value"
              :class="cn(SIDEBAR_ROW_CLASS, 'pr-9')"
            >
              <NuxtLink :to="pluginFilterRoute(option.value)">
                <component :is="option.icon" aria-hidden="true" />
                <span>{{ option.label }}</span>
              </NuxtLink>
            </SidebarMenuButton>
            <SidebarMenuBadge
              v-if="plugins.loaded"
              data-slot="plugins-filter-count"
              :data-value="option.value"
              :class="cn('top-1/2! -translate-y-1/2 font-normal text-sidebar-foreground/55', plugins.counts[option.value] === 0 && 'text-sidebar-foreground/35')"
            >
              {{ plugins.counts[option.value] }}
            </SidebarMenuBadge>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroup>

      <SidebarGroup class="py-1">
        <SidebarGroupLabel>Installed</SidebarGroupLabel>
        <div v-if="!plugins.loaded && !loadFailed" aria-hidden="true" class="flex flex-col gap-px">
          <SidebarMenuSkeleton v-for="n in 4" :key="n" show-icon class="h-(--row-height)" />
        </div>
        <div v-else-if="loadFailed && !plugins.loaded" class="flex items-center gap-1 py-1 pl-2 text-xs text-muted-foreground">
          <span class="min-w-0 flex-1 truncate">Couldn't load plugins</span>
          <Button type="button" variant="ghost" size="xs" class="text-foreground" :disabled="loading" @click="load">
            Retry
          </Button>
        </div>
        <p v-else-if="installed.length === 0" class="px-2 py-1.5 text-xs text-muted-foreground">
          No plugins yet
        </p>
        <SidebarMenu v-else class="gap-px">
          <SidebarMenuItem v-for="plugin in installed" :key="plugin.id">
            <SidebarMenuButton
              as-child
              :is-active="activePluginId === plugin.id"
              :data-testid="testIds.pluginNavRow"
              :data-plugin-id="plugin.id"
              :data-plugin-state="plugin.state"
              :class="cn(SIDEBAR_ROW_CLASS, 'pr-7')"
            >
              <NuxtLink :to="pluginDetailRoute(plugin.id)">
                <PluginIcon :plugin="plugin" size="sm" />
                <span :class="cn(!plugin.enabled && 'text-sidebar-foreground/55')">{{ plugin.name }}</span>
              </NuxtLink>
            </SidebarMenuButton>
            <div class="pointer-events-none absolute inset-y-0 right-1 flex items-center">
              <StatusDot :status="pluginStateDot(plugin.state)" :label="PLUGIN_STATE_LABELS[plugin.state]" />
            </div>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroup>
    </div>
  </nav>
</template>
