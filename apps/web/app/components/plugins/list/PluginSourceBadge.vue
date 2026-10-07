<script setup lang="ts">
// Source badge of a plugin (docs/UI.md 8.1): Core · Declarative · Code · zip · npm · URL · Local, with the full
// origin ("Installed from npm (name@1.2.0)") as a tooltip. Phase 12 (ADR-054): GitHub, and a marketplace plugin shows its
// marketplace's name (the detail's `origin`, else its `sourceRef`; "Marketplace" when unknown).
import type { PluginSourceSubject } from './plugin-display'
import { computed } from 'vue'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { pluginSourceDescription, pluginSourceLabel } from './plugin-display'

// Attributes (class, data-testid) go to the badge, not to the renderless tooltip root.
defineOptions({ inheritAttrs: false })

const props = defineProps<{ plugin: PluginSourceSubject & { sourceRef: string | null } }>()

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
