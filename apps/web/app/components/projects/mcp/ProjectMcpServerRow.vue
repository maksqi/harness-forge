<script setup lang="ts">
// One server of a project's `.mcp.json` (Phase 11, ADR-050; docs/UI.md 7.33, 10.8): a status dot, `ServerCog`, the name,
// the transport badge and the status text (`mcpStatusText`), the exact command or URL (from `trust`, the trust item with
// the server's sha256), "Replaces your server {id} in this project's chats." when it shadows a global server, Reconnect
// (`project-mcp-reconnect`, `reconnect`), Review… while pending (`project-mcp-review`, `review`) and the tools behind
// the row's toggle (`toggle`). Store-free. Props, emits and the root test id are frozen from Gate P11-0b (C39 stub);
// W11.9 implements the row in P11-A. The stub shows the name and the status.
import type { ProjectMcpServer, TrustItem } from '@harness-forge/shared'
import { computed } from 'vue'
import { testIds } from '~/utils/testids'
import { mcpStatusText } from '../trust/project-trust'

const props = defineProps<{ server: ProjectMcpServer, trust: TrustItem | null, expanded: boolean, busy: boolean }>()

defineEmits<{ toggle: [], reconnect: [], review: [] }>()

const status = computed(() => mcpStatusText(props.server))
</script>

<template>
  <div
    :data-testid="testIds.projectMcpServer"
    :data-server-id="server.id"
    :data-state="server.state"
    :data-transport="server.transport"
    :aria-busy="busy ? 'true' : undefined"
    class="flex min-w-0 items-baseline gap-2 py-2 text-sm"
  >
    <span class="min-w-0 truncate font-medium">{{ server.name }}</span>
    <span class="ml-auto shrink-0 text-xs text-muted-foreground">{{ status }}</span>
  </div>
</template>
