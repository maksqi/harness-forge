<script setup lang="ts">
// The sign-in callback page's body (Phase 14, ADR-059; docs/UI.md 2.20, 6, 8.14, 10.10): on mount it reads `code`,
// `state`, `error`, `error_description` and `iss` from the query once (`readCallbackQuery`) and calls `router.replace({
// query: {} })` before anything else, then `useMcpSignIn().complete(…)` (`POST /mcp/oauth/callback` with the session
// cookie): `working` (a `role="status"` spinner "Finishing sign-in…"), `success` (`navigateTo(returnTo ?? fallback, {
// replace: true })` and the toast "Signed in to {server}."), `error` (`oauth-callback-error`, `data-code`, `role="alert"`:
// the provider's or the server's text as plain text, at most 300 characters; a used or expired link reads "This sign-in
// link was already used or expired."; Try again (`oauth-callback-retry`) and Back to MCP servers (`oauth-callback-back`)).
// It never renders the code or the state. Mounted by `pages/oauth/callback.vue` (layout `auth`).
// No props, no emits; the root test id is frozen from Gate P14-0b (C54 stub); W14.7 implements the page in P14-A.
import { Loader2Icon } from '@lucide/vue'
import { testIds } from '~/utils/testids'
</script>

<template>
  <div :data-testid="testIds.oauthCallback" data-state="working" class="flex flex-col items-center gap-4 text-center">
    <h1 class="sr-only">
      Signing in to an MCP server
    </h1>
    <p role="status" class="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2Icon aria-hidden="true" class="size-4 animate-spin motion-reduce:animate-none" />
      Finishing sign-in…
    </p>
  </div>
</template>
