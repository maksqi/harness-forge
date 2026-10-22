<script setup lang="ts">
// The OAuth settings of a personal http / sse MCP server (Phase 14, ADR-059; docs/UI.md 2.20, 8.14, 10.10): a collapsible
// section "Sign-in (OAuth) · optional" in McpServerDialog's HTTP and SSE tabs (open when a value is set): Client ID,
// a write-only Client secret (like McpSecretRows: an empty password input, "•••• · stored" when one is stored, Remove),
// Scopes, and the read-only Redirect URI with Copy (`redirectUri`, built by the dialog in script: vue-tsc #6240). With an
// `Authorization` header (`disabled`) the fields are disabled ("Servers with an Authorization header don't sign in.").
// Props, emits and the root test id are frozen from Gate P14-0b (C54 stub); W14.7 implements the fields in P14-A.
import type { SecretState } from '@harness-forge/shared'
import type { McpOAuthDraft } from './mcp-form'
import { computed } from 'vue'
import { testIds } from '~/utils/testids'

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

defineEmits<{
  'update:modelValue': [value: McpOAuthDraft]
}>()

/** Open when a value is set. */
const open = computed(() => props.modelValue.clientId.trim() !== '' || props.modelValue.scopes.trim() !== '' || props.secretState?.set === true)
</script>

<template>
  <section
    :data-testid="testIds.mcpOauthSection"
    :data-state="open ? 'open' : 'closed'"
    :aria-disabled="disabled ? 'true' : undefined"
    class="grid gap-2"
  >
    <h4 class="text-sm font-medium">
      Sign-in (OAuth) · optional
    </h4>
  </section>
</template>
