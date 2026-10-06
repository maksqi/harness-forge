<script setup lang="ts">
// Install or update a marketplace entry (Phase 12, ADR-054; docs/UI.md 8.13, 10.9): a dialog (`marketplace-install-dialog`,
// `data-mode` install | update) titled "Install {name}" / "Update {name}" that inspects the entry at once (`POST
// /api/plugins/inspect` with `{ source: 'marketplace', marketplaceId, plugin }`, "Downloading {name}…") and then renders
// InstallReview (the preview, the trust consent, the password field, one fresh-auth flow); a 409 `stale` re-inspects.
// `installed(pluginId)` follows the toast; the parent closes the dialog. Mounted by MarketplacesView and
// PluginDetailView (the update banner).
// Props, emits and the root test id are frozen from Gate P12-0b (C46 stub); W12.8 implements the dialog in P12-A.
import type { PluginDetail, PluginInspection } from '@harness-forge/shared'
import type { InstallRequest } from '../install/install'
import { computed, ref, shallowRef, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import HarnessErrorAlert from '~/components/common/HarnessErrorAlert.vue'
import { useApi } from '~/composables/useApi'
import { usePluginsStore } from '~/stores/plugins'
import { toHarnessError, withHarnessErrors } from '~/utils/errors'
import { testIds } from '~/utils/testids'
import { inspectionSourceLabel } from '../install/install'
import InstallReview from '../install/InstallReview.vue'

const props = defineProps<{ open: boolean, marketplaceId: string | null, entryName: string | null, mode: 'install' | 'update' }>()

const emit = defineEmits<{ 'update:open': [open: boolean], 'installed': [pluginId: string] }>()

const api = useApi()
const plugins = usePluginsStore()

const inspecting = ref(false)
const error = shallowRef<unknown>(null)
const inspection = shallowRef<PluginInspection | null>(null)
const request = shallowRef<InstallRequest | null>(null)
let session = 0

const title = computed(() => `${props.mode === 'update' ? 'Update' : 'Install'} ${props.entryName ?? 'plugin'}`)
const sourceLabel = computed(() => (inspection.value && request.value ? inspectionSourceLabel(inspection.value, request.value) : ''))

async function inspect(): Promise<void> {
  const current = ++session
  error.value = null
  inspection.value = null
  if (!props.marketplaceId || !props.entryName)
    return
  const next: InstallRequest = { kind: 'json', source: { source: 'marketplace', marketplaceId: props.marketplaceId, plugin: props.entryName } }
  request.value = next
  inspecting.value = true
  try {
    const result = await withHarnessErrors(api.pluginInstall.inspect({ body: next.source }))
    if (current === session)
      inspection.value = result
  }
  catch (failure) {
    if (current === session)
      error.value = toHarnessError(failure)
  }
  finally {
    if (current === session)
      inspecting.value = false
  }
}

watch(() => [props.open, props.marketplaceId, props.entryName] as const, ([open]) => {
  if (open) {
    void inspect()
  }
  else {
    session += 1
    inspecting.value = false
    inspection.value = null
    error.value = null
  }
}, { immediate: true })

async function reinspect(): Promise<void> {
  const current = session
  const next = request.value
  if (!next || next.kind !== 'json')
    return
  try {
    const result = await withHarnessErrors(api.pluginInstall.inspect({ body: next.source }))
    if (current === session)
      inspection.value = result
  }
  catch {
    // The review keeps its error.
  }
}

function onInstalled(detail: PluginDetail): void {
  toast.success(props.mode === 'update' ? `Updated ${detail.name}` : `Installed ${detail.name}`)
  void plugins.fetchOne(detail.id).catch(() => {})
  emit('installed', detail.id)
}
</script>

<template>
  <Dialog :open="open" @update:open="value => emit('update:open', value)">
    <DialogContent
      :data-testid="testIds.marketplaceInstallDialog"
      :data-mode="mode"
      class="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-xl"
    >
      <DialogHeader>
        <DialogTitle>{{ title }}</DialogTitle>
        <DialogDescription>Review what this plugin adds before you install it.</DialogDescription>
      </DialogHeader>
      <InstallReview
        v-if="inspection && request"
        :inspection="inspection"
        :request="request"
        :source-label="sourceLabel"
        @back="emit('update:open', false)"
        @installed="onInstalled"
        @stale="reinspect"
      />
      <div v-else class="grid gap-3">
        <p v-if="inspecting" class="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Spinner />
          Downloading {{ entryName }}…
        </p>
        <HarnessErrorAlert v-if="error" :error="error" />
      </div>
    </DialogContent>
  </Dialog>
</template>
