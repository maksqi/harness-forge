<script setup lang="ts">
// Content of /plugins/[id] (docs/UI.md 2.4, 6, 8.7-8.11): loads the plugin detail, renders PluginHeader and the tabs
// synced with `?tab=`: Overview · Configuration (plugins with a settings schema) · Source (PluginSourceTab, W3.4: code
// plugins, read-only unless editable, and editable declarative plugins) · Logs. A missing or hidden tab falls back to
// Overview. Configuration and Source stay mounted once opened, so switching tabs keeps unsaved edits. The page has
// its own scroll area with a stable scrollbar gutter.
// Phase 12 (ADR-054; C46 mounts, W12.9 owns it in P12-A): PluginUpdateBanner above the tabs while a marketplace offers
// another version (`useMarketplacesStore().updateOf(pluginId)`); Update… opens MarketplaceInstallDialog in update mode.
// W12.9: a plugin installed from a marketplace loads the marketplace list (at most 15 s old: the stored catalogs, no
// network) so its banner shows even when the sidebar is closed; after the update the list is fetched again.
import type { PluginTab } from './plugin-detail'
import { BlocksIcon, CircleAlertIcon } from '@lucide/vue'
import { computed, onMounted, ref, watch } from 'vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useMarketplacesStore } from '~/stores/marketplaces'
import { usePluginsStore } from '~/stores/plugins'
import { hasErrorCode, isAbortError, toHarnessError } from '~/utils/errors'
import { testIds } from '~/utils/testids'
import { lastListRoute } from '../list/list-route'
import { useHead, useRoute, useRouter } from '../list/nuxt-imports'
import MarketplaceInstallDialog from '../marketplaces/MarketplaceInstallDialog.vue'
import { hasSourceTab, PLUGIN_TAB_LABELS, pluginTabs, resolvePluginTab } from './plugin-detail'
import PluginConfigurationTab from './PluginConfigurationTab.vue'
import PluginHeader from './PluginHeader.vue'
import PluginLogsTab from './PluginLogsTab.vue'
import PluginOverviewTab from './PluginOverviewTab.vue'
import PluginUpdateBanner from './PluginUpdateBanner.vue'

const props = defineProps<{ pluginId: string }>()

const plugins = usePluginsStore()
const marketplaces = useMarketplacesStore()
const route = useRoute()
const router = useRouter()

const loading = ref(false)
const loadError = ref<unknown>(null)
const notFound = ref(false)
/** The detail arrived at least once (a later absence means the plugin was uninstalled). */
const seen = ref(false)

const detail = computed(() => plugins.details[props.pluginId] ?? null)
const summary = computed(() => plugins.byId(props.pluginId) ?? null)
const gone = computed(() => notFound.value || (seen.value && !detail.value && !loading.value))

const tabs = computed<PluginTab[]>(() => (detail.value ? pluginTabs(detail.value) : ['overview', 'logs']))
const activeTab = computed(() => resolvePluginTab(route.query.tab, tabs.value))
const TAB_TEST_IDS: Record<PluginTab, string> = {
  overview: testIds.pluginTabOverview,
  configuration: testIds.pluginTabConfiguration,
  source: testIds.pluginTabSource,
  logs: testIds.pluginTabLogs,
}

/** Tabs whose content stays mounted after the first visit (unsaved form and editor state). */
const visited = ref<Set<PluginTab>>(new Set())
watch(activeTab, (tab) => {
  if ((tab === 'configuration' || tab === 'source') && !visited.value.has(tab))
    visited.value = new Set([...visited.value, tab])
}, { immediate: true })

useHead({ title: computed(() => `${detail.value?.name ?? summary.value?.name ?? 'Plugin'} · harness-forge`) })

async function load() {
  loading.value = true
  loadError.value = null
  notFound.value = false
  try {
    await plugins.fetchOne(props.pluginId)
    seen.value = true
  }
  catch (error) {
    if (isAbortError(error))
      return
    if (hasErrorCode(error, 'not_found'))
      notFound.value = true
    else
      loadError.value = error
  }
  finally {
    loading.value = false
  }
}

onMounted(load)
watch(() => props.pluginId, () => {
  seen.value = false
  visited.value = new Set()
  void load()
})

function setTab(value: unknown) {
  const tab = resolvePluginTab(value, tabs.value)
  if (tab === activeTab.value && route.query.tab === (tab === 'overview' ? undefined : tab))
    return
  const { tab: _tab, ...query } = route.query
  router.replace({ query: tab === 'overview' ? query : { ...query, tab } }).catch(() => {})
}

const loadMessage = computed(() => (loadError.value ? toHarnessError(loadError.value).message : ''))

/** Phase 12: the update a marketplace offers for this plugin, and the update dialog. */
const update = computed(() => marketplaces.updateOf(props.pluginId))
const updateMarketplace = computed(() => (update.value ? marketplaces.byId(update.value.marketplaceId)?.name ?? null : null))
const updateOpen = ref(false)
const sourceReadonly = computed(() => !detail.value?.editable)

/** A marketplace plugin: the list holds its update (answered from the stored catalogs; failures stay quiet). */
const LIST_MAX_AGE_MS = 15_000
watch(() => detail.value?.source === 'marketplace', (fromMarketplace) => {
  if (fromMarketplace)
    marketplaces.fetchAll({ maxAgeMs: LIST_MAX_AGE_MS }).catch(() => {})
}, { immediate: true })

function onUpdated() {
  updateOpen.value = false
  marketplaces.fetchAll().catch(() => {})
}
</script>

<template>
  <div
    :data-testid="testIds.pluginDetail"
    :data-plugin-id="pluginId"
    :data-state="detail?.state ?? summary?.state"
    class="hf-scroll-stable h-dvh min-h-0 overflow-y-auto"
  >
    <div class="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 pb-16 md:px-6">
      <template v-if="detail">
        <PluginHeader :plugin="detail" @view-logs="setTab('logs')" />
        <PluginUpdateBanner :update="update" :marketplace-name="updateMarketplace" @update="updateOpen = true" />
        <MarketplaceInstallDialog
          v-model:open="updateOpen"
          :marketplace-id="update?.marketplaceId ?? null"
          :entry-name="update?.plugin ?? null"
          mode="update"
          @installed="onUpdated"
        />

        <Tabs :model-value="activeTab" class="gap-6" @update:model-value="setTab">
          <div class="-mx-4 overflow-x-auto border-b px-4 md:-mx-6 md:px-6">
            <TabsList variant="line" aria-label="Plugin sections" class="h-10 gap-4 p-0">
              <TabsTrigger
                v-for="tab in tabs"
                :key="tab"
                :value="tab"
                :data-testid="TAB_TEST_IDS[tab]"
                class="h-10 flex-none rounded-none px-0.5 after:bottom-0! after:bg-primary"
              >
                {{ PLUGIN_TAB_LABELS[tab] }}
              </TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="overview">
            <PluginOverviewTab :plugin="detail" />
          </TabsContent>
          <TabsContent
            v-if="tabs.includes('configuration')"
            value="configuration"
            :force-mount="visited.has('configuration') || undefined"
            class="data-[state=inactive]:hidden"
          >
            <PluginConfigurationTab :plugin-id="pluginId" />
          </TabsContent>
          <TabsContent
            v-if="hasSourceTab(detail)"
            value="source"
            :force-mount="visited.has('source') || undefined"
            class="data-[state=inactive]:hidden"
          >
            <LazyPluginSourceTab :plugin-id="pluginId" :readonly="sourceReadonly" />
          </TabsContent>
          <TabsContent value="logs">
            <PluginLogsTab :plugin-id="pluginId" />
          </TabsContent>
        </Tabs>
      </template>

      <Empty v-else-if="gone" class="mt-16 border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <BlocksIcon aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>Plugin not found</EmptyTitle>
          <EmptyDescription>No plugin has the id "{{ pluginId }}". It may have been uninstalled.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button as-child size="sm" variant="outline">
            <NuxtLink :to="lastListRoute()">
              Back to plugins
            </NuxtLink>
          </Button>
        </EmptyContent>
      </Empty>

      <Alert v-else-if="loadError" class="mt-16 border-destructive/35 bg-destructive/5 dark:bg-destructive/10">
        <CircleAlertIcon aria-hidden="true" class="text-destructive" />
        <AlertTitle>Could not load the plugin</AlertTitle>
        <AlertDescription class="text-foreground/80">
          {{ loadMessage }}
        </AlertDescription>
        <div class="col-start-2 mt-2">
          <Button type="button" size="sm" variant="outline" :disabled="loading" @click="load">
            Retry
          </Button>
        </div>
      </Alert>

      <div v-else aria-busy="true" aria-label="Loading plugin" class="flex flex-col gap-6">
        <Skeleton class="mt-4 h-4 w-20" />
        <div class="flex items-center gap-3.5">
          <Skeleton class="size-9 rounded-lg" />
          <div class="flex flex-col gap-2">
            <Skeleton class="h-5 w-48" />
            <Skeleton class="h-4 w-36" />
          </div>
        </div>
        <Skeleton class="h-10 w-full" />
        <Skeleton class="h-40 w-full rounded-xl" />
      </div>
    </div>
  </div>
</template>
