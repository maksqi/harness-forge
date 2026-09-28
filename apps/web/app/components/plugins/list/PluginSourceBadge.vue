<script setup lang="ts">
// Source badge of a plugin (docs/UI.md 8.1): Core · Declarative · Code · zip · npm · URL · Local, with the full
// origin ("Installed from npm (name@1.2.0)") as a tooltip.
import type { PluginSummary } from '@harness-forge/shared'
import { computed } from 'vue'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { pluginSourceDescription, pluginSourceLabel } from './plugin-display'

// Attributes (class, data-testid) go to the badge, not to the renderless tooltip root.
defineOptions({ inheritAttrs: false })

const props = defineProps<{ plugin: Pick<PluginSummary, 'source' | 'kind' | 'sourceRef'> }>()

const label = computed(() => pluginSourceLabel(props.plugin))
const description = computed(() => pluginSourceDescription(props.plugin))
</script>

<template>
  <Tooltip>
    <TooltipTrigger as-child>
      <Badge
        variant="secondary"
        data-slot="plugin-source-badge"
        :data-value="plugin.source"
        :class="cn('rounded-md px-1.5 font-medium text-secondary-foreground/85', plugin.source === 'builtin' && 'text-secondary-foreground')"
        v-bind="$attrs"
      >
        {{ label }}
      </Badge>
    </TooltipTrigger>
    <TooltipContent class="max-w-xs">
      {{ description }}
    </TooltipContent>
  </Tooltip>
</template>
