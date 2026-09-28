<script setup lang="ts">
// Header of the plugin detail page (docs/UI.md 2.4, 8.7): "← Plugins" (back to the last list state), icon, name,
// version, source / "Runs code" / state badges; on the right the Enabled switch, Reload and the ⋯ menu (Edit in
// wizard for wizard-made providers, Export as zip, Uninstall… with "Keep settings and stored data"). Builtins cannot
// be exported or uninstalled. Reloading a code plugin needs a recent login (ADR-017): on 403 + action `login` the
// password prompt opens and the reload runs once more. Below the header: the untrusted / error / incompatible banner
// and the trust dialog (TrustDialog, W3.2).
import type { PluginDetail } from '@harness-forge/shared'
import { ArrowLeftIcon, DownloadIcon, MoreHorizontalIcon, PencilIcon, RotateCwIcon, Trash2Icon } from '@lucide/vue'
import { computed, ref } from 'vue'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Label } from '@/components/ui/label'
import { SidebarTrigger, useSidebar } from '@/components/ui/sidebar'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import ConfirmDialog from '~/components/common/ConfirmDialog.vue'
import ConfirmPasswordDialog from '~/components/common/ConfirmPasswordDialog.vue'
import { errorTitle } from '~/components/common/harness-error'
import KbdCombo from '~/components/common/KbdCombo.vue'
import { useApi } from '~/composables/useApi'
import { usePluginsStore } from '~/stores/plugins'
import { downloadResponse } from '~/utils/download'
import { toHarnessError } from '~/utils/errors'
import { testIds } from '~/utils/testids'
import { lastListRoute } from '../list/list-route'
import { navigateTo } from '../list/nuxt-imports'
import { PLUGIN_STATE_LABELS } from '../list/plugin-display'
import PluginIcon from '../list/PluginIcon.vue'
import PluginRunsCodeBadge from '../list/PluginRunsCodeBadge.vue'
import PluginSourceBadge from '../list/PluginSourceBadge.vue'
import PluginStateBadge from '../list/PluginStateBadge.vue'
import { isFreshAuthCancelled, useFreshAuth } from './fresh-auth'
import { canEditInWizard, canExport, canUninstall } from './plugin-detail'
import PluginStatusBanner from './PluginStatusBanner.vue'

const props = defineProps<{ plugin: PluginDetail }>()

const emit = defineEmits<{ viewLogs: [] }>()

const plugins = usePluginsStore()
const api = useApi()
const freshAuth = useFreshAuth()
const sidebar = useSidebar(null)

const switching = ref(false)
const reloading = ref(false)
const exporting = ref(false)
const uninstallOpen = ref(false)
const keepData = ref(false)
const uninstalling = ref(false)
const trustOpen = ref(false)
/** TrustDialog mounts on first use. */
const trustMounted = ref(false)

const showTrigger = computed(() => !!sidebar && (sidebar.isMobile.value || sidebar.state.value === 'collapsed'))
const backTo = computed(() => lastListRoute())
const editable = computed(() => canEditInWizard(props.plugin))
const exportable = computed(() => canExport(props.plugin))
const removable = computed(() => canUninstall(props.plugin))
const hasMenu = computed(() => editable.value || exportable.value || removable.value)
const stateMessage = computed(() => (props.plugin.state === 'error' || props.plugin.state === 'incompatible' ? props.plugin.lastError?.message ?? null : null))
const editRoute = computed(() => ({ path: '/plugins/new', query: { type: 'provider', edit: props.plugin.id } }))

function showError(error: unknown, title?: string) {
  const failure = toHarnessError(error)
  toast.error(title ?? errorTitle(failure), { description: failure.message })
}

async function setEnabled(value: boolean) {
  switching.value = true
  try {
    const next = value ? await plugins.enable(props.plugin.id) : await plugins.disable(props.plugin.id)
    if (value && next.state === 'error')
      toast.error(`${next.name} could not start`, { description: next.lastError?.message })
    else if (value && next.state === 'untrusted')
      toast(`${next.name} needs your trust`, { description: 'Review and trust it to run its code.' })
  }
  catch (error) {
    showError(error)
  }
  finally {
    switching.value = false
  }
}

async function reload() {
  if (reloading.value)
    return
  reloading.value = true
  try {
    const next = await freshAuth.run(() => plugins.reload(props.plugin.id))
    if (next.state === 'active')
      toast.success(`Reloaded ${next.name}`)
    else if (next.state === 'error')
      toast.error(`${next.name} failed to reload`, { description: next.lastError?.message })
    else
      toast(`Reloaded ${next.name}`, { description: `State: ${PLUGIN_STATE_LABELS[next.state]}` })
  }
  catch (error) {
    if (!isFreshAuthCancelled(error))
      showError(error, `Could not reload ${props.plugin.name}`)
  }
  finally {
    reloading.value = false
  }
}

async function exportZip() {
  exporting.value = true
  try {
    const response = await api.pluginInstall.export({ params: { id: props.plugin.id } })
    await downloadResponse(response, `${props.plugin.id}-${props.plugin.version}.zip`)
  }
  catch (error) {
    showError(error, `Could not export ${props.plugin.name}`)
  }
  finally {
    exporting.value = false
  }
}

function openUninstall() {
  keepData.value = false
  uninstallOpen.value = true
}

async function confirmUninstall() {
  uninstalling.value = true
  const { id, name } = props.plugin
  try {
    await plugins.uninstall(id, { keepData: keepData.value })
    uninstallOpen.value = false
    toast.success(`Uninstalled ${name}`)
    await navigateTo(backTo.value)
  }
  catch (error) {
    showError(error, `Could not uninstall ${name}`)
  }
  finally {
    uninstalling.value = false
  }
}

function openTrust() {
  trustMounted.value = true
  trustOpen.value = true
}

function onTrusted(id: string) {
  trustOpen.value = false
  plugins.fetchOne(id).catch(() => {})
}

defineExpose({ reload, openTrust })
</script>

<template>
  <header data-slot="plugin-header" class="flex flex-col gap-4">
    <div class="flex h-(--header-height) items-center gap-2">
      <Tooltip v-if="showTrigger">
        <TooltipTrigger as-child>
          <SidebarTrigger
            :data-testid="testIds.sidebarTrigger"
            aria-label="Toggle sidebar"
            class="-ml-2 text-muted-foreground hover:text-foreground"
          />
        </TooltipTrigger>
        <TooltipContent side="bottom">
          Toggle sidebar
          <KbdCombo keys="mod+b" />
        </TooltipContent>
      </Tooltip>
      <NuxtLink
        :to="backTo"
        class="-ml-1 inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <ArrowLeftIcon aria-hidden="true" class="size-3.5" />
        Plugins
      </NuxtLink>
    </div>

    <div class="flex flex-wrap items-center gap-x-6 gap-y-4">
      <div class="flex min-w-0 flex-1 basis-80 items-center gap-3.5">
        <PluginIcon :plugin="plugin" size="lg" />
        <div class="min-w-0">
          <div class="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <h1 class="min-w-0 truncate text-xl font-semibold tracking-tight">
              {{ plugin.name }}
            </h1>
            <span class="font-mono text-xs text-muted-foreground">v{{ plugin.version }}</span>
          </div>
          <div class="mt-1.5 flex flex-wrap items-center gap-1.5">
            <PluginSourceBadge :plugin="plugin" />
            <PluginRunsCodeBadge v-if="plugin.runsCode" />
            <PluginStateBadge :state="plugin.state" :message="stateMessage" :data-testid="testIds.pluginState" />
          </div>
        </div>
      </div>

      <div class="flex items-center gap-1">
        <Label class="mr-2 cursor-pointer gap-2.5 text-sm font-normal text-muted-foreground">
          Enabled
          <Switch
            :model-value="plugin.enabled"
            :disabled="switching"
            :data-testid="testIds.pluginEnabled"
            @update:model-value="setEnabled"
          />
        </Label>
        <Tooltip>
          <TooltipTrigger as-child>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Reload plugin"
              :disabled="reloading || !plugin.enabled"
              :aria-busy="reloading || undefined"
              :data-testid="testIds.pluginReload"
              class="text-muted-foreground hover:text-foreground"
              @click="reload"
            >
              <RotateCwIcon aria-hidden="true" :class="cn(reloading && 'animate-spin')" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{{ plugin.enabled ? 'Reload plugin' : 'Turn the plugin on to reload it' }}</TooltipContent>
        </Tooltip>
        <DropdownMenu v-if="hasMenu">
          <DropdownMenuTrigger as-child>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Plugin actions"
              title="Plugin actions"
              :data-testid="testIds.pluginMenu"
              class="text-muted-foreground hover:text-foreground"
            >
              <MoreHorizontalIcon aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" class="w-52">
            <DropdownMenuItem v-if="editable" as-child :data-testid="testIds.pluginEdit">
              <NuxtLink :to="editRoute">
                <PencilIcon aria-hidden="true" />
                Edit in wizard
              </NuxtLink>
            </DropdownMenuItem>
            <DropdownMenuItem v-if="exportable" :disabled="exporting" :data-testid="testIds.pluginExport" @select="exportZip">
              <DownloadIcon aria-hidden="true" />
              Export as zip
            </DropdownMenuItem>
            <template v-if="removable">
              <DropdownMenuSeparator v-if="editable || exportable" />
              <DropdownMenuItem variant="destructive" :data-testid="testIds.pluginUninstall" @select="openUninstall">
                <Trash2Icon aria-hidden="true" />
                Uninstall…
              </DropdownMenuItem>
            </template>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>

    <PluginStatusBanner
      :plugin="plugin"
      :reloading="reloading"
      @review="openTrust"
      @view-logs="emit('viewLogs')"
      @reload="reload"
    />

    <ConfirmDialog
      v-model:open="uninstallOpen"
      :title="`Uninstall ${plugin.name}?`"
      description="Its providers, tools and commands are removed."
      confirm-label="Uninstall"
      :pending="uninstalling"
      :data-testid="testIds.pluginUninstallConfirm"
      @confirm="confirmUninstall"
    >
      <Label class="items-start gap-2.5 rounded-lg border px-3 py-2.5 font-normal">
        <Checkbox
          :model-value="keepData"
          :disabled="uninstalling"
          :data-testid="testIds.pluginUninstallKeepData"
          class="mt-0.5"
          @update:model-value="value => keepData = value === true"
        />
        <span class="flex flex-col gap-0.5">
          <span class="font-medium">Keep settings and stored data</span>
          <span class="text-xs text-muted-foreground">Reinstalling the plugin later picks them up again. Otherwise its settings, storage, secrets and provider keys are deleted.</span>
        </span>
      </Label>
    </ConfirmDialog>

    <ConfirmPasswordDialog
      :open="freshAuth.open.value"
      :pending="freshAuth.pending.value"
      :error="freshAuth.error.value"
      description="Reloading runs the plugin's code again. Confirm your password to continue."
      @update:open="freshAuth.setOpen"
      @submit="freshAuth.submit"
    />

    <TrustDialog
      v-if="trustMounted"
      v-model:open="trustOpen"
      :plugin-id="plugin.id"
      @trusted="onTrusted"
    />
  </header>
</template>
