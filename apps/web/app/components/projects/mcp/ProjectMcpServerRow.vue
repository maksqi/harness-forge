<script setup lang="ts">
// One server of a project's `.mcp.json` (Phase 11, ADR-050; docs/UI.md 2.18, 7.33, 10.8, 14): the row's toggle (the
// status dot with its sr-only status word, `ServerCog` and the name; `aria-expanded`, it shows the server's tools in
// mono), the transport badge and the status text (`mcpStatusText`), the exact command or URL (from `trust`, the trust
// item with the server's sha256; `${VAR}` references as written, never a value), "Replaces your server {id} in this
// project's chats." when it shadows a global server, Reconnect (`project-mcp-reconnect`, `reconnect`; connected, error
// and idle servers) and Review… while pending (`project-mcp-review`, `review`). Store-free. Props, emits and the root
// test id are frozen from Gate P11-0b (C39); W11.9.
import type { ProjectMcpServer, TrustItem } from '@harness-forge/shared'
import { ChevronRightIcon, RotateCwIcon, ServerCogIcon, ShieldQuestionMarkIcon } from '@lucide/vue'
import { computed, useId } from 'vue'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { statusDotClasses } from '~/components/common/status'
import McpTransportBadge from '~/components/plugins/mcp/McpTransportBadge.vue'
import { testIds } from '~/utils/testids'
import { canReconnect, mcpServerCommand, mcpStatusDot, mcpStatusText } from '../trust/project-trust'

const props = defineProps<{ server: ProjectMcpServer, trust: TrustItem | null, expanded: boolean, busy: boolean }>()

const emit = defineEmits<{ toggle: [], reconnect: [], review: [] }>()

const toolsId = useId()

const status = computed(() => mcpStatusText(props.server))
const dot = computed(() => mcpStatusDot(props.server))
const command = computed(() => mcpServerCommand(props.trust))
const reconnectable = computed(() => canReconnect(props.server))
</script>

<template>
  <div
    :data-testid="testIds.projectMcpServer"
    :data-server-id="server.id"
    :data-state="server.state"
    :data-transport="server.transport"
    :aria-busy="busy ? 'true' : undefined"
    class="grid min-w-0 gap-1.5 py-3 text-sm"
  >
    <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <button
        type="button"
        data-action="toggle"
        :aria-expanded="expanded ? 'true' : 'false'"
        :aria-controls="expanded ? toolsId : undefined"
        class="-ml-1.5 flex min-h-8 min-w-0 items-center gap-1.5 rounded-md px-1.5 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:min-h-10"
        @click="emit('toggle')"
      >
        <ChevronRightIcon aria-hidden="true" :class="cn('size-3.5 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90')" />
        <span class="relative inline-flex size-4 shrink-0 items-center justify-center" data-slot="status-dot" :data-status="dot.status">
          <span aria-hidden="true" :class="cn('size-2 rounded-full', statusDotClasses[dot.status])" />
          <span class="sr-only">{{ dot.label }}</span>
        </span>
        <ServerCogIcon aria-hidden="true" class="size-4 shrink-0 text-muted-foreground" />
        <span class="min-w-0 truncate font-medium">{{ server.name }}</span>
      </button>
      <McpTransportBadge :type="server.transport" />
      <span
        data-slot="project-mcp-status"
        :class="cn('min-w-0 break-words text-xs', server.state === 'error' ? 'text-destructive' : 'text-muted-foreground')"
      >{{ status }}</span>
      <Button
        v-if="server.state === 'pending'"
        type="button"
        variant="outline"
        size="xs"
        :disabled="busy"
        :aria-label="`Review ${server.name}…`"
        :data-testid="testIds.projectMcpReview"
        class="ml-auto pointer-coarse:h-10 pointer-coarse:px-3"
        @click="emit('review')"
      >
        <ShieldQuestionMarkIcon aria-hidden="true" data-icon="inline-start" />
        Review…
      </Button>
      <Button
        v-else-if="reconnectable"
        type="button"
        variant="outline"
        size="xs"
        :disabled="busy"
        :aria-label="`Reconnect ${server.name}`"
        :data-testid="testIds.projectMcpReconnect"
        class="ml-auto pointer-coarse:h-10 pointer-coarse:px-3"
        @click="emit('reconnect')"
      >
        <RotateCwIcon aria-hidden="true" data-icon="inline-start" :class="cn(busy && 'animate-spin motion-reduce:animate-none')" />
        Reconnect
      </Button>
    </div>

    <p v-if="command" data-slot="project-mcp-command" class="min-w-0 pl-6 font-mono text-xs break-all text-foreground/90">
      {{ command }}
    </p>
    <p v-if="server.shadows" data-slot="project-mcp-shadows" class="pl-6 text-xs text-muted-foreground">
      Replaces your server {{ server.shadows }} in this project's chats.
    </p>

    <div v-if="expanded" :id="toolsId" class="pl-6" data-slot="project-mcp-tools">
      <ul v-if="server.tools.length > 0" :aria-label="`Tools of ${server.name}`" class="flex flex-wrap gap-1.5">
        <li v-for="tool in server.tools" :key="tool" class="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
          {{ tool }}
        </li>
      </ul>
      <p v-else class="text-xs text-muted-foreground">
        No tools yet.
      </p>
    </div>
  </div>
</template>
