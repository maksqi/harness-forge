<script setup lang="ts">
// Transport of an MCP server as a small outline badge: "stdio", "HTTP" or "SSE" (docs/UI.md 8.12).
import type { McpTransportType } from './mcp-form'
import { computed } from 'vue'
import { Badge } from '@/components/ui/badge'
import { transportLabel } from './mcp-form'

const props = defineProps<{ type: McpTransportType }>()

const label = computed(() => transportLabel(props.type))
</script>

<template>
  <Badge
    variant="outline"
    data-slot="mcp-transport-badge"
    :data-value="type"
    class="font-mono text-[11px] font-normal text-muted-foreground"
  >
    {{ label }}
  </Badge>
</template>
