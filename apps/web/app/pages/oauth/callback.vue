<script setup lang="ts">
// The end of an MCP sign-in (Phase 14, ADR-059; docs/UI.md 6, 8.14): the authorization server sends the browser here
// (`<origin>/oauth/callback`, the redirect URI of every sign-in). The `auth` layout has no sidebar, so `AppSidebar` (the
// only caller of `rememberRoute`) never stores the `?code=` URL as a last route, and no sidebar store loads. The auth
// middleware still runs: without a session it goes to `/login?redirect=/oauth/callback?…` with the query kept, and the
// page finishes after the login. A thin page around OAuthCallbackView (it reads the query once, removes it, posts it).
// C54 (route frozen from Gate P14-0b); W14.7 owns OAuthCallbackView.
import OAuthCallbackView from '~/components/oauth/OAuthCallbackView.vue'
import { useHead } from '~/components/settings/nuxt-imports'

definePageMeta({ layout: 'auth' })

useHead({ title: 'Signing in · harness-forge' })
</script>

<template>
  <OAuthCallbackView />
</template>
