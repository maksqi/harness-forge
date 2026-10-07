<script setup lang="ts">
// The format badge of a plugin (Phase 12, ADR-053; docs/UI.md 8.1, 8.13): "Claude Code" (outline) after the source badge
// of a Claude Code plugin (`format: 'claude'`), with a tooltip; renders nothing for a harness plugin.
import type { PluginFormat } from '@harness-forge/shared'
import { computed } from 'vue'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { pluginFormatLabel } from './plugin-display'

// Attributes (class) go to the badge, not to the renderless tooltip root.
defineOptions({ inheritAttrs: false })

const props = defineProps<{ format: PluginFormat | undefined }>()

const label = computed(() => pluginFormatLabel(props.format))
</script>

<template>
  <Tooltip v-if="label">
    <TooltipTrigger as-child>
      <Badge
        variant="outline"
        tabindex="0"
        data-slot="plugin-format-badge"
        :data-value="format"
        class="relative z-10 rounded-md px-1.5 font-medium text-foreground/85"
        v-bind="$attrs"
      >
        {{ label }}
      </Badge>
    </TooltipTrigger>
    <TooltipContent class="max-w-xs">
      A Claude Code plugin: its files keep Claude Code's layout, and its commands, agents and skills carry its id as a
      prefix.
    </TooltipContent>
  </Tooltip>
</template>
