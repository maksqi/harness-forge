<script setup lang="ts">
// The Sign in / Sign out controls of one MCP server row outside the MCP panel (Phase 14, ADR-059; docs/UI.md 8.8, 8.14,
// 10.10 "PluginDetailView MCP rows"): a plugin's declared servers (including Claude Code plugin servers) sign in like
// personal ones. Rendered inside a `flex flex-wrap` row (PluginMcpServerList; W14.7 CCR: the row mounts it after its
// status text): **Sign in** (`mcp-sign-in`, `data-server-id`, "Signing in…" while the start runs) for a `needs-auth`
// server that can sign in (`canSignIn`), **Sign out…** (`mcp-sign-out`, ghost) for a signed-in one → ConfirmDialog "Sign
// out of {name}?" ("harness-forge forgets the tokens; the server stays configured."), both through `useMcpSignIn`; a
// failure shows on its own line under the row (`mcp-sign-in-error`, `data-code`, `data-server-id`). Plugin servers have
// no OAuth fields (the plugin declares its client). Renders nothing for servers without a sign-in.
import type { McpServer } from '@harness-forge/shared'
import type { HarnessErrorUiAction, HarnessErrorView } from '~/components/common/harness-error'
import { LogInIcon, LogOutIcon } from '@lucide/vue'
import { computed, ref } from 'vue'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import ConfirmDialog from '~/components/common/ConfirmDialog.vue'
import HarnessErrorAlert from '~/components/common/HarnessErrorAlert.vue'
import { mcpSignInKey, useMcpSignIn } from '~/composables/useMcpSignIn'
import { testIds } from '~/utils/testids'
import { canSignIn, signInErrorView } from './mcp-form'

const props = defineProps<{ server: McpServer }>()

const signIn = useMcpSignIn()

const failure = ref<{ action: 'in' | 'out', error: HarnessErrorView } | null>(null)
const confirmOpen = ref(false)
const signingOut = ref(false)

const target = computed(() => ({ kind: 'global' as const, serverId: props.server.id }))
const offersSignIn = computed(() => canSignIn(props.server))
const offersSignOut = computed(() => !offersSignIn.value && props.server.auth?.signedIn === true)
const signingIn = computed(() => signIn.busyKey.value === mcpSignInKey(target.value))

async function start(): Promise<void> {
  if (signingIn.value)
    return
  failure.value = null
  try {
    await signIn.start(target.value, { name: props.server.name })
  }
  catch (error) {
    failure.value = { action: 'in', error: signInErrorView(error) }
  }
}

async function confirmSignOut(): Promise<void> {
  if (signingOut.value)
    return
  signingOut.value = true
  failure.value = null
  try {
    await signIn.signOut(target.value, props.server.name)
  }
  catch (error) {
    failure.value = { action: 'out', error: signInErrorView(error) }
  }
  finally {
    signingOut.value = false
    confirmOpen.value = false
  }
}

function onAction(action: HarnessErrorUiAction): void {
  if (action !== 'retry')
    return
  if (failure.value?.action === 'out')
    confirmOpen.value = true
  else
    void start()
}
</script>

<template>
  <div class="contents" data-slot="mcp-sign-in-actions">
    <Button
      v-if="offersSignIn"
      type="button"
      variant="outline"
      size="sm"
      :disabled="signingIn"
      :aria-busy="signingIn || undefined"
      :aria-label="`Sign in to ${server.name}`"
      :data-testid="testIds.mcpSignIn"
      :data-server-id="server.id"
      class="pointer-coarse:h-10"
      @click="start"
    >
      <Spinner v-if="signingIn" data-icon="inline-start" />
      <LogInIcon v-else aria-hidden="true" data-icon="inline-start" />
      {{ signingIn ? 'Signing in…' : 'Sign in' }}
    </Button>
    <Button
      v-else-if="offersSignOut"
      type="button"
      variant="ghost"
      size="sm"
      :aria-label="`Sign out of ${server.name}`"
      :data-testid="testIds.mcpSignOut"
      :data-server-id="server.id"
      class="pointer-coarse:h-10"
      @click="confirmOpen = true"
    >
      <LogOutIcon aria-hidden="true" data-icon="inline-start" />
      Sign out…
    </Button>
    <HarnessErrorAlert
      v-if="failure"
      compact
      :error="failure.error"
      :provider-name="server.name"
      :data-testid="testIds.mcpSignInError"
      :data-server-id="server.id"
      class="order-last basis-full"
      @action="onAction"
    />
    <ConfirmDialog
      :open="confirmOpen"
      :title="`Sign out of ${server.name}?`"
      description="harness-forge forgets the tokens; the server stays configured."
      confirm-label="Sign out"
      :destructive="false"
      :pending="signingOut"
      data-action="mcp-sign-out-confirm"
      @update:open="value => (confirmOpen = value)"
      @confirm="confirmSignOut"
    />
  </div>
</template>
