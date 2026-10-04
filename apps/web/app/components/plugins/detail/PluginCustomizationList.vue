<script setup lang="ts">
// The agents or skills of a plugin on its detail page (docs/UI.md 8.8, 10.7; ADR-045, plugin API 1.4.0).
// PluginContributions renders one per kind with `customizations.catalog(null)` filtered by the plugin. One row per entry
// (`plugin-customization`, `data-name`, `data-state` active | shadowed), sorted by name: the mono name, a "Shadowed"
// badge (its tooltip names the winner: "Not used: your personal agent wins.") and the description; agents add a meta
// line with the model ("Default model", "Same as the chat" for `inherit`, else the model id) and the tools ("All
// tools" / "{n} tools"). Contributed names without a catalog entry (the catalog is loading or could not be loaded)
// are name-only rows. The footer link "Open in Customize" opens Settings -> Customize on the kind's tab.
// Props and the root test id (`plugin-customizations`, `data-kind`, `data-count`) are frozen from Gate P10-0b (C33).
import type { CustomizationEntry } from '@harness-forge/shared'
import { ArrowRightIcon, EyeOffIcon } from '@lucide/vue'
import { computed } from 'vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { usePluginsStore } from '~/stores/plugins'
import { testIds } from '~/utils/testids'
import { customizationMeta, customizeRoute, shadowedNote } from '../list/plugin-display'

const props = defineProps<{
  kind: 'agent' | 'skill'
  pluginId: string
  /** `customizations.catalog(null)` filtered by the plugin and the kind. */
  entries: readonly CustomizationEntry[]
  /** Contributed names without an entry (name-only rows). */
  missing: readonly string[]
}>()

interface Row {
  name: string
  description: string
  state: 'active' | 'shadowed'
  /** The tooltip of the Shadowed badge. */
  shadow: string | null
  meta: string[]
}

const plugins = usePluginsStore()

function pluginName(id: string): string {
  return plugins.byId(id)?.name ?? id
}

const rows = computed<Row[]>(() => {
  const known = new Set(props.entries.map(entry => entry.name))
  return [
    ...props.entries.map((entry): Row => {
      const shadow = shadowedNote(entry, pluginName)
      return {
        name: entry.name,
        description: entry.description,
        state: shadow ? 'shadowed' : 'active',
        shadow,
        meta: customizationMeta(entry),
      }
    }),
    ...props.missing
      .filter(name => !known.has(name))
      .map((name): Row => ({ name, description: '', state: 'active', shadow: null, meta: [] })),
  ].sort((a, b) => a.name.localeCompare(b.name))
})

const route = computed(() => customizeRoute(props.kind))
</script>

<template>
  <div
    :data-testid="testIds.pluginCustomizations"
    :data-kind="kind"
    :data-count="rows.length"
    class="flex flex-col gap-2"
  >
    <ul role="list" class="divide-y divide-border overflow-hidden rounded-xl border bg-card">
      <li
        v-for="row in rows"
        :key="row.name"
        :data-testid="testIds.pluginCustomization"
        :data-name="row.name"
        :data-state="row.state"
        class="flex min-w-0 flex-col gap-1 px-4 py-2.5"
      >
        <div class="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-1">
          <span class="flex min-w-0 items-center gap-2">
            <code class="font-mono text-[13px] font-medium break-all">{{ row.name }}</code>
            <Tooltip v-if="row.shadow">
              <TooltipTrigger as-child>
                <Badge
                  variant="outline"
                  tabindex="0"
                  data-slot="plugin-customization-shadowed"
                  :aria-description="row.shadow"
                  class="gap-1 text-muted-foreground"
                >
                  <EyeOffIcon aria-hidden="true" />
                  Shadowed
                </Badge>
              </TooltipTrigger>
              <TooltipContent>{{ row.shadow }}</TooltipContent>
            </Tooltip>
          </span>
          <span v-if="row.description" class="min-w-0 flex-1 text-sm break-words text-muted-foreground">{{ row.description }}</span>
        </div>
        <p v-if="row.meta.length" data-slot="plugin-customization-meta" class="text-xs text-muted-foreground">
          {{ row.meta.join(' · ') }}
        </p>
      </li>
    </ul>
    <Button
      as-child
      variant="ghost"
      size="sm"
      class="self-start text-muted-foreground hover:text-foreground pointer-coarse:h-10"
    >
      <NuxtLink :to="route" data-slot="plugin-customizations-open">
        Open in Customize
        <ArrowRightIcon aria-hidden="true" data-icon="inline-end" />
      </NuxtLink>
    </Button>
  </div>
</template>
