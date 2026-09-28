<script setup lang="ts">
// Trust warning (docs/UI.md 8.4, docs/PLUGINS.md 13 "Trust warning"): a destructive Alert with the exact warning text,
// then what the user is about to trust: the source (installed plugins), the declared permissions, the hosts and the
// programs the plugin declares, and the sha256 that trust pins. Exactly one of the props is passed: the install
// dialog passes the inspection (its preview shows the source), installed plugins pass their PluginDetail
// (sha256 = trust.hash, permissions = manifest.permissions, source = sourceRef).
import type { PluginDetail, PluginInspection } from '@harness-forge/shared'
import { ShieldAlertIcon } from '@lucide/vue'
import { computed } from 'vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import CopyButton from '~/components/common/CopyButton.vue'
import { testIds } from '~/utils/testids'
import { manifestHosts, permissionLabel, pluginSourceLabel, stdioCommands, TRUST_WARNING_TEXT } from './install'

const props = defineProps<{
  inspection?: PluginInspection
  plugin?: PluginDetail
}>()

const manifest = computed(() => props.inspection?.manifest ?? props.plugin?.manifest ?? null)
const sha256 = computed(() => props.inspection?.sha256 ?? props.plugin?.trust.hash ?? null)
const permissions = computed(() => props.inspection?.permissions ?? props.plugin?.manifest.permissions ?? [])
const commands = computed(() => (manifest.value ? stdioCommands(manifest.value) : []))
const hosts = computed(() => props.inspection?.networkHosts ?? (manifest.value ? manifestHosts(manifest.value) : []))
const source = computed(() => (props.plugin ? pluginSourceLabel(props.plugin) : null))
</script>

<template>
  <Alert
    variant="destructive"
    :data-testid="testIds.trustWarning"
    class="border-destructive/35 bg-destructive/5 dark:bg-destructive/10 *:data-[slot=alert-description]:text-foreground/85"
  >
    <ShieldAlertIcon />
    <AlertTitle>Review before you trust this plugin</AlertTitle>
    <AlertDescription class="grid gap-3">
      <p class="text-destructive">
        {{ TRUST_WARNING_TEXT }}
      </p>
      <div v-if="source" class="grid gap-1">
        <span class="text-xs font-medium text-muted-foreground">Source</span>
        <span class="text-xs break-all text-foreground" data-slot="trust-source">{{ source }}</span>
      </div>
      <div v-if="permissions.length" class="grid gap-1.5">
        <span class="text-xs font-medium text-muted-foreground">Declared permissions</span>
        <ul class="flex flex-wrap gap-1.5" aria-label="Declared permissions">
          <li
            v-for="permission in permissions"
            :key="permission"
            :data-value="permission"
            class="rounded-md border bg-background/60 px-1.5 py-0.5 text-xs text-foreground"
          >
            {{ permissionLabel(permission) }}
          </li>
        </ul>
      </div>
      <div v-if="hosts.length" class="grid gap-1.5">
        <span class="text-xs font-medium text-muted-foreground">Talks to</span>
        <ul class="flex flex-wrap gap-1.5" aria-label="Hosts">
          <li v-for="host in hosts" :key="host" class="rounded-md bg-background/60 px-1.5 py-0.5 font-mono text-xs break-all text-foreground">
            {{ host }}
          </li>
        </ul>
      </div>
      <div v-if="commands.length" class="grid gap-1.5">
        <span class="text-xs font-medium text-muted-foreground">Starts these programs</span>
        <ul class="grid gap-1">
          <li v-for="command in commands" :key="command" class="font-mono text-xs break-all text-foreground">
            {{ command }}
          </li>
        </ul>
      </div>
      <div v-if="sha256" class="grid gap-1">
        <span class="text-xs font-medium text-muted-foreground">SHA-256 pin</span>
        <div class="flex min-w-0 items-center gap-1">
          <code class="min-w-0 font-mono text-xs break-all text-foreground" data-slot="trust-sha256">{{ sha256 }}</code>
          <CopyButton :text="sha256" label="Copy SHA-256" />
        </div>
      </div>
    </AlertDescription>
  </Alert>
</template>
