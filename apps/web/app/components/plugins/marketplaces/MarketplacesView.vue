<script setup lang="ts">
// Content of /plugins/marketplaces (Phase 12, ADR-054; docs/UI.md 2.19, 6, 8.13, 10.9): PageHeader "Marketplaces" with
// Refresh all (`marketplace-refresh-all`) and Add marketplace… (`marketplace-add`), the official suggestion
// (MarketplaceSuggestion), the chips (MarketplaceStrip, `?m=`), search (`marketplace-search`, `?q=`) and category
// (`marketplace-category`, `?category=`), the entries (MarketplaceEntryRow), the empty states (`marketplace-empty`), a
// failed refresh (`marketplace-error`, `data-code`), MarketplaceAddDialog, MarketplaceInstallDialog and the remove
// confirmation (`marketplace-remove-confirm`). Data from `useMarketplacesStore()` (`fetchAll({ maxAgeMs: 15_000 })` on
// mount, the details of the shown marketplaces). No props, no emits.
// The root test id is frozen from Gate P12-0b (C46 stub); W12.8 implements the page in P12-A. The stub lists the loaded
// marketplaces and the entries of the loaded details and wires the dialogs.
import type { MarketplaceEntryView } from './marketplaces'
import { PlusIcon, RotateCwIcon } from '@lucide/vue'
import { computed, onMounted, ref } from 'vue'
import { Button } from '@/components/ui/button'
import ConfirmDialog from '~/components/common/ConfirmDialog.vue'
import PageHeader from '~/components/common/PageHeader.vue'
import { useMarketplacesStore } from '~/stores/marketplaces'
import { testIds } from '~/utils/testids'
import MarketplaceAddDialog from './MarketplaceAddDialog.vue'
import MarketplaceEntryRow from './MarketplaceEntryRow.vue'
import MarketplaceInstallDialog from './MarketplaceInstallDialog.vue'
import MarketplaceStrip from './MarketplaceStrip.vue'

const marketplaces = useMarketplacesStore()

const selectedId = ref<string | null>(null)
const addOpen = ref(false)
const install = ref<{ open: boolean, marketplaceId: string | null, entryName: string | null, mode: 'install' | 'update' }>({
  open: false,
  marketplaceId: null,
  entryName: null,
  mode: 'install',
})
const removeId = ref<string | null>(null)

const entries = computed(() => marketplaces.entries(selectedId.value))
const busyIds = computed(() => Object.keys(marketplaces.busy))
const removeName = computed(() => (removeId.value ? marketplaces.byId(removeId.value)?.name ?? '' : ''))

onMounted(() => {
  marketplaces.fetchAll({ maxAgeMs: 15_000 }).catch(() => {})
})

function openInstall(view: MarketplaceEntryView, mode: 'install' | 'update'): void {
  install.value = { open: true, marketplaceId: view.marketplaceId, entryName: view.entry.name, mode }
}

function onInstalled(): void {
  install.value = { ...install.value, open: false }
}

async function confirmRemove(): Promise<void> {
  const id = removeId.value
  removeId.value = null
  if (!id)
    return
  if (selectedId.value === id)
    selectedId.value = null
  await marketplaces.remove(id).catch(() => {})
}
</script>

<template>
  <div :data-testid="testIds.marketplacesPage" class="hf-scroll-stable h-dvh min-h-0 overflow-y-auto">
    <div class="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 pb-16 md:px-6">
      <PageHeader title="Marketplaces" description="Browse plugins from Claude Code marketplaces.">
        <template #actions>
          <Button
            type="button"
            size="sm"
            variant="outline"
            :disabled="marketplaces.items.length === 0"
            :data-testid="testIds.marketplaceRefreshAll"
            @click="marketplaces.refreshAll().catch(() => {})"
          >
            <RotateCwIcon aria-hidden="true" data-icon="inline-start" />
            Refresh all
          </Button>
          <Button type="button" size="sm" :data-testid="testIds.marketplaceAdd" @click="addOpen = true">
            <PlusIcon aria-hidden="true" data-icon="inline-start" />
            Add marketplace…
          </Button>
        </template>
      </PageHeader>

      <MarketplaceStrip
        v-if="marketplaces.items.length > 0"
        :items="marketplaces.items"
        :selected-id="selectedId"
        :busy-ids="busyIds"
        @select="id => selectedId = id"
        @refresh="id => marketplaces.refresh(id).catch(() => {})"
        @remove="id => removeId = id"
      />
      <p v-else :data-testid="testIds.marketplaceEmpty" data-value="none" class="text-sm text-muted-foreground">
        No marketplaces yet. Add one from GitHub, a marketplace.json URL or a folder on this server.
      </p>

      <div v-if="entries.length > 0" class="grid divide-y">
        <MarketplaceEntryRow
          v-for="view in entries"
          :key="`${view.marketplaceId}:${view.entry.name}`"
          :entry="view"
          @install="openInstall(view, 'install')"
          @update="openInstall(view, 'update')"
        />
      </div>
    </div>

    <MarketplaceAddDialog v-model:open="addOpen" @added="detail => selectedId = detail.id" />
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
      :data-testid="testIds.marketplaceRemoveConfirm"
      @update:open="value => { if (!value) removeId = null }"
      @confirm="confirmRemove"
    />
  </div>
</template>
