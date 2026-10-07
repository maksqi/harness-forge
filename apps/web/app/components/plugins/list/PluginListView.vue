<script setup lang="ts">
// Content of /plugins (docs/UI.md 2.3, 8.1, 8.2): PageHeader "Plugins" with search (synced to `?q=`), "Install…" (the
// single InstallDialog of pages/plugins.vue) and "New plugin"; the `?filter=` of the sidebar (below md a select) and
// the PluginCard grid. Card switches enable or disable plugins, "View logs" opens the Logs tab and "Review" opens
// TrustDialog (W3.2) for untrusted plugins. A safe-mode banner shows when the server loads builtins only.
// Phase 12 (ADR-054; W12.9): when a listed plugin came from a marketplace, the marketplace list is loaded (at most 15 s
// old: the stored catalogs, no network), so the cards show their update badges even when the sidebar is closed.
import type { PluginSummary } from '@harness-forge/shared'
import type { PluginFilter } from '~/stores/plugins'
import { BlocksIcon, ChevronDownIcon, CircleAlertIcon, DownloadIcon, PlusIcon, SearchIcon, ShieldAlertIcon, XIcon } from '@lucide/vue'
import { useMediaQuery } from '@vueuse/core'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { errorTitle } from '~/components/common/harness-error'
import PageHeader from '~/components/common/PageHeader.vue'
import { useApi } from '~/composables/useApi'
import { useMarketplacesStore } from '~/stores/marketplaces'
import { parsePluginFilter, usePluginsStore } from '~/stores/plugins'
import { useUiStore } from '~/stores/ui'
import { isAbortError, toHarnessError } from '~/utils/errors'
import { testIds } from '~/utils/testids'
import { rememberListRoute } from './list-route'
import { navigateTo, useHead, useRoute, useRouter } from './nuxt-imports'
import { countLabel, pluginDetailRoute, pluginFilterLabel, sortPluginsByName } from './plugin-display'
import PluginFilterSelect from './PluginFilterSelect.vue'
import PluginGrid from './PluginGrid.vue'
import PluginNewMenu from './PluginNewMenu.vue'

const plugins = usePluginsStore()
const marketplaces = useMarketplacesStore()
const ui = useUiStore()
const api = useApi()
const route = useRoute()
const router = useRouter()
const wide = useMediaQuery('(min-width: 768px)')

useHead({ title: 'Plugins · harness-forge' })

const loading = ref(false)
const loadError = ref<unknown>(null)
const safeMode = ref(false)
const trustTarget = ref<string | null>(null)
const trustOpen = ref(false)

// ---------- filter and search (route query) ----------

function queryText(value: unknown): string {
  const raw = Array.isArray(value) ? value[0] : value
  return typeof raw === 'string' ? raw : ''
}

const filter = computed(() => parsePluginFilter(route.query.filter))
const search = ref(queryText(route.query.q))

watch(() => route.query.q, (value) => {
  const next = queryText(value)
  if (next.trim() !== search.value.trim())
    search.value = next
})

// The search reaches `?q=` 200 ms after the last keystroke; leaving the page cancels a pending update, so it can
// never land on another route.
let searchTimer: ReturnType<typeof setTimeout> | undefined

function syncSearch(value: string) {
  const q = value.trim()
  if (route.path !== '/plugins' || q === queryText(route.query.q).trim())
    return
  const { q: _q, ...rest } = route.query
  router.replace({ query: q ? { ...rest, q } : rest }).catch(() => {})
}

watch(search, (value) => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(syncSearch, 200, value)
})
onBeforeUnmount(() => clearTimeout(searchTimer))

watch(() => route.fullPath, rememberListRoute, { immediate: true })

// Same order as the sidebar's installed list: builtins first, then by name.
const results = computed(() => sortPluginsByName(plugins.filtered(filter.value, search.value)))
const filtering = computed(() => filter.value !== 'all' || search.value.trim() !== '')

function setFilter(value: PluginFilter) {
  const { filter: _filter, ...rest } = route.query
  router.replace({ query: value === 'all' ? rest : { ...rest, filter: value } }).catch(() => {})
}

function clearFilters() {
  search.value = ''
  router.replace({ path: '/plugins' }).catch(() => {})
}

// ---------- loading ----------

async function load() {
  loading.value = true
  loadError.value = null
  try {
    await plugins.fetchAll()
  }
  catch (error) {
    if (!isAbortError(error))
      loadError.value = error
  }
  finally {
    loading.value = false
  }
}

/** Marketplace plugins: the list holds their updates (a failure stays quiet; the cards show no badge). */
const MARKETPLACES_MAX_AGE_MS = 15_000
watch(() => plugins.items.some(plugin => plugin.source === 'marketplace'), (any) => {
  if (any)
    marketplaces.fetchAll({ maxAgeMs: MARKETPLACES_MAX_AGE_MS }).catch(() => {})
}, { immediate: true })

onMounted(() => {
  if (!plugins.loaded)
    void load()
  api.health.get()
    .then((health) => {
      safeMode.value = health.safeMode
    })
    .catch(() => {})
})

const loadMessage = computed(() => (loadError.value ? toHarnessError(loadError.value).message : ''))

// ---------- card actions ----------

async function setEnabled(plugin: PluginSummary, value: boolean) {
  try {
    const next = value ? await plugins.enable(plugin.id) : await plugins.disable(plugin.id)
    if (value && next.state === 'error')
      toast.error(`${next.name} could not start`, { description: next.lastError?.message })
    else if (value && next.state === 'untrusted')
      toast(`${next.name} needs your trust`, { description: 'Review and trust it to run its code.' })
  }
  catch (error) {
    const failure = toHarnessError(error)
    toast.error(errorTitle(failure), { description: failure.message })
  }
}

function viewLogs(plugin: PluginSummary) {
  void navigateTo(pluginDetailRoute(plugin.id, 'logs'))
}

function review(plugin: PluginSummary) {
  trustTarget.value = plugin.id
  trustOpen.value = true
}

function onTrusted() {
  trustOpen.value = false
}
</script>

<template>
  <div class="hf-scroll-stable h-dvh min-h-0 overflow-y-auto">
    <div class="mx-auto flex w-full max-w-5xl flex-col px-4 pb-16 md:px-6">
      <PageHeader title="Plugins" description="Providers, tools, MCP servers and commands for your chats.">
        <template #actions>
          <InputGroup v-if="wide" class="h-8 w-56 lg:w-64">
            <InputGroupAddon>
              <SearchIcon aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput
              v-model="search"
              type="search"
              placeholder="Search plugins…"
              class="[&::-webkit-search-cancel-button]:appearance-none"
              aria-label="Search plugins"
              autocomplete="off"
              :data-testid="testIds.pluginsSearch"
              @keydown.esc="search = ''"
            />
            <InputGroupAddon v-if="search" align="inline-end">
              <InputGroupButton size="icon-xs" aria-label="Clear search" @click="search = ''">
                <XIcon aria-hidden="true" />
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label="Install…"
            :data-testid="testIds.pluginsInstall"
            @click="ui.openInstall()"
          >
            <DownloadIcon aria-hidden="true" data-icon="inline-start" />
            <span class="max-sm:sr-only">Install…</span>
          </Button>
          <PluginNewMenu align="end">
            <Button type="button" size="sm" :data-testid="testIds.pluginsNew">
              <PlusIcon aria-hidden="true" data-icon="inline-start" />
              <span class="max-sm:sr-only">New plugin</span>
              <ChevronDownIcon aria-hidden="true" data-icon="inline-end" class="opacity-80" />
            </Button>
          </PluginNewMenu>
        </template>
        <div v-if="!wide" class="flex items-center gap-2 pt-1 pb-2">
          <InputGroup class="min-w-0 flex-1">
            <InputGroupAddon>
              <SearchIcon aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput
              v-model="search"
              type="search"
              placeholder="Search plugins…"
              class="[&::-webkit-search-cancel-button]:appearance-none"
              aria-label="Search plugins"
              autocomplete="off"
              :data-testid="testIds.pluginsSearch"
              @keydown.esc="search = ''"
            />
          </InputGroup>
          <PluginFilterSelect :model-value="filter" :counts="plugins.loaded ? plugins.counts : null" class="w-36 shrink-0" @update:model-value="setFilter" />
        </div>
      </PageHeader>

      <div class="flex flex-col gap-4 pt-4">
        <Alert v-if="safeMode" class="border-warning/40 bg-warning/5 dark:bg-warning/10">
          <ShieldAlertIcon aria-hidden="true" class="text-warning" />
          <AlertTitle>Safe mode</AlertTitle>
          <AlertDescription class="text-foreground/80">
            Only builtin plugins are loaded. Restart the server without HF_SAFE_MODE to load your plugins.
          </AlertDescription>
        </Alert>

        <Alert v-if="loadError && !plugins.loaded" class="border-destructive/35 bg-destructive/5 dark:bg-destructive/10">
          <CircleAlertIcon aria-hidden="true" class="text-destructive" />
          <AlertTitle>Could not load plugins</AlertTitle>
          <AlertDescription class="text-foreground/80">
            {{ loadMessage }}
          </AlertDescription>
          <div class="col-start-2 mt-2">
            <Button type="button" size="sm" variant="outline" :disabled="loading" @click="load">
              Retry
            </Button>
          </div>
        </Alert>

        <template v-else>
          <div v-if="plugins.loaded" class="flex min-h-6 flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground" aria-live="polite">
            <span class="tabular-nums">
              <template v-if="filtering">{{ results.length }} of {{ countLabel(plugins.items.length, 'plugin') }}</template>
              <template v-else>{{ countLabel(plugins.items.length, 'plugin') }}</template>
            </span>
            <template v-if="filtering">
              <span aria-hidden="true">·</span>
              <span v-if="filter !== 'all'" class="font-medium text-foreground">{{ pluginFilterLabel(filter) }}</span>
              <span v-if="search.trim()" class="max-w-60 truncate">“{{ search.trim() }}”</span>
              <Button type="button" variant="link" size="xs" class="h-auto px-1 text-muted-foreground hover:text-foreground" @click="clearFilters">
                Clear filters
              </Button>
            </template>
          </div>

          <PluginGrid
            v-if="!plugins.loaded || results.length > 0"
            :plugins="results"
            :loading="!plugins.loaded"
            @update:enabled="setEnabled"
            @view-logs="viewLogs"
            @review="review"
          />

          <Empty v-else class="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <BlocksIcon aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>No plugins match</EmptyTitle>
              <EmptyDescription>
                Try another search, or show every plugin.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button type="button" size="sm" variant="outline" @click="clearFilters">
                Clear filters
              </Button>
            </EmptyContent>
          </Empty>
        </template>
      </div>
    </div>

    <TrustDialog
      v-if="trustTarget"
      v-model:open="trustOpen"
      :plugin-id="trustTarget"
      @trusted="onTrusted"
    />
  </div>
</template>
