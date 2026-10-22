<script setup lang="ts">
// MCP servers a plugin declares (docs/UI.md 8.8): status dot, name, transport badge, status text ("Connected · 12
// tools", "Error: …") and Restart (`POST /api/mcp/:id/reconnect`, waits up to 10 s). Servers the MCP API does not
// know yet are listed by id without controls. The builtin `core-mcp` shows McpServersPanel instead.
// Phase 14 (ADR-059; W14.7, CCR approved at P14-A): plugin and Claude Code plugin servers sign in like personal ones
// (docs/UI.md 8.8, 8.14): each row mounts McpSignInActions (Sign in for a `needs-auth` server that can sign in, Sign out…
// behind the confirmation for a signed-in one, the inline error); a signed-in row reads "Connected · {n} tools · Signed
// in" with the token tooltip, and a `needs-auth` server with an `Authorization` header names the refused header.
import type { McpServer } from '@harness-forge/shared'
import { RotateCwIcon } from '@lucide/vue'
import { computed, ref } from 'vue'
import { toast } from 'vue-sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { errorTitle } from '~/components/common/harness-error'
import StatusDot from '~/components/common/StatusDot.vue'
import { AUTHORIZATION_REJECTED_TEXT, rejectsAuthorizationHeader, signedInTooltip } from '~/components/plugins/mcp/mcp-form'
import McpSignInActions from '~/components/plugins/mcp/McpSignInActions.vue'
import { usePluginsStore } from '~/stores/plugins'
import { toHarnessError } from '~/utils/errors'
import { testIds } from '~/utils/testids'
import { MCP_TRANSPORT_LABELS, mcpStatusDot, mcpStatusText } from './plugin-detail'

const props = withDefaults(defineProps<{
  servers: readonly McpServer[]
  /** Declared server ids the MCP API did not return. */
  missing?: readonly string[]
}>(), {
  missing: () => [],
})

const plugins = usePluginsStore()
const restarting = ref<Record<string, boolean>>({})

const rows = computed(() => [
  ...props.servers.map(server => ({ id: server.id, server })),
  ...props.missing.map(id => ({ id, server: null as McpServer | null })),
])

/** + Phase 14: the status line, with " · Signed in" while a connected server holds OAuth tokens. */
function statusText(server: McpServer): string {
  if (rejectsAuthorizationHeader(server))
    return AUTHORIZATION_REJECTED_TEXT
  const text = mcpStatusText(server)
  return server.status === 'connected' && server.auth?.signedIn === true ? `${text} · Signed in` : text
}

/** + Phase 14: the status line's tooltip: how long a signed-in server's token lasts, else the line itself. */
function statusTitle(server: McpServer): string {
  return (server.status === 'connected' ? signedInTooltip(server.auth) : null) ?? statusText(server)
}

async function restart(server: McpServer) {
  restarting.value = { ...restarting.value, [server.id]: true }
  try {
    const next = await plugins.reconnectMcp(server.id)
    if (next.status === 'connected')
      toast.success(`Reconnected ${next.name}`)
    else if (next.status === 'error')
      toast.error(`${next.name} did not connect`, { description: next.error?.message })
  }
  catch (error) {
    const failure = toHarnessError(error)
    toast.error(errorTitle(failure), { description: failure.message })
  }
  finally {
    const { [server.id]: _done, ...rest } = restarting.value
    restarting.value = rest
  }
}
</script>

<template>
  <ul role="list" aria-label="MCP servers" class="divide-y divide-border overflow-hidden rounded-xl border bg-card">
    <li
      v-for="row in rows"
      :key="row.id"
      :data-testid="testIds.mcpServerRow"
      :data-server-id="row.id"
      class="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3"
    >
      <StatusDot
        v-if="row.server"
        :status="mcpStatusDot(row.server.status)"
        :data-testid="testIds.mcpStatus"
        :data-status="row.server.status"
        class="-ml-1"
      />
      <div class="min-w-0 flex-1">
        <div class="flex min-w-0 items-center gap-2">
          <span class="truncate text-sm font-medium">{{ row.server?.name ?? row.id }}</span>
          <Badge v-if="row.server" variant="outline" class="shrink-0 rounded-md px-1.5 font-mono text-[11px] text-muted-foreground">
            {{ MCP_TRANSPORT_LABELS[row.server.transport.type] }}
          </Badge>
        </div>
        <p
          :class="cn('mt-0.5 truncate text-xs text-muted-foreground', row.server?.status === 'error' && 'text-foreground/80')"
          :title="row.server ? statusTitle(row.server) : undefined"
        >
          {{ row.server ? statusText(row.server) : 'Status is not available yet.' }}
        </p>
      </div>
      <McpSignInActions v-if="row.server" :server="row.server" />
      <Button
        v-if="row.server"
        type="button"
        variant="outline"
        size="sm"
        :disabled="row.server.status === 'disabled' || restarting[row.id]"
        :aria-busy="restarting[row.id] || undefined"
        :data-testid="testIds.mcpRestart"
        @click="restart(row.server)"
      >
        <RotateCwIcon aria-hidden="true" data-icon="inline-start" :class="cn(restarting[row.id] && 'animate-spin')" />
        Restart
      </Button>
    </li>
  </ul>
</template>
