<script setup lang="ts">
// Settings -> Providers list (docs/UI.md 9.1): every registered provider (builtins in docs/PROVIDERS.md order, then
// plugin providers by name) with its status, the enable switch and the key dialog. `configureId` (from
// `?configure=<providerId>`) opens that provider's dialog once the list is loaded; closing it emits
// `update:configureId(null)` so the page can drop the query parameter.
import type { ProviderSummary } from '@harness-forge/shared'
import { KeyRoundIcon } from '@lucide/vue'
import { computed, onMounted, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import { usePluginsStore } from '~/stores/plugins'
import { useProvidersStore } from '~/stores/providers'
import { toastError } from './notify'
import ProviderKeyDialog from './ProviderKeyDialog.vue'
import ProviderRow from './ProviderRow.vue'
import { isBuiltinProvider, sortProviders } from './providers'
import SettingsLoadError from './SettingsLoadError.vue'

const props = withDefaults(defineProps<{ configureId?: string | null }>(), { configureId: null })

const emit = defineEmits<{ 'update:configureId': [value: string | null] }>()

const providers = useProvidersStore()
const plugins = usePluginsStore()

const loading = ref(false)
const loadError = ref<unknown>(null)
const switching = ref<Record<string, boolean>>({})

const rows = computed(() => sortProviders(providers.items))

async function load() {
  loading.value = true
  loadError.value = null
  try {
    await providers.fetchAll()
  }
  catch (error) {
    loadError.value = error
  }
  finally {
    loading.value = false
  }
  // Plugin names for "via {plugin}" rows; the plugin id is shown until they arrive.
  if (!plugins.loaded && providers.items.some(provider => !isBuiltinProvider(provider)))
    plugins.fetchAll().catch(() => {})
}

onMounted(load)

function pluginNameOf(provider: ProviderSummary): string | null {
  return plugins.byId(provider.pluginId)?.name ?? null
}

async function setEnabled(provider: ProviderSummary, enabled: boolean) {
  switching.value = { ...switching.value, [provider.id]: true }
  try {
    await providers.setEnabled(provider.id, enabled)
  }
  catch (error) {
    toastError(error, provider.name)
  }
  finally {
    const { [provider.id]: _done, ...rest } = switching.value
    switching.value = rest
  }
}

// ---------- key dialog ----------

const dialogOpen = ref(false)
const dialogProviderId = ref('')
/** The open dialog came from `configureId` (closing it clears the deep link). */
const fromDeepLink = ref(false)

function configure(id: string, deepLink = false) {
  dialogProviderId.value = id
  fromDeepLink.value = deepLink
  dialogOpen.value = true
}

watch(() => [props.configureId, providers.loaded] as const, ([id, loaded]) => {
  if (!id || !loaded)
    return
  if (providers.byId(id)) {
    configure(id, true)
  }
  else {
    toast.error('Provider not found', { description: `No provider has the id "${id}".` })
    emit('update:configureId', null)
  }
}, { immediate: true })

watch(dialogOpen, (open) => {
  if (!open && fromDeepLink.value) {
    fromDeepLink.value = false
    emit('update:configureId', null)
  }
})
</script>

<template>
  <div class="flex flex-col gap-4">
    <SettingsLoadError
      v-if="loadError && !providers.loaded"
      title="Could not load providers"
      :error="loadError"
      :pending="loading"
      @retry="load"
    />

    <div
      v-if="!providers.loaded && !loadError"
      aria-busy="true"
      aria-label="Loading providers"
      class="divide-y divide-border overflow-hidden rounded-xl border bg-card"
    >
      <div v-for="index in 5" :key="index" class="flex items-center gap-3 px-4 py-3">
        <Skeleton class="size-9 rounded-lg" />
        <div class="flex flex-1 flex-col gap-1.5">
          <Skeleton class="h-3.5 w-40" />
          <Skeleton class="h-3 w-20" />
        </div>
        <Skeleton class="hidden h-5 w-24 rounded-full sm:block" />
        <Skeleton class="h-8 w-20" />
        <Skeleton class="h-[18px] w-8 rounded-full" />
      </div>
    </div>

    <div
      v-else-if="rows.length"
      role="list"
      aria-label="Providers"
      class="divide-y divide-border overflow-hidden rounded-xl border bg-card"
    >
      <ProviderRow
        v-for="provider in rows"
        :key="provider.id"
        :provider="provider"
        :plugin-name="pluginNameOf(provider)"
        :pending="switching[provider.id] === true"
        @configure="configure(provider.id)"
        @update:enabled="value => setEnabled(provider, value)"
      />
    </div>

    <Empty v-else-if="providers.loaded" class="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <KeyRoundIcon aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>No providers</EmptyTitle>
        <EmptyDescription>Providers come from plugins. Enable the builtin providers or install a provider plugin.</EmptyDescription>
      </EmptyHeader>
    </Empty>

    <ProviderKeyDialog
      v-if="dialogProviderId"
      v-model:open="dialogOpen"
      :provider-id="dialogProviderId"
    />
  </div>
</template>
