<script setup lang="ts">
// What a plugin adds (docs/UI.md 8.8), one section per contribution type: providers (icon, status, models, "Configure
// key"), models ("Manage models"), tools (PluginToolsTable), MCP servers (status and Restart; the builtin `core-mcp`
// renders McpServersPanel instead), commands and hooks. Tool, MCP and command details come from the plugins store
// (`GET /api/tools`, `/api/mcp`, `/api/commands`); when one of them cannot be loaded, the names the plugin
// registered are listed without their controls.
// Phase 10 (plugin API 1.4.0): Agents ("Sub-agents the main agent can start.") and Skills ("Instructions the agent loads
// when a task needs them.") follow Commands, each a PluginCustomizationList over the global catalog
// (`customizations.catalog(null)`, the plugin's entries of the kind). The catalog is fetched (at most
// CATALOG_MAX_AGE_MS old) whenever the plugin contributes agents or skills; names without a catalog entry (still
// loading, or the catalog could not be loaded) are name-only rows.
// Phase 11 (plugin API 1.5.0; C39 mounts, W11.8 implements): the Hooks section is PluginHookList (the plugin's command
// hooks from `useHooksStore().list(null)` and its code hooks), shown for code hooks (`contributions.hooks`) or command
// hooks (`contributions.commandHooks`); an Output styles section ("How the agent writes its replies.") follows Skills
// as a PluginCustomizationList of kind `style`.
import type { PluginDetail } from '@harness-forge/shared'
import { ArrowRightIcon, SettingsIcon } from '@lucide/vue'
import { computed, onMounted, ref, watch } from 'vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import ProviderIcon from '~/components/providers/ProviderIcon.vue'
import ProviderStatusBadge from '~/components/providers/ProviderStatusBadge.vue'
import { useCustomizationsStore } from '~/stores/customizations'
import { useHooksStore } from '~/stores/hooks'
import { usePluginsStore } from '~/stores/plugins'
import { useProvidersStore } from '~/stores/providers'
import { countLabel } from '../list/plugin-display'
import PluginCustomizationList from './PluginCustomizationList.vue'
import PluginDetailSection from './PluginDetailSection.vue'
import PluginHookList from './PluginHookList.vue'
import PluginMcpServerList from './PluginMcpServerList.vue'
import PluginToolsTable from './PluginToolsTable.vue'

const props = defineProps<{ plugin: PluginDetail }>()

/** A global catalog younger than this (and not stale) is used as is; a `plugin.changed` event makes it stale. */
const CATALOG_MAX_AGE_MS = 15_000

const plugins = usePluginsStore()
const providers = useProvidersStore()
const customizations = useCustomizationsStore()
const hooks = useHooksStore()

/** A list that failed to load: fall back to the names in `contributions`. */
const failed = ref({ tools: false, mcp: false, commands: false })

const isCoreMcp = computed(() => props.plugin.id === 'core-mcp')
const contributions = computed(() => props.plugin.contributions)

onMounted(() => {
  if (!providers.loaded && contributions.value.providers.length > 0)
    providers.fetchAll().catch(() => {})
  if (!plugins.toolsLoaded) {
    plugins.fetchTools().catch(() => {
      failed.value = { ...failed.value, tools: true }
    })
  }
  if (!plugins.mcpLoaded && !isCoreMcp.value && contributions.value.mcpServers.length > 0) {
    plugins.fetchMcp().catch(() => {
      failed.value = { ...failed.value, mcp: true }
    })
  }
  if (!plugins.commandsLoaded && contributions.value.commands.length > 0) {
    plugins.fetchCommands().catch(() => {
      failed.value = { ...failed.value, commands: true }
    })
  }
})

// ---------- providers and models ----------

const providerRows = computed(() => contributions.value.providers.map(id => ({ id, provider: providers.byId(id) ?? null })))

/** Models the manifest adds to providers of other plugins (`contributes.models`). */
const contributedModels = computed(() => (props.plugin.manifest.contributes?.models ?? [])
  .map(entry => ({ providerId: entry.providerId, count: entry.models.length, name: providers.byId(entry.providerId)?.name ?? entry.providerId })))

const modelTotal = computed(() => {
  if (contributions.value.models > 0)
    return contributions.value.models
  return providerRows.value.reduce((sum, row) => sum + (row.provider?.modelCount ?? 0), 0)
})

function configureRoute(id: string) {
  return { path: '/settings/providers', query: { configure: id } }
}

// ---------- tools, MCP servers, commands ----------

const tools = computed(() => plugins.tools.filter(tool => tool.pluginId === props.plugin.id))
const missingTools = computed(() => (plugins.toolsLoaded && !failed.value.tools ? [] : contributions.value.tools.filter(name => !tools.value.some(tool => tool.name === name))))
const toolCount = computed(() => tools.value.length + missingTools.value.length)

const mcpServers = computed(() => plugins.mcp.filter(server => server.pluginId === props.plugin.id))
const missingMcp = computed(() => (plugins.mcpLoaded && !failed.value.mcp ? [] : contributions.value.mcpServers.filter(id => !mcpServers.value.some(server => server.id === id))))
const mcpCount = computed(() => mcpServers.value.length + missingMcp.value.length)

const commands = computed(() => {
  const known = plugins.commands.filter(command => command.pluginId === props.plugin.id)
  const names = new Set(known.map(command => command.name))
  const fallback = contributions.value.commands.filter(name => !names.has(name)).map(name => ({ name, description: '' }))
  return [...known, ...fallback].sort((a, b) => a.name.localeCompare(b.name))
})

// ---------- agents and skills (Phase 10) ----------

/** The contributed agent and skill names, as one key: a plugin reload that changes them fetches the catalog again. */
const customizationNames = computed(() => [...contributions.value.agents, ...contributions.value.skills, ...contributions.value.outputStyles].join('\n'))

watch(customizationNames, (names) => {
  if (names)
    customizations.fetchCatalog(null, { maxAgeMs: CATALOG_MAX_AGE_MS }).catch(() => {})
}, { immediate: true })

/**
 * The rows of one kind: the plugin's catalog entries of the names it contributes now (a catalog older than a plugin
 * reload may still list a removed one), and the contributed names the catalog does not know yet.
 */
function customizationRows(kind: 'agent' | 'skill' | 'style', names: readonly string[]) {
  const contributed = new Set(names)
  const entries = customizations.entriesOf(null, kind)
    .filter(entry => entry.source === 'plugin' && entry.pluginId === props.plugin.id && contributed.has(entry.name))
  const known = new Set(entries.map(entry => entry.name))
  return { entries, missing: names.filter(name => !known.has(name)) }
}

const agents = computed(() => customizationRows('agent', contributions.value.agents))
const agentCount = computed(() => agents.value.entries.length + agents.value.missing.length)
const skills = computed(() => customizationRows('skill', contributions.value.skills))
const skillCount = computed(() => skills.value.entries.length + skills.value.missing.length)
/** + Phase 11: the plugin's output styles. */
const styles = computed(() => customizationRows('style', contributions.value.outputStyles))
const styleCount = computed(() => styles.value.entries.length + styles.value.missing.length)

// ---------- hooks (Phase 11) ----------

/** The plugin's command hooks, from the global hook listing (W11.8 fetches it). */
const commandHooks = computed(() => (hooks.list(null)?.items ?? [])
  .filter(entry => entry.source === 'plugin' && entry.kind === 'command' && entry.pluginId === props.plugin.id))
const hookCount = computed(() => Math.max(commandHooks.value.length, contributions.value.commandHooks) + contributions.value.hooks.length)

const empty = computed(() => !isCoreMcp.value
  && providerRows.value.length === 0
  && modelTotal.value === 0
  && contributedModels.value.length === 0
  && toolCount.value === 0
  && mcpCount.value === 0
  && commands.value.length === 0
  && agentCount.value === 0
  && skillCount.value === 0
  && styleCount.value === 0
  && hookCount.value === 0)
</script>

<template>
  <div class="flex flex-col gap-8">
    <PluginDetailSection v-if="providerRows.length" title="Providers" :count="providerRows.length">
      <ul role="list" class="divide-y divide-border overflow-hidden rounded-xl border bg-card">
        <li
          v-for="row in providerRows"
          :key="row.id"
          :data-provider-id="row.id"
          class="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5"
        >
          <ProviderIcon :id="row.id" :icon="row.provider?.icon" :name="row.provider?.name ?? row.id" size="md" variant="color" />
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-medium">
              {{ row.provider?.name ?? row.id }}
            </p>
            <p class="truncate text-xs text-muted-foreground">
              <template v-if="row.provider?.local">
                Local — no key
              </template>
              <template v-else-if="row.provider && row.provider.modelCount > 0">
                {{ countLabel(row.provider.modelCount, 'model') }}
              </template>
              <template v-else>
                <span class="font-mono">{{ row.id }}</span>
              </template>
              <template v-if="row.provider && !row.provider.enabled">
                · Turned off
              </template>
            </p>
          </div>
          <ProviderStatusBadge
            v-if="row.provider"
            :status="row.provider.status"
            :http-status="row.provider.lastError?.status"
            :message="row.provider.status === 'error' ? row.provider.lastError?.message : undefined"
          />
          <Button as-child variant="outline" size="sm">
            <NuxtLink :to="configureRoute(row.id)">
              {{ row.provider?.status === 'not_configured' ? 'Add key' : 'Configure key' }}
            </NuxtLink>
          </Button>
        </li>
      </ul>
    </PluginDetailSection>

    <PluginDetailSection v-if="modelTotal > 0 || contributedModels.length" title="Models" :count="modelTotal || null">
      <template #actions>
        <Button as-child variant="ghost" size="sm" class="text-muted-foreground hover:text-foreground">
          <NuxtLink to="/settings/models">
            Manage models
            <ArrowRightIcon aria-hidden="true" data-icon="inline-end" />
          </NuxtLink>
        </Button>
      </template>
      <p class="text-sm text-muted-foreground">
        <template v-if="providerRows.length">
          {{ countLabel(modelTotal, 'model') }} across {{ countLabel(providerRows.length, 'provider') }}. Favorites, visibility and
          custom models are managed in Settings.
        </template>
        <template v-else>
          {{ countLabel(modelTotal, 'model') }} added to other providers.
        </template>
      </p>
      <div v-if="contributedModels.length" class="flex flex-wrap gap-1.5">
        <Badge v-for="entry in contributedModels" :key="entry.providerId" variant="secondary" class="rounded-md px-1.5 font-normal">
          {{ entry.name }} · {{ countLabel(entry.count, 'model') }}
        </Badge>
      </div>
    </PluginDetailSection>

    <PluginDetailSection
      v-if="toolCount > 0"
      title="Tools"
      :count="toolCount"
      description="The approval setting overrides the tool's own policy in every chat."
    >
      <PluginToolsTable :tools="tools" :missing="missingTools" />
    </PluginDetailSection>

    <LazyMcpServersPanel v-if="isCoreMcp" :plugin-id="plugin.id" />
    <PluginDetailSection v-else-if="mcpCount > 0" title="MCP servers" :count="mcpCount" description="The tools of each server become tools of the chat.">
      <PluginMcpServerList :servers="mcpServers" :missing="missingMcp" />
    </PluginDetailSection>

    <PluginDetailSection v-if="commands.length" title="Commands" :count="commands.length" description="Type them in the composer.">
      <ul role="list" class="divide-y divide-border overflow-hidden rounded-xl border bg-card">
        <li v-for="command in commands" :key="command.name" class="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-4 py-2.5">
          <code class="font-mono text-[13px] font-medium">/{{ command.name }}</code>
          <span class="min-w-0 flex-1 text-sm text-muted-foreground">{{ command.description }}</span>
        </li>
      </ul>
    </PluginDetailSection>

    <PluginDetailSection v-if="agentCount > 0" title="Agents" :count="agentCount" description="Sub-agents the main agent can start.">
      <PluginCustomizationList kind="agent" :plugin-id="plugin.id" :entries="agents.entries" :missing="agents.missing" />
    </PluginDetailSection>

    <PluginDetailSection v-if="skillCount > 0" title="Skills" :count="skillCount" description="Instructions the agent loads when a task needs them.">
      <PluginCustomizationList kind="skill" :plugin-id="plugin.id" :entries="skills.entries" :missing="skills.missing" />
    </PluginDetailSection>

    <PluginDetailSection v-if="styleCount > 0" title="Output styles" :count="styleCount" description="How the agent writes its replies.">
      <PluginCustomizationList kind="style" :plugin-id="plugin.id" :entries="styles.entries" :missing="styles.missing" />
    </PluginDetailSection>

    <PluginDetailSection
      v-if="hookCount > 0"
      title="Hooks"
      :count="hookCount"
      description="Hooks can read and change prompts, messages and tool calls."
    >
      <PluginHookList :entries="commandHooks" :code-hooks="contributions.hooks" />
    </PluginDetailSection>

    <div v-if="empty" class="flex items-center gap-3 rounded-xl border border-dashed px-4 py-6 text-sm text-muted-foreground">
      <SettingsIcon aria-hidden="true" class="size-4 shrink-0" />
      <span v-if="!plugin.enabled">This plugin is turned off. Turn it on to register its providers, tools and commands.</span>
      <span v-else-if="plugin.state !== 'active'">Nothing is registered while the plugin is not running.</span>
      <span v-else>This plugin does not add providers, tools, MCP servers or commands.</span>
    </div>
  </div>
</template>
