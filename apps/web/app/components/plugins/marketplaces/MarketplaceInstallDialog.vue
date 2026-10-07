<script setup lang="ts">
// Install or update a marketplace entry (Phase 12, ADR-054; docs/UI.md 8.13, 10.9, 14.1): a dialog
// (`marketplace-install-dialog`, `data-mode` install | update) titled "Install {name}" / "Update {name}" that inspects the
// entry at once (`POST /api/plugins/inspect` with `{ source: 'marketplace', marketplaceId, plugin }`; the status
// "Downloading {name}…" holds the focus meanwhile) and then renders InstallReview (the preview, the trust consent, the
// password field and Install: the one fresh-auth flow of the install dialog). An update whose file tree did not change
// reads "{name} is up to date." (no install). A 409 `stale` re-inspects once (InstallReview shows the new review with its
// notice); a failed inspection shows its error (with the alert's own actions) and Close. Success: the toast "Installed {name}" ("Installed {name}.
// It's turned off until you turn it on." for a plugin that installs turned off) or "Updated {name} to {version}", then
// `installed(pluginId)`; the parent closes the dialog (the page opens the plugin). Closing returns the focus to the button
// that opened it. Mounted by MarketplacesView and PluginDetailView (the update banner).
// Props, emits and the root test id are frozen from Gate P12-0b (C46 stub); implementation W12.8 (P12-A).
import type { PluginDetail, PluginInspection } from '@harness-forge/shared'
import type { InstallRequest } from '../install/install'
import type { HarnessErrorUiAction } from '~/components/common/harness-error'
import { CircleCheckIcon } from '@lucide/vue'
import { computed, nextTick, ref, shallowRef, useTemplateRef, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import HarnessErrorAlert from '~/components/common/HarnessErrorAlert.vue'
import { useApi } from '~/composables/useApi'
import { useMarketplacesStore } from '~/stores/marketplaces'
import { usePluginsStore } from '~/stores/plugins'
import { toHarnessError, withHarnessErrors } from '~/utils/errors'
import { testIds } from '~/utils/testids'
import { inspectionSourceLabel } from '../install/install'
import InstallReview from '../install/InstallReview.vue'

const props = defineProps<{ open: boolean, marketplaceId: string | null, entryName: string | null, mode: 'install' | 'update' }>()

const emit = defineEmits<{ 'update:open': [open: boolean], 'installed': [pluginId: string] }>()

const api = useApi()
const plugins = usePluginsStore()
const marketplaces = useMarketplacesStore()

const statusRef = useTemplateRef<HTMLElement>('status')
const bodyRef = useTemplateRef<HTMLElement>('body')

const inspecting = ref(false)
const error = shallowRef<unknown>(null)
const inspection = shallowRef<PluginInspection | null>(null)
const request = shallowRef<InstallRequest | null>(null)
/** Update mode: the installed plugin already has exactly the reviewed file tree. */
const upToDate = ref(false)
// Bumped whenever the dialog closes or inspects again, so an answer for an older session is dropped.
let session = 0

const name = computed(() => props.entryName ?? 'plugin')
const title = computed(() => `${props.mode === 'update' ? 'Update' : 'Install'} ${name.value}`)
const description = computed(() => (props.mode === 'update'
  ? 'Review what changed before you update it.'
  : 'Review what this plugin adds before you install it.'))
const sourceLabel = computed(() => (inspection.value && request.value ? inspectionSourceLabel(inspection.value, request.value) : ''))
const showReview = computed(() => inspection.value !== null && request.value !== null && !upToDate.value)

/** The installed plugin an update replaces: the marketplace's update record, else the inspected id. */
function installedPluginId(current: PluginInspection): string {
  const update = marketplaces.updates.find(item => item.marketplaceId === props.marketplaceId && item.plugin === props.entryName)
  return update?.pluginId ?? current.manifest.id
}

/** An update whose files did not change: the installed plugin's hash equals the reviewed one. */
async function isUpToDate(current: PluginInspection): Promise<boolean> {
  if (props.mode !== 'update' || current.existing === null)
    return false
  try {
    const detail = await plugins.fetchOne(installedPluginId(current))
    return detail.trust.hash !== null && detail.trust.hash === current.sha256
  }
  catch {
    // Unknown: the review decides.
    return false
  }
}

/** After the review renders: the trust checkbox when it is shown, else Install. */
function focusReview(): void {
  void nextTick(() => {
    const body = bodyRef.value
    const target = body?.querySelector<HTMLElement>(`[data-testid="${testIds.trustCheckbox}"]`)
      ?? body?.querySelector<HTMLElement>(`[data-testid="${testIds.installSubmit}"]`)
    target?.focus()
  })
}

async function inspect(): Promise<void> {
  const current = ++session
  error.value = null
  inspection.value = null
  upToDate.value = false
  if (!props.marketplaceId || !props.entryName)
    return
  const next: InstallRequest = { kind: 'json', source: { source: 'marketplace', marketplaceId: props.marketplaceId, plugin: props.entryName } }
  request.value = next
  inspecting.value = true
  try {
    const result = await withHarnessErrors(api.pluginInstall.inspect({ body: next.source }))
    const same = await isUpToDate(result)
    if (current !== session)
      return
    upToDate.value = same
    inspection.value = result
    if (!same)
      focusReview()
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
    upToDate.value = false
  }
}, { immediate: true })

/** The dialog opens on its status line ("Downloading {name}…"). */
function onOpenAutoFocus(event: Event): void {
  event.preventDefault()
  void nextTick(() => statusRef.value?.focus())
}

/** A 409 `stale` from InstallReview: inspect once more and hand the new inspection to the review. */
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

function onErrorAction(action: HarnessErrorUiAction): void {
  if (action === 'retry')
    void inspect()
}

function onInstalled(detail: PluginDetail): void {
  if (props.mode === 'update') {
    const version = detail.claude?.version ?? detail.version
    toast.success(version ? `Updated ${detail.name} to ${version}` : `Updated ${detail.name}`)
  }
  else if (!detail.enabled) {
    toast.success(`Installed ${detail.name}. It's turned off until you turn it on.`)
  }
  else {
    toast.success(`Installed ${detail.name}`)
  }
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
      @open-auto-focus="onOpenAutoFocus"
    >
      <DialogHeader>
        <DialogTitle>{{ title }}</DialogTitle>
        <DialogDescription>{{ description }}</DialogDescription>
      </DialogHeader>
      <div v-if="showReview && inspection && request" ref="body" class="contents">
        <InstallReview
          :inspection="inspection"
          :request="request"
          :source-label="sourceLabel"
          @back="emit('update:open', false)"
          @installed="onInstalled"
          @stale="reinspect"
        />
      </div>
      <template v-else>
        <div class="grid min-h-0 content-start gap-3 overflow-y-auto">
          <p
            v-if="inspecting || (!error && !upToDate)"
            ref="status"
            tabindex="-1"
            role="status"
            class="flex items-center gap-2 text-sm text-muted-foreground outline-none"
          >
            <Spinner aria-hidden="true" />
            Downloading {{ name }}…
          </p>
          <p v-else-if="upToDate" role="status" data-slot="marketplace-up-to-date" class="flex items-center gap-2 text-sm">
            <CircleCheckIcon aria-hidden="true" class="size-4 text-success" />
            {{ name }} is up to date.
          </p>
          <HarnessErrorAlert v-if="error" :error="error" @action="onErrorAction" />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" class="pointer-coarse:h-10" @click="emit('update:open', false)">
            Close
          </Button>
        </DialogFooter>
      </template>
    </DialogContent>
  </Dialog>
</template>
