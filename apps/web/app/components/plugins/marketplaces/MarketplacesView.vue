<script setup lang="ts">
// Content of /plugins/marketplaces?m=&q=&category= (Phase 12, ADR-054; docs/UI.md 2.19, 6, 8.13, 10.9, 14): PageHeader
// "Marketplaces" ("Browse plugins from Claude Code marketplaces.") with Refresh all (`marketplace-refresh-all`; disabled
// without marketplaces) and Add marketplace… (`marketplace-add`), both icon-only below `sm`. Then the official suggestion
// (MarketplaceSuggestion: no request before its Add; the dismissal lives in `localStorage`), the chips (MarketplaceStrip,
// `?m=`: an unknown id reads as All and is dropped), the selected marketplace's source line ("refreshed {time}"), its last
// refresh error (`marketplace-error`, `data-code`: "Could not refresh {name}: {message}") above its last good entries,
// search (`marketplace-search`, `?q=`, 200 ms) and category (`marketplace-category`, `?category=`: an unknown one reads
// as All) over the entries (MarketplaceEntryRow, sorted by name; All names each row's marketplace), the empty states
// (`marketplace-empty`, `data-value` none | no-match | no-entries), MarketplaceAddDialog, MarketplaceInstallDialog
// (Install / Update; `installed` opens the plugin page) and the remove confirmation (`marketplace-remove-confirm`).
// Data from `useMarketplacesStore()`: `fetchAll({ maxAgeMs: 15_000 })` on mount, the shown marketplaces' details (All:
// every one, at most 4 requests at a time, single flight per id); a skeleton while they load, "Could not load the
// marketplaces" with Retry after a failure. Refresh and remove toast only on failure / success as 8.13 says.
// No props, no emits; the root test id is frozen from Gate P12-0b (C46 stub); implementation W12.8 (P12-A).
// W12.19 (docs/UI.md 14.5): below `sm` the icon-only header buttons are 40x40 px and the category select 40 px tall (a
// coarse pointer too): the frozen SelectTrigger's `data-[size=default]:h-9` is beaten only by a class on that attribute.
import type { AcceptableValue } from 'reka-ui'
import type { MarketplaceEntryView } from './marketplaces'
import { CircleAlertIcon, PlusIcon, RotateCwIcon, SearchIcon, StoreIcon, TriangleAlertIcon, XIcon } from '@lucide/vue'
import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref, shallowRef, useTemplateRef, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import ConfirmDialog from '~/components/common/ConfirmDialog.vue'
import { errorTitle, toHarnessErrorView } from '~/components/common/harness-error'
import PageHeader from '~/components/common/PageHeader.vue'
import RelativeTime from '~/components/common/RelativeTime.vue'
import { pluginDetailRoute } from '~/components/plugins/list/plugin-display'
import { MarketplacesRefreshError, useMarketplacesStore } from '~/stores/marketplaces'
import { usePluginsStore } from '~/stores/plugins'
import { isAbortError, toHarnessError } from '~/utils/errors'
import { testIds } from '~/utils/testids'
import { MARKETPLACE_ENTRY_CONTEXT } from './entry-context'
import MarketplaceAddDialog from './MarketplaceAddDialog.vue'
import MarketplaceEntryRow from './MarketplaceEntryRow.vue'
import MarketplaceInstallDialog from './MarketplaceInstallDialog.vue'
import {
  addErrorText,
  categoriesOf,
  filterEntries,
  forEachLimited,
  middleTruncate,
  OFFICIAL_MARKETPLACE,
  queryText,
  showsOfficialSuggestion,
  sourceText,
  SUGGESTION_DISMISSED_KEY,
} from './marketplaces'
import MarketplaceStrip from './MarketplaceStrip.vue'
import MarketplaceSuggestion from './MarketplaceSuggestion.vue'
import { navigateTo, useHead, useRoute, useRouter } from './nuxt-imports'

/** The page's path (the query is written back only while it is shown). */
const PAGE_PATH = '/plugins/marketplaces'
/** A cached list or detail younger than this is shown as is (events keep it current). */
const MAX_AGE_MS = 15_000
/** Details fetched at a time on All. */
const DETAIL_CONCURRENCY = 4
/** The value of the All option of the category select (reka refuses an empty value). */
const ALL_CATEGORIES = '__all__'

const marketplaces = useMarketplacesStore()
const plugins = usePluginsStore()
const route = useRoute()
const router = useRouter()
const root = useTemplateRef<HTMLElement>('root')

useHead({ title: 'Marketplaces · harness-forge' })

// ---------- route query (?m=, ?q=, ?category=) ----------

function onPage(): boolean {
  return route.path.replace(/\/+$/, '') === PAGE_PATH
}

/** Writes query keys with `router.replace` (empty or null removes a key), only while this page is shown. */
function replaceQuery(patch: Readonly<Record<string, string | null>>): void {
  if (!onPage())
    return
  const query: Record<string, unknown> = { ...route.query }
  let changed = false
  for (const [key, value] of Object.entries(patch)) {
    const current = queryText(query[key])
    if (value === null || value === '') {
      if (key in query) {
        delete query[key]
        changed = true
      }
    }
    else if (current !== value) {
      query[key] = value
      changed = true
    }
  }
  if (changed)
    router.replace({ query: query as Record<string, string> }).catch(() => {})
}

const queryMarketplace = computed(() => queryText(route.query.m))
/** The selected marketplace (`?m=`), or null for All; an unknown id reads as All once the list is known. */
const selectedId = computed<string | null>(() => {
  const id = queryMarketplace.value
  if (!id)
    return null
  if (!marketplaces.list)
    return id
  return marketplaces.byId(id) ? id : null
})
const selected = computed(() => (selectedId.value ? marketplaces.byId(selectedId.value) : null))

watch([queryMarketplace, () => marketplaces.list], ([id, list]) => {
  if (id && list && !marketplaces.byId(id))
    replaceQuery({ m: null })
}, { immediate: true })

function select(id: string | null): void {
  replaceQuery({ m: id })
}

// The search filters at once and reaches `?q=` 200 ms after the last keystroke; leaving the page cancels it.
const search = ref(queryText(route.query.q))
let searchTimer: ReturnType<typeof setTimeout> | undefined

watch(() => route.query.q, (value) => {
  const next = queryText(value)
  if (next.trim() !== search.value.trim())
    search.value = next
})

watch(search, (value) => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => replaceQuery({ q: value.trim() || null }), 200)
})

onBeforeUnmount(() => clearTimeout(searchTimer))

// ---------- data ----------

const listLoading = ref(false)
const listError = shallowRef<unknown>(null)
const detailErrors = shallowRef<Record<string, unknown>>({})

const items = computed(() => marketplaces.items)
const shownIds = computed(() => (selectedId.value ? [selectedId.value] : items.value.map(item => item.id)))
/** Changes only when the set of marketplaces changes (not on every summary update). */
const itemsKey = computed(() => items.value.map(item => item.id).join(','))

async function loadList(force = false): Promise<void> {
  listLoading.value = true
  listError.value = null
  try {
    await marketplaces.fetchAll(force ? {} : { maxAgeMs: MAX_AGE_MS })
  }
  catch (error) {
    if (!isAbortError(error))
      listError.value = error
  }
  finally {
    listLoading.value = false
  }
}

async function loadDetail(id: string, force = false): Promise<void> {
  try {
    await marketplaces.fetch(id, force ? {} : { maxAgeMs: MAX_AGE_MS })
    if (id in detailErrors.value) {
      const { [id]: _cleared, ...rest } = detailErrors.value
      detailErrors.value = rest
    }
  }
  catch (error) {
    if (!isAbortError(error))
      detailErrors.value = { ...detailErrors.value, [id]: error }
  }
}

/** The details of the shown marketplaces (All: every one, at most 4 requests at a time). */
function loadShown(force = false): void {
  if (!marketplaces.list)
    return
  void forEachLimited(shownIds.value, DETAIL_CONCURRENCY, id => loadDetail(id, force))
}

onMounted(() => {
  void loadList()
  // Installed versions of the entries; the store keeps them current.
  if (!plugins.loaded)
    plugins.fetchAll().catch(() => {})
})

watch([selectedId, itemsKey, () => marketplaces.list !== null], () => loadShown(), { immediate: true })

function retry(): void {
  if (!marketplaces.list) {
    void loadList(true)
    return
  }
  for (const id of shownIds.value.filter(key => key in detailErrors.value))
    void loadDetail(id, true)
}

// ---------- what the page shows ----------

provide(MARKETPLACE_ENTRY_CONTEXT, { showMarketplace: computed(() => selectedId.value === null) })

const allEntries = computed(() => marketplaces.entries(selectedId.value))
const categories = computed(() => categoriesOf(allEntries.value))
const queryCategory = computed(() => queryText(route.query.category))
/** The category filter (`?category=`); an unknown category reads as All. */
const category = computed(() => (categories.value.includes(queryCategory.value) ? queryCategory.value : null))
const visible = computed(() => filterEntries(allEntries.value, search.value, category.value))
const filtering = computed(() => search.value.trim() !== '' || category.value !== null)

const loadedShown = computed(() => shownIds.value.filter(id => id in marketplaces.details))
const failedShown = computed(() => shownIds.value.filter(id => !(id in marketplaces.details) && id in detailErrors.value))
/** Nothing to show yet: the list, or every shown detail, is still loading. */
const loading = computed(() => {
  if (!marketplaces.list)
    return !listError.value
  return shownIds.value.length > 0 && loadedShown.value.length === 0 && failedShown.value.length < shownIds.value.length
})
/** The load failure the page shows (the list, else a shown detail), or null. */
const loadFailure = computed<unknown>(() => {
  if (!marketplaces.list)
    return listError.value
  const id = failedShown.value[0]
  return id === undefined ? null : detailErrors.value[id] ?? null
})
const loadMessage = computed(() => (loadFailure.value ? toHarnessError(loadFailure.value).message : ''))

/** Marketplaces whose last refresh failed, among the shown ones. */
const refreshErrors = computed(() => shownIds.value.flatMap((id) => {
  const item = marketplaces.byId(id)
  return item?.lastError ? [{ id: item.id, name: item.name, code: item.lastError.code, message: item.lastError.message }] : []
}))

const selectedSource = computed(() => (selected.value ? sourceText(selected.value.source, selected.value.resolvedRef) : ''))

type EmptyState = 'none' | 'no-match' | 'no-entries' | null
const emptyState = computed<EmptyState>(() => {
  if (!marketplaces.list || loading.value)
    return null
  if (items.value.length === 0)
    return 'none'
  if (loadedShown.value.length === 0)
    return null
  if (allEntries.value.length === 0)
    return 'no-entries'
  return visible.value.length === 0 ? 'no-match' : null
})
const noEntriesText = computed(() => {
  const only = selected.value ?? (items.value.length === 1 ? items.value[0] : null)
  return only ? `${only.name} lists no plugins.` : 'These marketplaces list no plugins.'
})

function clearFilters(): void {
  search.value = ''
  clearTimeout(searchTimer)
  replaceQuery({ q: null, category: null })
}

function onCategory(value: AcceptableValue): void {
  if (typeof value === 'string')
    replaceQuery({ category: value === ALL_CATEGORIES ? null : value })
}

// ---------- focus ----------

/** A dialog that just closed keeps its focus trap until its exit animation ended (`duration-100`). */
const AFTER_DIALOG_MS = 160
let focusTimer: ReturnType<typeof setTimeout> | undefined

onBeforeUnmount(() => clearTimeout(focusTimer))

/**
 * Focuses the chip of a marketplace (All for null), else the narrow `Select` of the strip: at once, and again once a
 * closing dialog has given the focus back to its opener.
 */
function focusChip(id: string | null): void {
  const run = (): void => {
    const element = root.value
    const chip = element?.querySelector<HTMLElement>(`[data-testid="${testIds.marketplaceRow}"][data-marketplace-id="${id ?? ''}"]`)
    const target = chip ?? element?.querySelector<HTMLElement>('[data-slot="marketplace-select"]')
    if (target && document.activeElement !== target)
      target.focus()
  }
  void nextTick(run)
  clearTimeout(focusTimer)
  focusTimer = setTimeout(run, AFTER_DIALOG_MS)
}

// ---------- suggestion ----------

function readDismissed(): boolean {
  try {
    return globalThis.localStorage?.getItem(SUGGESTION_DISMISSED_KEY) === '1'
  }
  catch {
    return false
  }
}

const dismissed = ref(readDismissed())
const suggestionBusy = ref(false)
const showSuggestion = computed(() => showsOfficialSuggestion(marketplaces.list, dismissed.value))

function dismissSuggestion(): void {
  dismissed.value = true
  try {
    globalThis.localStorage?.setItem(SUGGESTION_DISMISSED_KEY, '1')
  }
  catch {
    // Not stored: the card stays hidden until the page reloads.
  }
}

/** The card's Add: the add flow with the official repository (the first request the card causes). */
async function addSuggested(): Promise<void> {
  if (suggestionBusy.value)
    return
  suggestionBusy.value = true
  try {
    const detail = await marketplaces.add({ type: 'github', repo: OFFICIAL_MARKETPLACE })
    toast.success(`Added ${detail.name}`)
    onAdded(detail.id)
  }
  catch (error) {
    const view = toHarnessErrorView(toHarnessError(error))
    toast.error(errorTitle(view), { description: addErrorText(view) })
  }
  finally {
    suggestionBusy.value = false
  }
}

// ---------- add, refresh, remove ----------

const addOpen = ref(false)

function onAdded(id: string): void {
  select(id)
  focusChip(id)
}

const refreshingAll = ref(false)

function refreshFailed(name: string, error: unknown): void {
  toast.error(`Could not refresh ${name}: ${toHarnessError(error).message}`)
}

async function refreshOne(id: string): Promise<void> {
  const name = marketplaces.byId(id)?.name ?? id
  try {
    await marketplaces.refresh(id)
  }
  catch (error) {
    refreshFailed(name, error)
  }
}

async function refreshAll(): Promise<void> {
  if (refreshingAll.value)
    return
  refreshingAll.value = true
  try {
    await marketplaces.refreshAll()
  }
  catch (error) {
    if (error instanceof MarketplacesRefreshError) {
      for (const failure of error.failures)
        refreshFailed(failure.name, failure.error)
    }
    else {
      toast.error(errorTitle(toHarnessErrorView(toHarnessError(error))), { description: toHarnessError(error).message })
    }
  }
  finally {
    refreshingAll.value = false
  }
}

const removeId = ref<string | null>(null)
const removePending = ref(false)
const removeName = ref('')

function askRemove(id: string): void {
  removeName.value = marketplaces.byId(id)?.name ?? ''
  removeId.value = id
}

function onRemoveOpen(value: boolean): void {
  if (!value && !removePending.value)
    removeId.value = null
}

async function confirmRemove(): Promise<void> {
  const id = removeId.value
  if (!id || removePending.value)
    return
  const name = removeName.value
  removePending.value = true
  try {
    await marketplaces.remove(id)
    toast.success(`Removed ${name}`)
    if (queryMarketplace.value === id)
      select(null)
    removeId.value = null
    focusChip(null)
  }
  catch (error) {
    const failure = toHarnessError(error)
    toast.error(errorTitle(toHarnessErrorView(failure)), { description: failure.message })
    removeId.value = null
  }
  finally {
    removePending.value = false
  }
}

// ---------- install and update ----------

const install = ref<{ open: boolean, marketplaceId: string | null, entryName: string | null, mode: 'install' | 'update' }>({
  open: false,
  marketplaceId: null,
  entryName: null,
  mode: 'install',
})

function openInstall(view: MarketplaceEntryView, mode: 'install' | 'update'): void {
  install.value = { open: true, marketplaceId: view.marketplaceId, entryName: view.entry.name, mode }
}

function onInstalled(pluginId: string): void {
  install.value = { ...install.value, open: false }
  void navigateTo(pluginDetailRoute(pluginId))
}

function entryBusy(view: MarketplaceEntryView): boolean {
  return marketplaces.busy[view.marketplaceId] === true
}
</script>

<template>
  <div ref="root" :data-testid="testIds.marketplacesPage" class="hf-scroll-stable h-dvh min-h-0 overflow-y-auto">
    <div class="mx-auto flex w-full max-w-5xl flex-col px-4 pb-16 md:px-6">
      <PageHeader title="Marketplaces" description="Browse plugins from Claude Code marketplaces.">
        <template #actions>
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-label="Refresh all"
            :disabled="items.length === 0 || refreshingAll"
            :aria-busy="refreshingAll || undefined"
            :data-testid="testIds.marketplaceRefreshAll"
            class="pointer-coarse:h-10 max-sm:size-10"
            @click="refreshAll"
          >
            <Spinner v-if="refreshingAll" aria-hidden="true" data-icon="inline-start" />
            <RotateCwIcon v-else aria-hidden="true" data-icon="inline-start" />
            <span class="max-sm:sr-only">Refresh all</span>
          </Button>
          <Button
            type="button"
            size="sm"
            aria-label="Add marketplace…"
            :data-testid="testIds.marketplaceAdd"
            class="pointer-coarse:h-10 max-sm:size-10"
            @click="addOpen = true"
          >
            <PlusIcon aria-hidden="true" data-icon="inline-start" />
            <span class="max-sm:sr-only">Add marketplace…</span>
          </Button>
        </template>
      </PageHeader>

      <div class="flex min-w-0 flex-col gap-4 pt-4">
        <MarketplaceSuggestion v-if="showSuggestion" @add="addSuggested" @dismiss="dismissSuggestion" />

        <Alert v-if="loadFailure" class="border-destructive/35 bg-destructive/5 dark:bg-destructive/10">
          <CircleAlertIcon aria-hidden="true" class="text-destructive" />
          <AlertTitle>Could not load the marketplaces</AlertTitle>
          <AlertDescription class="text-foreground/80">
            {{ loadMessage }}
          </AlertDescription>
          <div class="col-start-2 mt-2">
            <Button type="button" size="sm" variant="outline" :disabled="listLoading" class="pointer-coarse:h-10" @click="retry">
              Retry
            </Button>
          </div>
        </Alert>

        <Empty v-if="emptyState === 'none'" :data-testid="testIds.marketplaceEmpty" data-value="none" class="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <StoreIcon aria-hidden="true" />
            </EmptyMedia>
            <EmptyDescription class="text-foreground/80">
              No marketplaces yet. Add one from GitHub, a marketplace.json URL or a folder on this server.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button type="button" size="sm" data-action="add" class="pointer-coarse:h-10" @click="addOpen = true">
              <PlusIcon aria-hidden="true" data-icon="inline-start" />
              Add marketplace…
            </Button>
          </EmptyContent>
        </Empty>

        <template v-else-if="marketplaces.list && items.length > 0">
          <div class="grid min-w-0 gap-1.5">
            <MarketplaceStrip
              :items="items"
              :selected-id="selectedId"
              :busy-ids="Object.keys(marketplaces.busy)"
              @select="select"
              @refresh="refreshOne"
              @remove="askRemove"
            />
            <p v-if="selected" class="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground" data-slot="marketplace-source">
              <span class="min-w-0 font-mono break-all" :title="selectedSource">{{ middleTruncate(selectedSource) }}</span>
              <template v-if="selected.fetchedAt !== null">
                <span aria-hidden="true">·</span>
                <span>refreshed <RelativeTime :at="selected.fetchedAt" /></span>
              </template>
            </p>
          </div>

          <Alert
            v-for="failure in refreshErrors"
            :key="failure.id"
            :data-testid="testIds.marketplaceError"
            :data-code="failure.code"
            :data-marketplace-id="failure.id"
            class="border-warning/40 bg-warning/5 dark:bg-warning/10"
          >
            <TriangleAlertIcon aria-hidden="true" class="text-warning" />
            <AlertDescription class="text-foreground/80">
              Could not refresh {{ failure.name }}: {{ failure.message }}
            </AlertDescription>
          </Alert>

          <div class="flex min-w-0 flex-wrap items-center gap-2">
            <InputGroup class="min-w-0 flex-1 basis-56">
              <InputGroupAddon>
                <SearchIcon aria-hidden="true" />
              </InputGroupAddon>
              <InputGroupInput
                v-model="search"
                type="search"
                placeholder="Search plugins…"
                aria-label="Search plugins"
                autocomplete="off"
                class="[&::-webkit-search-cancel-button]:appearance-none"
                :data-testid="testIds.marketplaceSearch"
                @keydown.esc="search = ''"
              />
              <InputGroupAddon v-if="search" align="inline-end">
                <InputGroupButton size="icon-xs" aria-label="Clear search" @click="search = ''">
                  <XIcon aria-hidden="true" />
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
            <Select :model-value="category ?? ALL_CATEGORIES" @update:model-value="onCategory">
              <SelectTrigger
                aria-label="Category"
                :data-testid="testIds.marketplaceCategory"
                :data-value="category ?? ''"
                class="w-44 max-sm:w-full max-sm:data-[size=default]:h-10 pointer-coarse:data-[size=default]:h-10"
              >
                <span class="text-muted-foreground">Category:</span>
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="end">
                <SelectItem :value="ALL_CATEGORIES" data-value="" class="pointer-coarse:min-h-10">
                  All
                </SelectItem>
                <SelectItem v-for="option in categories" :key="option" :value="option" :data-value="option" class="pointer-coarse:min-h-10">
                  {{ option }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div v-if="loading" data-slot="marketplace-skeleton" class="grid gap-3">
            <span class="sr-only" role="status">Loading marketplaces…</span>
            <div v-for="n in 3" :key="n" aria-hidden="true" class="grid gap-2 border-b py-3">
              <Skeleton class="h-4 w-48" />
              <Skeleton class="h-3 w-3/4" />
            </div>
          </div>

          <Empty v-else-if="emptyState === 'no-match'" :data-testid="testIds.marketplaceEmpty" data-value="no-match" class="border">
            <EmptyHeader>
              <EmptyTitle>No plugins match</EmptyTitle>
              <EmptyDescription>Try another search or category.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button type="button" size="sm" variant="outline" class="pointer-coarse:h-10" @click="clearFilters">
                Clear filters
              </Button>
            </EmptyContent>
          </Empty>

          <p
            v-else-if="emptyState === 'no-entries'"
            :data-testid="testIds.marketplaceEmpty"
            data-value="no-entries"
            class="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground"
          >
            {{ noEntriesText }}
          </p>

          <div v-else-if="visible.length > 0" role="list" aria-label="Plugins" class="grid divide-y">
            <div v-for="view in visible" :key="`${view.marketplaceId}:${view.entry.name}`" role="listitem" class="min-w-0">
              <MarketplaceEntryRow
                :entry="view"
                :busy="entryBusy(view)"
                @install="openInstall(view, 'install')"
                @update="openInstall(view, 'update')"
              />
            </div>
          </div>
          <p v-if="filtering && visible.length > 0" class="sr-only" role="status">
            {{ visible.length }} of {{ allEntries.length }} plugins
          </p>
        </template>

        <div v-else-if="loading" data-slot="marketplace-skeleton" class="grid gap-3">
          <span class="sr-only" role="status">Loading marketplaces…</span>
          <div v-for="n in 3" :key="n" aria-hidden="true" class="grid gap-2 border-b py-3">
            <Skeleton class="h-4 w-48" />
            <Skeleton class="h-3 w-3/4" />
          </div>
        </div>
      </div>
    </div>

    <MarketplaceAddDialog v-model:open="addOpen" @added="detail => onAdded(detail.id)" />
    <MarketplaceInstallDialog
      v-model:open="install.open"
      :marketplace-id="install.marketplaceId"
      :entry-name="install.entryName"
      :mode="install.mode"
      @installed="onInstalled"
    />
    <ConfirmDialog
      :open="removeId !== null"
      :title="`Remove ${removeName}?`"
      description="Removing a marketplace keeps the plugins you installed from it."
      confirm-label="Remove"
      destructive
      :pending="removePending"
      :data-testid="testIds.marketplaceRemoveConfirm"
      @update:open="onRemoveOpen"
      @confirm="confirmRemove"
    />
  </div>
</template>
