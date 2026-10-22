<script setup lang="ts">
// One server of a project's `.mcp.json` (Phase 11, ADR-050; docs/UI.md 2.18, 7.33, 10.8, 14): the row's toggle (the
// status dot with its sr-only status word, `ServerCog` and the name; `aria-expanded`, it shows the server's tools in
// mono), the transport badge and the status text (`mcpStatusText`), the exact command or URL (from `trust`, the trust
// item with the server's sha256; `${VAR}` references as written, never a value), "Replaces your server {id} in this
// project's chats." when it shadows a global server, Reconnect (`project-mcp-reconnect`, `reconnect`; connected, error
// and idle servers) and Review… while pending (`project-mcp-review`, `review`). Store-free. Props, emits and the root
// test id are frozen from Gate P11-0b (C39); W11.9.
// Phase 14 (ADR-059; C54 declares, W14.7 implements; frozen from Gate P14-0b): + emits `signIn` / `signOut`: a
// `needs-auth` remote server shows **Sign in** (`project-mcp-sign-in`, named "Sign in to {name}"; "Signing in…" while
// `busy`: a `needs-auth` row has no Reconnect, so its busy state is the sign-in), a signed-in one reads "Connected · {n}
// tools · Signed in" (tooltip "Signed in · expires {time}" / "Signed in · token renews automatically") with **Sign out…**
// (`project-mcp-sign-out`, ghost, named "Sign out of {name}"; the dialog confirms); pending rows keep Review… and never
// show Sign in. A `needs-auth` server whose `.mcp.json` entry sends an `Authorization` header (its trust item's header
// names) cannot sign in: it reads "The server rejected its Authorization header." (`data-slot="project-mcp-auth-header"`;
// Edit .mcp.json… is in the dialog's footer). The `.mcp.json` `oauth` values (`data-slot="project-mcp-oauth"`) need a
// contract member first (W14.7 CCR: neither `ProjectMcpServer` nor the trust item carries them).
import type { ProjectMcpServer, TrustItem } from '@harness-forge/shared'
import { ChevronRightIcon, LogInIcon, LogOutIcon, RotateCwIcon, ServerCogIcon, ShieldQuestionMarkIcon } from '@lucide/vue'
import { computed, useId } from 'vue'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { statusDotClasses } from '~/components/common/status'
import { AUTHORIZATION_REJECTED_TEXT, signedInTooltip } from '~/components/plugins/mcp/mcp-form'
import McpTransportBadge from '~/components/plugins/mcp/McpTransportBadge.vue'
import { testIds } from '~/utils/testids'
import { canReconnect, mcpServerCommand, mcpStatusDot, mcpStatusText } from '../trust/project-trust'

const props = defineProps<{ server: ProjectMcpServer, trust: TrustItem | null, expanded: boolean, busy: boolean }>()

const emit = defineEmits<{ toggle: [], reconnect: [], review: [], signIn: [], signOut: [] }>()

const toolsId = useId()

/** + Phase 14: " · Signed in" after a connected server's tools while it holds OAuth tokens. */
const status = computed(() => {
  const text = mcpStatusText(props.server)
  return props.server.state === 'connected' && props.server.auth?.signedIn === true ? `${text} · Signed in` : text
})
/** + Phase 14: how long a signed-in server's token lasts (the status line's tooltip). */
const statusTitle = computed(() => (props.server.state === 'connected' ? signedInTooltip(props.server.auth) ?? undefined : undefined))
const dot = computed(() => mcpStatusDot(props.server))
const command = computed(() => mcpServerCommand(props.trust))
const reconnectable = computed(() => canReconnect(props.server))
/** + Phase 14: the `.mcp.json` entry sends its own `Authorization` header (the server refuses to sign it in: 400). */
const sendsAuthorization = computed(() => props.trust?.kind === 'mcp' && props.trust.detail.headerNames.some(name => name.toLowerCase() === 'authorization'))
/** + Phase 14: an approved remote server asks for a sign-in. */
const canSignIn = computed(() => props.server.state === 'needs-auth' && props.server.transport !== 'stdio' && !sendsAuthorization.value)
/** + Phase 14: a `needs-auth` server whose own Authorization header was refused. */
const headerRejected = computed(() => props.server.state === 'needs-auth' && sendsAuthorization.value)
/** + Phase 14: an approved server holds OAuth tokens. */
const signedIn = computed(() => props.server.state !== 'pending' && props.server.auth?.signedIn === true)
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
        :title="statusTitle"
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
        v-if="canSignIn"
        type="button"
        variant="outline"
        size="xs"
        :disabled="busy"
        :aria-busy="busy || undefined"
        :aria-label="`Sign in to ${server.name}`"
        :data-testid="testIds.projectMcpSignIn"
        class="ml-auto pointer-coarse:h-10 pointer-coarse:px-3"
        @click="emit('signIn')"
      >
        <Spinner v-if="busy" data-icon="inline-start" />
        <LogInIcon v-else aria-hidden="true" data-icon="inline-start" />
        {{ busy ? 'Signing in…' : 'Sign in' }}
      </Button>
      <Button
        v-if="signedIn"
        type="button"
        variant="ghost"
        size="xs"
        :disabled="busy"
        :aria-label="`Sign out of ${server.name}`"
        :data-testid="testIds.projectMcpSignOut"
        :class="cn('pointer-coarse:h-10 pointer-coarse:px-3', !canSignIn && 'ml-auto')"
        @click="emit('signOut')"
      >
        <LogOutIcon aria-hidden="true" data-icon="inline-start" />
        Sign out…
      </Button>
      <Button
        v-if="reconnectable"
        type="button"
        variant="outline"
        size="xs"
        :disabled="busy"
        :aria-label="`Reconnect ${server.name}`"
        :data-testid="testIds.projectMcpReconnect"
        :class="cn('pointer-coarse:h-10 pointer-coarse:px-3', !signedIn && 'ml-auto')"
        @click="emit('reconnect')"
      >
        <RotateCwIcon aria-hidden="true" data-icon="inline-start" :class="cn(busy && 'animate-spin motion-reduce:animate-none')" />
        Reconnect
      </Button>
    </div>

    <p v-if="command" data-slot="project-mcp-command" class="min-w-0 pl-6 font-mono text-xs break-all text-foreground/90">
      {{ command }}
    </p>
    <p v-if="headerRejected" data-slot="project-mcp-auth-header" class="pl-6 text-xs text-muted-foreground">
      {{ AUTHORIZATION_REJECTED_TEXT }}
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
