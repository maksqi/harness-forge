<script setup lang="ts">
// The OAuth settings of a personal http / sse MCP server (Phase 14, ADR-059; docs/UI.md 2.20, 8.14, 10.10): a collapsible
// section "Sign-in (OAuth) · optional" in McpServerDialog's HTTP and SSE tabs (open when a value is set): Client ID,
// a write-only Client secret (like McpSecretRows: an empty password input, "•••• · stored" when one is stored, Remove),
// Scopes, and the read-only Redirect URI with Copy (`redirectUri`, built by the dialog in script: vue-tsc #6240). With an
// `Authorization` header (`disabled`) the fields are disabled ("Servers with an Authorization header don't sign in.").
// Props, emits and the root test id are frozen from Gate P14-0b (C54 stub); W14.7 implements the fields in P14-A.
// The secret is never read back: the input starts empty, and only what the user types travels in the draft. The dialog
// shows "Saving signs you out of {name}." under its footer (`signedIn` marks the section with `data-signed-in`).
import type { SecretState } from '@harness-forge/shared'
import type { McpOAuthDraft } from './mcp-form'
import { MCP_OAUTH_CLIENT_ID_MAX_CHARS, MCP_OAUTH_CLIENT_SECRET_MAX_CHARS, MCP_OAUTH_SCOPES_MAX_CHARS } from '@harness-forge/shared'
import { ChevronRightIcon } from '@lucide/vue'
import { computed, ref, useId } from 'vue'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import CopyButton from '~/components/common/CopyButton.vue'
import { testIds } from '~/utils/testids'
import { AUTHORIZATION_HEADER_NOTE } from './mcp-form'

const props = withDefaults(defineProps<{
  modelValue: McpOAuthDraft
  /** The stored client secret (null for a new server). */
  secretState: SecretState | null
  /** `redirectUriFor(window.location.origin)`, built by the dialog in script. */
  redirectUri: string
  /** An Authorization header row is set (the note replaces the help). */
  disabled?: boolean
  /** Shows "Saving signs you out of {name}." when the URL, the type or the client ID change. */
  signedIn?: boolean
}>(), {
  disabled: false,
  signedIn: false,
})

const emit = defineEmits<{
  'update:modelValue': [value: McpOAuthDraft]
}>()

const ids = { clientId: useId(), secret: useId(), scopes: useId(), help: useId() }

/** A value is set (or a secret is stored): the section starts open. */
const hasValue = computed(() => props.modelValue.clientId.trim() !== '' || props.modelValue.scopes.trim() !== '' || props.secretState?.set === true)
/** The user's own toggle; null = follow `hasValue`. */
const userOpen = ref<boolean | null>(null)
const open = computed(() => userOpen.value ?? hasValue.value)

const stored = computed(() => props.secretState?.set === true)
/** The secret needs a client ID (a confidential client is always pre-registered). */
const secretEnabled = computed(() => !props.disabled && props.modelValue.clientId.trim() !== '')
const secretPlaceholder = computed(() => {
  if (!stored.value || props.modelValue.removeSecret)
    return ''
  return props.secretState?.hint ? `${props.secretState.hint} · stored` : '•••• · stored'
})

function update(patch: Partial<McpOAuthDraft>): void {
  emit('update:modelValue', { ...props.modelValue, ...patch })
}

function toggleRemove(): void {
  update({ removeSecret: !props.modelValue.removeSecret, clientSecret: '' })
}

function onOpenChange(value: boolean): void {
  userOpen.value = value
}
</script>

<template>
  <Collapsible
    :open="open"
    :data-testid="testIds.mcpOauthSection"
    :data-state="open ? 'open' : 'closed'"
    :data-signed-in="signedIn ? 'true' : undefined"
    :aria-disabled="disabled ? 'true' : undefined"
    class="grid gap-2 rounded-lg border px-3 py-2"
    @update:open="onOpenChange"
  >
    <CollapsibleTrigger
      type="button"
      class="-mx-1.5 flex min-h-8 items-center gap-1.5 justify-self-start rounded-md px-1.5 text-sm font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:min-h-10"
    >
      <ChevronRightIcon aria-hidden="true" :class="cn('size-3.5 text-muted-foreground transition-transform motion-reduce:transition-none', open && 'rotate-90')" />
      Sign-in (OAuth) · optional
    </CollapsibleTrigger>

    <CollapsibleContent class="grid gap-3 pb-1">
      <p :id="ids.help" data-slot="mcp-oauth-help" class="text-xs text-muted-foreground">
        {{ disabled ? AUTHORIZATION_HEADER_NOTE : 'Leave empty to register harness-forge with the server when you sign in.' }}
      </p>

      <div class="grid gap-1.5 sm:grid-cols-[8rem_minmax(0,1fr)] sm:items-center sm:gap-x-3">
        <Label :for="ids.clientId">Client ID</Label>
        <Input
          :id="ids.clientId"
          :model-value="modelValue.clientId"
          :disabled="disabled"
          :maxlength="MCP_OAUTH_CLIENT_ID_MAX_CHARS"
          :aria-describedby="ids.help"
          :data-testid="testIds.mcpOauthClientId"
          data-field="oauth-client-id"
          placeholder="Registered automatically"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          class="font-mono text-[13px] placeholder:font-sans placeholder:text-sm pointer-coarse:h-10"
          @update:model-value="value => update({ clientId: String(value) })"
        />
      </div>

      <div class="grid gap-1.5 sm:grid-cols-[8rem_minmax(0,1fr)] sm:items-center sm:gap-x-3">
        <Label :for="ids.secret">Client secret</Label>
        <div class="flex min-w-0 items-center gap-2">
          <Input
            :id="ids.secret"
            :model-value="modelValue.clientSecret"
            type="password"
            :disabled="!secretEnabled"
            :maxlength="MCP_OAUTH_CLIENT_SECRET_MAX_CHARS"
            :placeholder="secretPlaceholder"
            :data-testid="testIds.mcpOauthClientSecret"
            :data-stored="stored ? 'true' : 'false'"
            data-field="oauth-client-secret"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            data-1p-ignore
            data-lpignore="true"
            class="min-w-0 flex-1 font-mono text-[13px] placeholder:font-sans placeholder:text-sm pointer-coarse:h-10"
            @update:model-value="value => update({ clientSecret: String(value) })"
          />
          <Button
            v-if="stored"
            type="button"
            variant="ghost"
            size="sm"
            :disabled="disabled"
            :aria-pressed="modelValue.removeSecret ? 'true' : 'false'"
            aria-label="Remove the stored client secret"
            data-action="remove-secret"
            class="shrink-0 pointer-coarse:h-10"
            @click="toggleRemove"
          >
            Remove
          </Button>
        </div>
      </div>

      <div class="grid gap-1.5 sm:grid-cols-[8rem_minmax(0,1fr)] sm:items-center sm:gap-x-3">
        <Label :for="ids.scopes">Scopes</Label>
        <Input
          :id="ids.scopes"
          :model-value="modelValue.scopes"
          :disabled="disabled"
          :maxlength="MCP_OAUTH_SCOPES_MAX_CHARS"
          :data-testid="testIds.mcpOauthScopes"
          data-field="oauth-scopes"
          placeholder="Server default"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          class="font-mono text-[13px] placeholder:font-sans placeholder:text-sm pointer-coarse:h-10"
          @update:model-value="value => update({ scopes: String(value) })"
        />
      </div>

      <div class="grid gap-1.5 sm:grid-cols-[8rem_minmax(0,1fr)] sm:items-start sm:gap-x-3">
        <span class="text-sm font-medium sm:pt-1">Redirect URI</span>
        <div class="grid min-w-0 gap-1">
          <div class="flex min-w-0 items-center gap-1">
            <code
              :data-testid="testIds.mcpOauthRedirectUri"
              class="min-w-0 rounded bg-muted px-1.5 py-1 font-mono text-xs break-all"
            >{{ redirectUri }}</code>
            <CopyButton :text="redirectUri" label="Copy redirect URI" class="shrink-0" />
          </div>
          <p class="text-xs text-muted-foreground">
            Register this exact address with the authorization server when you use your own client ID.
          </p>
        </div>
      </div>
    </CollapsibleContent>
  </Collapsible>
</template>
