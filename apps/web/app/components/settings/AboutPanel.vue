<script setup lang="ts">
// Settings -> About body (docs/UI.md 9.6): versions, uptime and safe mode from `GET /api/health`, the MIT license
// with the LICENSE and repository links, and "Copy diagnostics" (versions, provider statuses, plugin states and
// errors; never keys or chat content).
import type { Health } from '@harness-forge/shared'
import { ArrowUpRightIcon, ShieldAlertIcon } from '@lucide/vue'
import { computed, onMounted, ref } from 'vue'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import BrandMark from '~/components/common/BrandMark.vue'
import CopyButton from '~/components/common/CopyButton.vue'
import { useSharedNow } from '~/components/common/relative-time'
import { useApi } from '~/composables/useApi'
import { usePluginsStore } from '~/stores/plugins'
import { useProvidersStore } from '~/stores/providers'
import { toHarnessError, withHarnessErrors } from '~/utils/errors'
import { testIds } from '~/utils/testids'
import { diagnosticsText, formatUptime, LICENSE_URL, REPOSITORY_URL, versionRows } from './about'
import SettingsLoadError from './SettingsLoadError.vue'
import SettingsSection from './SettingsSection.vue'

const api = useApi()
const providers = useProvidersStore()
const plugins = usePluginsStore()
const now = useSharedNow()

const health = ref<Health | null>(null)
const fetchedAt = ref(0)
const loading = ref(false)
const error = ref<unknown>(null)

async function load() {
  loading.value = true
  error.value = null
  try {
    health.value = await withHarnessErrors(api.health.get())
    fetchedAt.value = Date.now()
  }
  catch (failure) {
    error.value = failure
  }
  finally {
    loading.value = false
  }
}

onMounted(() => {
  void load()
  // Provider statuses and plugin states for the diagnostics report (best effort).
  if (!providers.loaded)
    providers.fetchAll().catch(() => {})
  if (!plugins.loaded)
    plugins.fetchAll().catch(() => {})
})

const rows = computed(() => (health.value ? versionRows(health.value) : []))
const uptime = computed(() => {
  if (!health.value)
    return ''
  const elapsed = Math.max(0, (now.value - fetchedAt.value) / 1000)
  return formatUptime(health.value.uptimeSec + elapsed)
})

function diagnostics(): string {
  return diagnosticsText({
    health: health.value,
    healthError: error.value ? toHarnessError(error.value).message : null,
    userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
    providers: providers.items,
    plugins: plugins.items,
    generatedAt: Date.now(),
  })
}
</script>

<template>
  <SettingsSection title="Versions">
    <SettingsLoadError
      v-if="error && !health"
      title="Could not reach the server"
      :error="error"
      :pending="loading"
      @retry="load"
    />
    <div v-else class="overflow-hidden rounded-xl border bg-card">
      <div class="flex items-center gap-3 border-b px-4 py-3.5">
        <span class="flex size-9 items-center justify-center rounded-lg bg-muted">
          <BrandMark :size="18" />
        </span>
        <div class="min-w-0 flex-1">
          <p class="font-mono text-sm font-medium tracking-tight">
            harness-forge
          </p>
          <p class="text-xs text-muted-foreground">
            Self-hosted AI chat and agent harness
          </p>
        </div>
        <Badge
          v-if="health?.safeMode"
          variant="outline"
          class="gap-1 border-warning/40 bg-warning/10 text-foreground"
          title="HF_SAFE_MODE=1: only builtin plugins are loaded."
        >
          <ShieldAlertIcon aria-hidden="true" class="text-warning" />
          Safe mode
        </Badge>
      </div>
      <dl v-if="health" class="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2.5 px-4 py-3.5 text-sm sm:grid-cols-[auto_1fr_auto_1fr]">
        <template v-for="row in rows" :key="row.label">
          <dt class="text-muted-foreground">
            {{ row.label }}
          </dt>
          <dd class="min-w-0 truncate font-mono text-[13px] tabular-nums" :data-version="row.label">
            {{ row.value }}
          </dd>
        </template>
        <dt class="text-muted-foreground">
          Uptime
        </dt>
        <dd class="font-mono text-[13px] tabular-nums">
          {{ uptime }}
        </dd>
        <dt class="text-muted-foreground">
          Safe mode
        </dt>
        <dd class="text-[13px]">
          {{ health.safeMode ? 'On (builtin plugins only)' : 'Off' }}
        </dd>
      </dl>
      <div v-else aria-busy="true" aria-label="Loading versions" class="grid grid-cols-2 gap-x-6 gap-y-3 px-4 py-4 sm:grid-cols-4">
        <Skeleton v-for="index in 8" :key="index" class="h-3.5" :class="index % 2 ? 'w-20' : 'w-24'" />
      </div>
    </div>
  </SettingsSection>

  <SettingsSection title="License">
    <p class="text-sm text-muted-foreground">
      harness-forge is open source under the MIT License.
    </p>
    <div class="flex flex-wrap gap-x-5 gap-y-2 text-sm">
      <a
        :href="LICENSE_URL"
        target="_blank"
        rel="noopener noreferrer"
        class="inline-flex items-center gap-0.5 rounded-sm font-medium underline decoration-primary/60 underline-offset-4 outline-none hover:decoration-primary focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        MIT License
        <ArrowUpRightIcon aria-hidden="true" class="size-3.5 text-muted-foreground" />
        <span class="sr-only">(opens in a new tab)</span>
      </a>
      <a
        :href="REPOSITORY_URL"
        target="_blank"
        rel="noopener noreferrer"
        class="inline-flex items-center gap-0.5 rounded-sm font-medium underline decoration-primary/60 underline-offset-4 outline-none hover:decoration-primary focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        Source code
        <ArrowUpRightIcon aria-hidden="true" class="size-3.5 text-muted-foreground" />
        <span class="sr-only">(opens in a new tab)</span>
      </a>
    </div>
  </SettingsSection>

  <SettingsSection
    title="Diagnostics"
    description="Versions, provider statuses and plugin states for a bug report. Never includes keys or chats."
  >
    <div>
      <CopyButton
        :text="diagnostics"
        size="sm"
        label="Copy diagnostics"
        variant="outline"
        :data-testid="testIds.aboutCopyDiagnostics"
        class="h-8 px-3 text-sm text-foreground"
      />
    </div>
  </SettingsSection>
</template>
