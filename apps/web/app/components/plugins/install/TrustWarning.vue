<script setup lang="ts">
// Trust warning (docs/UI.md 8.4, docs/PLUGINS.md 13 "Trust warning"): a destructive Alert (red border, title and icon;
// the text stays foreground for contrast, docs/UI.md 14.3) with the exact warning text,
// then what the user is about to trust: the source (installed plugins), the declared permissions, the hosts and the
// programs the plugin declares, and the sha256 that trust pins. Exactly one of the props is passed: the install
// dialog passes the inspection (its preview shows the source), installed plugins pass their PluginDetail
// (sha256 = trust.hash, permissions = manifest.permissions, source = sourceRef).
// Phase 11 (plugin API 1.5.0, W11.8): "Runs these commands" lists every command hook and every `!` span of a command
// template (`runCommands`), each in mono with where it comes from ("PreToolUse hook", "/deploy").
// Phase 12 (ADR-053, docs/UI.md 8.13; W12.9): a Claude Code plugin (`claude` of the inspection or the detail) lists its
// `claude.executables` instead (every command hook handler, stdio MCP server and `!` span: "PostToolUse hook", "MCP server
// {name}", "/{plugin}:{command}"), its `claude.hosts`, and the note that its whole file tree is pinned.
import type { PluginDetail, PluginInspection } from '@harness-forge/shared'
import { ShieldAlertIcon } from '@lucide/vue'
import { computed } from 'vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import CopyButton from '~/components/common/CopyButton.vue'
import { testIds } from '~/utils/testids'
import {
  CLAUDE_TREE_PIN_NOTE,
  manifestHosts,
  permissionLabel,
  pluginSourceLabel,
  runCommands,
  stdioCommands,
  TRUST_WARNING_TEXT,
} from './install'

const props = defineProps<{
  inspection?: PluginInspection
  plugin?: PluginDetail
}>()

const manifest = computed(() => props.inspection?.manifest ?? props.plugin?.manifest ?? null)
/** + Phase 12: the Claude Code plugin info (null for a harness plugin). */
const claude = computed(() => (props.inspection ? props.inspection.claude : props.plugin?.claude) ?? null)
const sha256 = computed(() => props.inspection?.sha256 ?? props.plugin?.trust.hash ?? null)
const permissions = computed(() => props.inspection?.permissions ?? props.plugin?.manifest.permissions ?? [])
/** Stdio MCP servers of a harness manifest (a Claude Code plugin lists its servers with its executables). */
const commands = computed(() => (manifest.value && !claude.value ? stdioCommands(manifest.value) : []))
/** + Phase 11: the shell commands of command hooks and `!` spans; + Phase 12: the executables of a Claude Code plugin. */
const shellCommands = computed(() => (manifest.value ? runCommands(manifest.value, claude.value) : []))
const hosts = computed(() => {
  const declared = props.inspection?.networkHosts ?? (manifest.value ? manifestHosts(manifest.value) : [])
  return [...new Set([...declared, ...(claude.value?.hosts ?? [])])].sort()
})
const source = computed(() => (props.plugin ? pluginSourceLabel(props.plugin) : null))
</script>

<template>
  <Alert
    variant="destructive"
    :data-testid="testIds.trustWarning"
    class="border-destructive/35 bg-destructive/5 dark:bg-destructive/10 *:data-[slot=alert-description]:text-foreground/85"
  >
    <ShieldAlertIcon />
    <AlertTitle class="text-[color-mix(in_oklch,var(--destructive)_80%,var(--foreground))]">
      Review before you trust this plugin
    </AlertTitle>
    <AlertDescription class="grid gap-3">
      <p class="text-foreground">
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
      <div v-if="shellCommands.length" class="grid gap-1.5" data-slot="trust-run-commands">
        <span class="text-xs font-medium text-muted-foreground">Runs these commands</span>
        <ul class="grid gap-1.5">
          <li v-for="(item, index) in shellCommands" :key="index" class="grid gap-0.5">
            <span class="text-xs text-muted-foreground">{{ item.source }}</span>
            <code class="font-mono text-xs break-all whitespace-pre-wrap text-foreground">{{ item.command }}</code>
          </li>
        </ul>
      </div>
      <p v-if="claude && claude.executables.length > 0" class="text-xs text-foreground" data-slot="trust-tree-note">
        {{ CLAUDE_TREE_PIN_NOTE }}
      </p>
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
