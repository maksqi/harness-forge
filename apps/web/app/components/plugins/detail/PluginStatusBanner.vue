<script setup lang="ts">
// State banner under the plugin header (docs/UI.md 8.7): untrusted -> the trust warning (TrustWarning, W3.2) with
// "Review and trust"; error -> the last error with "View logs" and "Reload"; incompatible -> the plugin API range it
// needs. Nothing for active, loading or disabled plugins.
import type { PluginDetail } from '@harness-forge/shared'
import { PLUGIN_API_VERSION } from '@harness-forge/plugin-sdk'
import { CircleAlertIcon, RotateCwIcon, ShieldCheckIcon, TriangleAlertIcon } from '@lucide/vue'
import { computed } from 'vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'

const props = withDefaults(defineProps<{ plugin: PluginDetail, reloading?: boolean }>(), { reloading: false })

const emit = defineEmits<{
  review: []
  viewLogs: []
  reload: []
}>()

const errorMessage = computed(() => props.plugin.lastError?.message || 'The plugin stopped with an error.')
const apiRange = computed(() => props.plugin.manifest.engines?.harness ?? null)
</script>

<template>
  <div v-if="plugin.state === 'untrusted'" data-slot="plugin-status-banner" data-state="untrusted" class="flex flex-col gap-3">
    <TrustWarning :plugin="plugin" />
    <div class="flex flex-wrap items-center gap-3 rounded-lg border border-dashed px-4 py-3">
      <p class="min-w-0 flex-1 text-sm text-muted-foreground">
        Its code does not run until you trust it. Review what it can do first.
      </p>
      <Button type="button" size="sm" @click="emit('review')">
        <ShieldCheckIcon aria-hidden="true" data-icon="inline-start" />
        Review and trust
      </Button>
    </div>
  </div>

  <Alert
    v-else-if="plugin.state === 'error'"
    data-slot="plugin-status-banner"
    data-state="error"
    class="border-destructive/35 bg-destructive/5 dark:bg-destructive/10"
  >
    <CircleAlertIcon aria-hidden="true" class="text-destructive" />
    <AlertTitle>The plugin stopped with an error</AlertTitle>
    <AlertDescription class="break-words text-foreground/80">
      {{ errorMessage }}
    </AlertDescription>
    <div class="col-start-2 mt-2 flex flex-wrap gap-2">
      <Button type="button" size="sm" variant="outline" @click="emit('viewLogs')">
        View logs
      </Button>
      <Button type="button" size="sm" variant="outline" :disabled="reloading || !plugin.enabled" @click="emit('reload')">
        <Spinner v-if="reloading" data-icon="inline-start" />
        <RotateCwIcon v-else aria-hidden="true" data-icon="inline-start" />
        Reload
      </Button>
    </div>
  </Alert>

  <Alert
    v-else-if="plugin.state === 'incompatible'"
    data-slot="plugin-status-banner"
    data-state="incompatible"
    class="border-warning/40 bg-warning/5 dark:bg-warning/10"
  >
    <TriangleAlertIcon aria-hidden="true" class="text-warning" />
    <AlertTitle>Not compatible with this harness-forge</AlertTitle>
    <AlertDescription class="text-foreground/80">
      <p>
        <template v-if="apiRange">
          It needs plugin API <code class="font-mono text-[13px]">{{ apiRange }}</code>; this server provides
          <code class="font-mono text-[13px]">{{ PLUGIN_API_VERSION }}</code>.
        </template>
        <template v-else>
          It was built for a different plugin API than <code class="font-mono text-[13px]">{{ PLUGIN_API_VERSION }}</code>.
        </template>
        Install an updated version of the plugin.
      </p>
    </AlertDescription>
  </Alert>
</template>
