<script setup lang="ts">
// "Runs code" badge (docs/UI.md 8.1): outline in the warning hue with a Cpu icon, for code plugins and plugins
// that start a local MCP server. Text stays foreground-colored in light mode for contrast (docs/UI.md 14.3).
import { CpuIcon } from '@lucide/vue'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

defineOptions({ inheritAttrs: false })
</script>

<template>
  <Tooltip>
    <TooltipTrigger as-child>
      <Badge
        variant="outline"
        data-slot="plugin-runs-code"
        class="rounded-md border-warning/50 px-1.5 font-medium text-foreground dark:text-warning"
        v-bind="$attrs"
      >
        <CpuIcon aria-hidden="true" data-icon="inline-start" class="text-warning" />
        Runs code
      </Badge>
    </TooltipTrigger>
    <TooltipContent class="max-w-xs">
      Runs on your server with harness-forge's permissions.
    </TooltipContent>
  </Tooltip>
</template>
