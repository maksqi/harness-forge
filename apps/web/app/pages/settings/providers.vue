<script setup lang="ts">
// Settings -> Providers (docs/UI.md 2.5, 9.1, 9.2): plain-HTTP warning, provider list and key dialog.
// `?configure=<providerId>` opens that provider's key dialog (the chat "Open settings" action links here).
import { computed } from 'vue'
import InsecureBanner from '~/components/settings/InsecureBanner.vue'
import { useRoute, useRouter } from '~/components/settings/nuxt-imports'
import ProviderList from '~/components/settings/ProviderList.vue'
import SettingsPage from '~/components/settings/SettingsPage.vue'

const route = useRoute()
const router = useRouter()

const configureId = computed(() => {
  const value = route.query.configure
  const id = Array.isArray(value) ? value[0] : value
  return typeof id === 'string' && id ? id : null
})

function onConfigureId(value: string | null) {
  if (value || route.query.configure === undefined)
    return
  const { configure: _configure, ...query } = route.query
  router.replace({ query }).catch(() => {})
}
</script>

<template>
  <SettingsPage title="Providers" description="Bring your own API keys. Keys are encrypted on this server.">
    <div class="flex flex-col gap-4 py-4">
      <InsecureBanner />
      <ProviderList :configure-id="configureId" @update:configure-id="onConfigureId" />
    </div>
  </SettingsPage>
</template>
