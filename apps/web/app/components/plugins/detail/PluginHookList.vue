<script setup lang="ts">
// The hooks of a plugin on its detail page (Phase 11, ADR-048, plugin API 1.5.0; docs/UI.md 8.8, 10.8): the command
// hooks (`contributes.hooks`, from `useHooksStore().list(null)`: one row per handler, `plugin-hook` `data-kind="command"`,
// with the event, the matcher or "All tools" and the command in mono, under the note "Runs only while you trust this
// plugin."), then the code hooks (`ctx.hooks.on`, their HookMap events as chips, `data-kind="code"`), and the footer link
// "Open in Customize" to the Hooks tab. PluginContributions renders it with the plugin's command entries and
// `contributions.hooks`. Props and the root test id are frozen from Gate P11-0b (C39 stub); implementation W11.8.
import type { HookEntry } from '@harness-forge/shared'
import { ArrowRightIcon, WebhookIcon } from '@lucide/vue'
import { computed } from 'vue'
import { Button } from '@/components/ui/button'
import { hookMatcherText, sortHookEntries } from '~/components/settings/customize/hooks'
import { testIds } from '~/utils/testids'
import { customizeRoute } from '../list/plugin-display'

const props = defineProps<{
  /** The plugin's command hooks (`GET /hooks` entries of the plugin). */
  entries: readonly HookEntry[]
  /** The plugin's code hook names (HookMap keys). */
  codeHooks: readonly string[]
}>()

const commandRows = computed(() => sortHookEntries(props.entries.filter(entry => entry.kind === 'command'))
  .map(entry => ({ key: entry.key, event: entry.event, matcher: hookMatcherText(entry), command: entry.kind === 'command' ? entry.command : '' })))
const codeNames = computed(() => [...new Set(props.codeHooks)].sort())
const count = computed(() => commandRows.value.length + codeNames.value.length)
const route = customizeRoute('hook')
</script>

<template>
  <div :data-testid="testIds.pluginHooks" :data-count="count" class="flex flex-col gap-3">
    <template v-if="commandRows.length > 0">
      <p class="text-sm text-muted-foreground" data-slot="plugin-hooks-trust-note">
        Runs only while you trust this plugin.
      </p>
      <ul role="list" class="divide-y divide-border overflow-hidden rounded-xl border bg-card">
        <li
          v-for="row in commandRows"
          :key="row.key"
          :data-testid="testIds.pluginHook"
          :data-event="row.event"
          data-kind="command"
          class="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5"
        >
          <span class="flex shrink-0 items-center gap-2 text-sm font-medium">
            <WebhookIcon aria-hidden="true" class="size-4 self-center text-muted-foreground" />
            {{ row.event }}
          </span>
          <span v-if="row.matcher" class="font-mono text-xs break-all text-muted-foreground">{{ row.matcher }}</span>
          <code class="min-w-0 flex-1 basis-48 font-mono text-xs break-all text-foreground/85">{{ row.command }}</code>
        </li>
      </ul>
    </template>
    <ul v-if="codeNames.length > 0" role="list" aria-label="Code hooks" class="flex flex-wrap gap-1.5">
      <li
        v-for="name in codeNames"
        :key="name"
        :data-testid="testIds.pluginHook"
        :data-event="name"
        data-kind="code"
        class="rounded-md border bg-secondary px-1.5 py-0.5 font-mono text-xs text-secondary-foreground"
      >
        {{ name }}
      </li>
    </ul>
    <Button
      as-child
      variant="ghost"
      size="sm"
      class="self-start text-muted-foreground hover:text-foreground pointer-coarse:h-10"
    >
      <NuxtLink :to="route" data-slot="plugin-hooks-open">
        Open in Customize
        <ArrowRightIcon aria-hidden="true" data-icon="inline-end" />
      </NuxtLink>
    </Button>
  </div>
</template>
