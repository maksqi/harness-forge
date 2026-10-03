<script setup lang="ts">
// Settings -> Data body (docs/UI.md 2.7, 9.8, ADR-024): the summary line (`GET /api/data`), Export, Import, Storage
// cleanup (ADR-035), Shared links (SharesSettingsSection, W5.6), Encryption key (ADR-034) and the Danger zone. The
// summary also feeds the attachment hint and the import-limit warning of the export and the counts of the delete-all
// dialog; it is reloaded after an import, a cleanup and a key rotation. A key rotation changes every share URL, so it
// also reloads Shared links (remounted: the section has no props). The sections reach the page through
// `dataSettingsContextKey` (data-context.ts).
// Contract (docs/UI.md 10.4): no props, no emits; rendered by pages/settings/data.vue inside SettingsPage.
import type { DataSummary } from '@harness-forge/shared'
import { onMounted, provide, ref } from 'vue'
import { Skeleton } from '@/components/ui/skeleton'
import SharesSettingsSection from '~/components/share/SharesSettingsSection.vue'
import { useApi } from '~/composables/useApi'
import { withHarnessErrors } from '~/utils/errors'
import { testIds } from '~/utils/testids'
import SettingsLoadError from '../SettingsLoadError.vue'
import { summaryLine } from './data'
import { dataSettingsContextKey } from './data-context'
import DataDangerZone from './DataDangerZone.vue'
import DataExportSection from './DataExportSection.vue'
import DataImportSection from './DataImportSection.vue'
import EncryptionKeySection from './EncryptionKeySection.vue'
import StorageCleanupSection from './StorageCleanupSection.vue'

const api = useApi()

const summary = ref<DataSummary | null>(null)
const loading = ref(false)
const loadError = ref<unknown>(null)
/** Bumped to remount Shared links after a key rotation. */
const sharesKey = ref(0)
// A newer load wins over one still in flight (the reload after an import).
let loadSeq = 0

async function loadSummary(): Promise<void> {
  const seq = ++loadSeq
  loading.value = true
  loadError.value = null
  try {
    const next = await withHarnessErrors(api.data.summary())
    if (seq === loadSeq)
      summary.value = next
  }
  catch (error) {
    if (seq === loadSeq)
      loadError.value = error
  }
  finally {
    if (seq === loadSeq)
      loading.value = false
  }
}

provide(dataSettingsContextKey, {
  reloadSummary: () => {
    void loadSummary()
  },
  reloadShares: () => {
    sharesKey.value += 1
  },
})

onMounted(loadSummary)
</script>

<template>
  <div :data-testid="testIds.dataSettings" class="flex flex-col">
    <div class="flex min-h-5 flex-col pb-2">
      <p v-if="summary" :data-testid="testIds.dataSummary" class="text-sm text-muted-foreground tabular-nums">
        {{ summaryLine(summary) }}
      </p>
      <SettingsLoadError
        v-else-if="loadError"
        title="Could not load the data summary"
        :error="loadError"
        :pending="loading"
        @retry="loadSummary"
      />
      <template v-else>
        <Skeleton aria-hidden="true" class="h-5 w-80 max-w-full" />
        <span class="sr-only">Loading…</span>
      </template>
    </div>

    <DataExportSection :summary="summary" />
    <DataImportSection @imported="loadSummary" />
    <StorageCleanupSection />
    <SharesSettingsSection :key="sharesKey" />
    <EncryptionKeySection />
    <DataDangerZone :summary="summary" />
  </div>
</template>
